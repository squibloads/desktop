// electron is not required at the top: the tests run under plain Node and inject
// Notification. The lazy require below only runs in the real app.
class NotificationManager {
  constructor(settings, { Notification } = {}) {
    this.settings = settings;
    this._Notification = Notification;
    this.controller = null;
    this.retryTimer = null;
    this.retryDelay = 1000;
    this.running = false;
    // Bumped by stop(). A loop started under an older value exits rather than
    // reading or reconnecting, so nothing it set up outlives the stop.
    this.generation = 0;
  }

  start() {
    // One loop at a time: stop() cancels a pending retry and aborts an open
    // stream, so a second start() cannot leave the first loop connected.
    this.stop();
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

  async _connect(generation = this.generation) {
    if (!this.running || generation !== this.generation) return;

    const controller = new AbortController();
    this.controller = controller;
    try {
      const resp = await fetch(
        `${this.settings.serverUrl}/v1/api/events/global`,
        {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        },
      );

      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`);
      }

      this.retryDelay = 1000;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // An event read before stop() ran must not notify once the user has moved on.
        if (generation !== this.generation) return;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        let eventDataParts = [];

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

module.exports = { NotificationManager };
