const { sessionFetch } = require("./session-fetch.js");

// electron is not required at the top: the tests run under plain Node and inject
// Notification and fetch. The lazy require below only runs in the real app.
class NotificationManager {
  constructor(settings, { Notification, fetch = sessionFetch } = {}) {
    this.settings = settings;
    this._Notification = Notification;
    this._fetch = fetch;
    this.controller = null;
    this.retryTimer = null;
    this.retryDelay = 1000;
    this.running = false;
    // Bumped by stop(). A loop started under an older value does nothing: stop()
    // has already aborted its connection, and it writes no shared state.
    this.generation = 0;
  }

  start() {
    // One loop at a time: stop() cancels a pending retry and aborts an open
    // stream, so a second start() cannot leave the first loop connected. A new
    // start is a fresh connection, so it also drops the backoff the old loop
    // built up; otherwise a corrected URL waits out the old delay.
    this.stop();
    this.retryDelay = 1000;
    this.running = true;
    this._connect(this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  async _connect(generation) {
    if (!this.running || generation !== this.generation) return;

    const controller = new AbortController();
    this.controller = controller;
    try {
      const resp = await this._fetch(
        `${this.settings.serverUrl}/v1/api/events/global`,
        {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
          // A redirect is not followed: the stream must come from the configured server, not wherever it points.
          redirect: "manual",
        },
      );
      // A stale answer must not touch the backoff the live loop is using.
      if (generation !== this.generation) return;

      if (!resp.ok || !resp.body) {
        // Nothing reads a non-OK answer. Each retry replaces the controller that stop() aborts, so the body
        // is cancelled first, and the retry is scheduled only once that has finished.
        try {
          await resp.body?.cancel();
        } catch {
          // A body that will not cancel still leaves the answer as a failure.
        }
        throw new Error(`HTTP ${resp.status}`);
      }

      this.retryDelay = 1000;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // An event can span network chunks, so its fields last for the whole
      // connection and reset only when a blank line ends the event.
      let eventType = "";
      let eventDataParts = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // An event read before stop() ran must not notify once the user has moved on.
        if (generation !== this.generation) return;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            eventDataParts.push(line.slice(6));
          } else if (line === "") {
            const eventData = eventDataParts.join("\n");
            if (eventType && eventData) {
              this._handleEvent(eventType, eventData);
            }
            eventType = "";
            eventDataParts = [];
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") return;
    }

    // Reconnect with exponential backoff, unless stop() or a newer start() has run.
    if (this.running && generation === this.generation) {
      this.retryTimer = setTimeout(() => this._connect(generation), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    }
  }

  _handleEvent(type, dataStr) {
    if (type !== "ws_state" && type !== "cluster_state") return;

    try {
      const data = JSON.parse(dataStr);
      const state = data.state;
      const name = data.name || data.ws_id || "Workstream";

      if (state === "attention") {
        this._notify("Attention Needed", `${name} requires your input`);
      } else if (state === "error") {
        this._notify("Error", `${name} encountered an error`);
      }
    } catch {
      // Ignore malformed events
    }
  }

  _notify(title, body) {
    const Notification = this._Notification ?? require("electron").Notification;
    if (!Notification.isSupported()) return;
    new Notification({ title: `Turnstone: ${title}`, body }).show();
  }
}

// The one manager the app runs. It exists only while the mode has a server, so a
// switch into a mode without one leaves nothing connected, and a restart always
// reaches the manager that is running.
function createNotificationLifecycle(create) {
  let current = null;

  function stop() {
    if (current) current.stop();
    current = null;
  }

  return {
    // Replaces whatever runs with a manager for these settings, or with nothing
    // when the mode has no server. The old manager is stopped first, so no stale
    // one is left to restart.
    apply(settings) {
      stop();
      if (settings.hasServer) {
        current = create(settings);
        current.start();
      }
    },
    // A URL change in the same mode. The manager reads the settings again when it
    // connects, so stopping and starting it is enough.
    restart() {
      if (current) {
        current.stop();
        current.start();
      }
    },
    stop,
  };
}

module.exports = { NotificationManager, createNotificationLifecycle };
