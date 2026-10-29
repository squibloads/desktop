// electron is not required at the top: the tests run under plain Node and inject
// Notification. The lazy require below only runs in the real app.
class NotificationManager {
  constructor(settings, { Notification } = {}) {
    this.settings = settings;
    this._Notification = Notification;
    this.controller = null;
    this.retryDelay = 1000;
    this.running = false;
  }

  start() {
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  async _connect() {
    if (!this.running) return;

    this.controller = new AbortController();
    try {
      const resp = await fetch(
        `${this.settings.serverUrl}/v1/api/events/global`,
        {
          headers: { Accept: "text/event-stream" },
          signal: this.controller.signal,
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

    // Reconnect with exponential backoff
    if (this.running) {
      setTimeout(() => this._connect(), this.retryDelay);
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
