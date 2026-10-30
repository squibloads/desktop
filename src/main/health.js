const { sessionFetch, isRefusedRedirect } = require("./session-fetch.js");

class HealthPoller {
  // The tests pass their own fetch; the app uses the session's network stack.
  constructor(settings, onUpdate, { fetch = sessionFetch } = {}) {
    this.settings = settings;
    this.onUpdate = onUpdate;
    this._fetch = fetch;
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
    // Aborting the request is what closes its connection. Electron's fetch keeps the connection open when only
    // the body is cancelled.
    const controller = new AbortController();
    try {
      const resp = await this._fetch(`${baseUrl}/health`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        // A redirect is not followed: a server answers /health itself, and a redirect would send the check elsewhere.
        redirect: "manual",
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.status === "ok" ? "ok" : "degraded";
      }
      // A non-OK answer, a redirect included, is never read, so its request is aborted before the answer is
      // reported.
      controller.abort();
      return "error";
    } catch (err) {
      // A redirect is an answer from the server, so a refused one reads as an error, as the redirect response
      // did when it came back. Any other failure reads as disconnected: no connection, a refused certificate, a
      // timeout, or an OK answer whose body is not JSON, such as a sign-in page served in its place.
      return isRefusedRedirect(err) ? "error" : "disconnected";
    }
  }
}

module.exports = { HealthPoller };
