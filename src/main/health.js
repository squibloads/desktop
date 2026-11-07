const { sessionFetch, isRefusedRedirect } = require("./session-fetch.js");

class HealthPoller {
  // The tests pass their own fetch; the app uses the session's network stack. It is bound as fetchImpl because
  // tests/contract/main-process-fetch.test.js refuses the bare name fetch in the main process.
  constructor(settings, onUpdate, { fetch: fetchImpl = sessionFetch } = {}) {
    this.settings = settings;
    this.onUpdate = onUpdate;
    this._fetch = fetchImpl;
    this.status = { server: "unknown", console: "unknown" };
    this.interval = null;
    // Bumped by stop() and pause(). A poll begun under an older value reports nothing: its checks were aborted, and an
    // answer from before a sleep says nothing about the network after it.
    this.generation = 0;
    // One controller per poll in flight, so stop() and pause() can abort them all and close their connections.
    this._inFlight = new Set();
    // True between pause() and resume(), so a resume never restarts a poller the app stopped on purpose.
    this.paused = false;
  }

  start() {
    this.stop();
    this.poll();
    this.interval = setInterval(() => this.poll(), 5000);
  }

  stop() {
    this.paused = false;
    this._halt();
  }

  /**
   * For a sleep: the checks stop and the one in flight is aborted, but the last status stands, so the health dots
   * and the views do not read the sleep as an outage. Only a running poller pauses.
   */
  pause() {
    if (this.interval === null) return;
    this._halt();
    this.paused = true;
  }

  /** For a wake: checks at once instead of waiting out the interval, then polls as before. */
  resume() {
    if (!this.paused) return;
    this.start();
  }

  _halt() {
    this.generation += 1;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const controller of this._inFlight) controller.abort();
    this._inFlight.clear();
  }

  async poll() {
    const generation = this.generation;
    const controller = new AbortController();
    this._inFlight.add(controller);
    const prev = { server: this.status.server, console: this.status.console };

    let serverStatus;
    let consoleStatus;
    try {
      [serverStatus, consoleStatus] = await Promise.all([
        this._statusOf(this.settings.serverRefused, this.settings.hasServer, this.settings.serverUrl, controller.signal),
        this._statusOf(this.settings.consoleRefused, this.settings.hasConsole, this.settings.consoleUrl, controller.signal),
      ]);
    } finally {
      this._inFlight.delete(controller);
    }
    if (generation !== this.generation) return;

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
  _statusOf(refused, enabled, url, pollSignal) {
    if (refused) return Promise.resolve("refused");
    return enabled ? this._checkHealth(url, pollSignal) : Promise.resolve("disabled");
  }

  async _checkHealth(baseUrl, pollSignal) {
    // Aborting the request is what closes its connection. Electron's fetch keeps the connection open when only
    // the body is cancelled.
    const controller = new AbortController();
    try {
      const resp = await this._fetch(`${baseUrl}/health`, {
        signal: AbortSignal.any([controller.signal, pollSignal, AbortSignal.timeout(3000)]),
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
