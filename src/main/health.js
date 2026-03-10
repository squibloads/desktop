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
      this.settings.hasServer
        ? this._checkHealth(this.settings.serverUrl)
        : Promise.resolve("disabled"),
      this.settings.hasConsole
        ? this._checkHealth(this.settings.consoleUrl)
        : Promise.resolve("disabled"),
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
