const { signedInFetch, isRefusedRedirect } = require("./session-fetch.js");

// How often the app asks the server for the workstreams. README.md states it, and
// tests/contract/documented-defaults.test.js keeps the two equal.
const POLL_INTERVAL_MS = 10000;
// A request with no answer by then is given up, so a server that stops answering cannot stall the poll.
const REQUEST_TIMEOUT_MS = 5000;

// What a non-OK answer says about notifications. 401 is the server asking for a sign-in. Any other refusal of
// the request lasts until something changes, while a server error or a rate limit passes.
function refusalStatus(code) {
  if (code === 401) return "signed-out";
  if (code >= 400 && code < 500 && code !== 429) return "refused";
  return "waiting";
}

// The server's global event stream needs a service token, which the server gives no signed-in user, so the app
// cannot use it. Instead it asks, as the user signed in to the Server view, for the workstreams that user may
// see, and notifies when one of the user's own comes into a state that needs them. The status it reports says
// whether that works: "on", "signed-out", "refused" or "waiting", and null once stopped.
//
// electron is not required at the top: the tests run under plain Node and inject
// Notification and fetch. The lazy require below only runs in the real app. fetch is
// bound as fetchImpl because tests/contract/main-process-fetch.test.js refuses the
// bare name fetch in the main process.
class NotificationManager {
  constructor(settings, { Notification, fetch: fetchImpl = signedInFetch, onStatus = () => {} } = {}) {
    this.settings = settings;
    this._Notification = Notification;
    this._fetch = fetchImpl;
    this._onStatus = onStatus;
    this.controller = null;
    this.timer = null;
    this.running = false;
    // Bumped by stop(). A poll started under an older value does nothing: stop()
    // has already aborted its requests, and it writes no shared state.
    this.generation = 0;
    this.status = null;
    // The signed-in user's workstreams at the last answer, as ws_id to state, and whose they are. null until an
    // answer arrives, so the first one only records where things stand.
    this.known = null;
    this.userId = null;
  }

  start() {
    // One loop at a time: stop() cancels the next poll and aborts the one in flight, so a second start() cannot
    // leave the first loop running.
    this.stop();
    this.running = true;
    this._poll(this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this._forget();
    this._report(null);
  }

  async _poll(generation) {
    if (!this.running || generation !== this.generation) return;

    const controller = new AbortController();
    this.controller = controller;
    let answer;
    try {
      answer = await this._ask(controller);
    } catch {
      // No connection, no answer in time, or an OK answer that is not JSON. The next poll asks again.
      answer = { status: "waiting" };
    }
    // stop() has run since this poll began, and the loop it started owns the shared state.
    if (generation !== this.generation) return;

    // Armed first, so a notification that fails to show cannot end the loop.
    this.timer = setTimeout(() => this._poll(generation), POLL_INTERVAL_MS);
    try {
      if (answer.status === "on") this._compare(answer.userId, answer.workstreams);
      else if (answer.status !== "waiting") this._forget();
      this._report(answer.status);
    } catch (err) {
      console.error("notifications:", err);
    }
  }

  // One poll: who is signed in, then the workstreams they may see. Returns the status the poll ends in, and with
  // "on" the user and the workstreams.
  async _ask(controller) {
    const who = await this._get("/v1/api/auth/whoami", controller);
    if (who.status) return who;
    const userId = typeof who.body?.user_id === "string" ? who.body.user_id : "";
    // The server answers whoami with 401 when no user is signed in, so an OK answer without one is not its answer.
    if (!userId) return { status: "refused" };
    const list = await this._get("/v1/api/workstreams", controller);
    if (list.status) return list;
    return { status: "on", userId, workstreams: list.body?.workstreams };
  }

  // One request as the signed-in user. Returns { body } for an OK answer, or { status } for what a refusal means.
  async _get(path, controller) {
    // A poll that stop() ended makes no more requests.
    controller.signal.throwIfAborted();
    let resp;
    try {
      resp = await this._fetch(`${this.settings.serverUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        // A redirect is not followed: the answer must come from the configured server, not wherever it points.
        redirect: "manual",
      });
    } catch (err) {
      // Electron's fetch fails a redirect it does not follow, so this is the server answering with one.
      if (isRefusedRedirect(err)) return { status: "refused" };
      throw err;
    }
    if (!resp.ok) {
      // Nothing reads a non-OK answer, and the next poll replaces the controller that stop() aborts, so the
      // request is aborted here. That closes its connection, which cancelling the body does not do under
      // Electron's fetch.
      controller.abort();
      return { status: refusalStatus(resp.status) };
    }
    return { body: await resp.json() };
  }

  // Records the user's workstreams, and announces each one that has come into a state that needs the user since
  // the last answer. The first answer, and the first after another user signs in, only record: what already
  // waited is not news.
  _compare(userId, workstreams) {
    const known = userId === this.userId ? this.known : null;
    const states = new Map();
    const changed = [];
    for (const ws of Array.isArray(workstreams) ? workstreams : []) {
      // The server lists every workstream the user may see, so another user's are skipped here.
      if (!ws || ws.user_id !== userId || typeof ws.ws_id !== "string") continue;
      states.set(ws.ws_id, ws.state);
      if (known && known.get(ws.ws_id) !== ws.state) changed.push(ws);
    }
    // Recorded before anything is shown, so a notification that fails is not shown again on every poll.
    this.known = states;
    this.userId = userId;
    for (const ws of changed) this._announce(ws);
  }

  // Whoever signs in next starts from where things stand, not from the states recorded for the last user.
  _forget() {
    this.known = null;
    this.userId = null;
  }

  _report(status) {
    if (status === this.status) return;
    this.status = status;
    this._onStatus(status);
  }

  _announce(ws) {
    const name = ws.name || ws.ws_id || "Workstream";
    if (ws.state === "attention") {
      this._notify("Attention Needed", `${name} requires your input`);
    } else if (ws.state === "error") {
      this._notify("Error", `${name} encountered an error`);
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
    // A URL change in the same mode. The manager reads the settings again each
    // time it polls, so stopping and starting it is enough.
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
