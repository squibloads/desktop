class HealthPoller {
  constructor(settings, onUpdate) {
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.status = { server: "unknown", console: "unknown" };
    this.interval = null;
  }

  start() {
    this.poll();
    this.interval = setInterval(() => this.poll(), 5000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async poll() {
    const prev = { server: this.status.server, console: this.status.console };

    const [serverStatus, consoleStatus] = await Promise.all([
      this._statusOf(this.settings.serverRefused, this.settings.hasServer, this.settings.serverUrl),
      this._statusOf(this.settings.consoleRefused, this.settings.hasConsole, this.settings.consoleUrl),
    ]);

    this.status.server = serverStatus;
    this.status.console = consoleStatus;

    if (
      prev.server !== this.status.server ||
      prev.console !== this.status.console
    ) {
      this.onUpdate(this.status, prev);
    }
  }

  /**
   * A refused address is a fault the user must see, so it is reported as refused and never
   * polled. A switched-off service is not checked at all.
   */
  _statusOf(refused, enabled, url) {
    if (refused) return Promise.resolve("refused");
    return enabled ? this._checkHealth(url) : Promise.resolve("disabled");
  }

  async _checkHealth(baseUrl) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.status === "ok" ? "ok" : "degraded";
      }
      return "error";
    } catch {
      return "disconnected";
    }
  }
}

module.exports = { HealthPoller };
