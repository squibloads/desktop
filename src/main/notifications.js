const { signedInFetch, cookieDigest: sessionCookieDigest, isRefusedRedirect } = require("./session-fetch.js");

// How often the app asks the server for the workstreams. README.md states it, and
// tests/contract/documented-defaults.test.js keeps the two equal.
const POLL_INTERVAL_MS = 10000;
// A request with no answer by then is given up, so a server that stops answering cannot stall the poll.
const REQUEST_TIMEOUT_MS = 5000;
// The most of a workstream's name a notification shows, in characters. README.md states it. The model can set the
// name, and a long one has room to pose as a message from the app.
const NAME_MAX_CHARS = 40;

/**
 * How a notification names a workstream: its name, or its ws_id when it has none, quoted after a fixed label and cut
 * short, so text the model wrote reads as the workstream's own and never as the app's.
 */
function workstreamLabel(ws) {
  const shown = cleanName(ws?.name) || cleanName(ws?.ws_id);
  return shown ? `Workstream "${shown}"` : "A workstream";
}

// Characters that show nothing: format characters such as direction overrides, the other default-ignorable ones such
// as the blank Hangul fillers, and lone surrogates. The two joiners and the emoji presentation selectors are kept,
// because names in some scripts and many emoji need them, and they cannot reorder or hide text.
const INVISIBLE = /(?![\u200C\u200D\uFE0E\uFE0F])[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cs}]/gu;
// A run of quote marks of any kind: the plain ones, opening and closing quotes in any script, primes and ditto marks.
// U+030B is the combining double acute that the folding leaves of a double acute accent on its own.
const QUOTES = /['"\p{Pi}\p{Pf}\u02BA\u030B\u05F4\u2032-\u2037\u275B-\u275E\u2E42\u3003\u301D-\u301F]+/gu;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// One line of plain text from a name, or "" when nothing visible is left. Compatibility forms are folded first, so a
// fullwidth or small look-alike of a quote or a bracket meets the same rules as the plain one. Line breaks and control
// characters become spaces, and invisible characters are dropped, so the text reads as what it says. A run of quote
// marks becomes one single quote, so the name cannot close the label's quotes. <, > and & become look-alikes: Electron
// hands the text to a Linux notification server as it is, and some of those read markup and its entities.
function cleanName(text) {
  if (typeof text !== "string") return "";
  const flat = text
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, " ")
    .replace(INVISIBLE, "")
    .replace(QUOTES, "'")
    .replace(/</g, "\u2039")
    .replace(/>/g, "\u203A")
    .replace(/&/g, "\uFF06")
    .replace(/\s+/g, " ")
    .trim();
  // Combining marks alone, for one, show as nothing the user can read.
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(flat)) return "";
  // Counted in graphemes, so the cut never splits a letter from its accent or an emoji or a flag in two.
  const shown = Array.from(GRAPHEMES.segment(flat), ({ segment }) => segment);
  return shown.length > NAME_MAX_CHARS ? `${shown.slice(0, NAME_MAX_CHARS).join("").trimEnd()}\u2026` : flat;
}

// What a non-OK answer says about notifications. 401 is the server asking for a sign-in. Any other refusal of
// the request lasts until something changes, while a server error, a rate limit or a request timeout passes.
function refusalStatus(code) {
  if (code === 401) return "signed-out";
  if (code >= 400 && code < 500 && code !== 408 && code !== 429) return "refused";
  return "waiting";
}

// The server's global event stream needs a service token, which the server gives no signed-in user, so the app
// cannot use it. Instead it asks, as the user signed in to the Server view, for the workstreams that user may
// see, and notifies when one of the user's own comes into a state that needs them. The status it reports says
// whether that works: "on", "signed-out", "refused", "unsupported" or "waiting", and null once stopped.
//
// electron is not required at the top: the tests run under plain Node and inject
// Notification, fetch and cookieDigest. The lazy require below only runs in the real app.
// fetch is bound as fetchImpl because tests/contract/main-process-fetch.test.js refuses the
// bare name fetch in the main process.
class NotificationManager {
  constructor(
    settings,
    { Notification, fetch: fetchImpl = signedInFetch, cookieDigest = sessionCookieDigest, onStatus = () => {} } = {},
  ) {
    this.settings = settings;
    this._Notification = Notification;
    this._fetch = fetchImpl;
    this._cookieDigest = cookieDigest;
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
    // Why the last poll failed, as text, or null when it got an answer. A cause is logged when it first appears.
    this.failure = null;
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
    let failure = null;
    try {
      const cookies = await this._cookieDigest(this.settings.serverUrl);
      answer = await this._ask(controller);
      // The cookies changed while the poll ran: a user signed out, or another signed in, through the Server view.
      // The answer, whatever it says, is to requests sent as the user before, so it is dropped, and the next poll
      // asks as whoever is signed in then. A renewed sign-in changes them too, and the next poll then announces
      // what this one carried.
      if ((await this._cookieDigest(this.settings.serverUrl)) !== cookies) answer = null;
    } catch (err) {
      // No connection, no answer in time, an OK answer that is not JSON, or a fault here. The next poll asks again.
      answer = { status: "waiting" };
      failure = err;
    }
    // stop() has run since this poll began, and the loop it started owns the shared state.
    if (generation !== this.generation) return;

    this.timer = setTimeout(() => this._poll(generation), POLL_INTERVAL_MS);
    this._noteFailure(failure);
    if (answer === null) return;
    if (answer.status === "on") this._compare(answer.userId, answer.workstreams);
    else if (answer.status !== "waiting") this._forget();
    this._report(answer.status);
  }

  // The tray says only "Waiting for the server" for a poll that failed, so the cause is logged, once while it lasts:
  // a cause that never passes, such as a certificate the session does not trust, can then be found.
  _noteFailure(err) {
    const failure = err === null ? null : String(err);
    if (failure !== null && failure !== this.failure) console.error("notifications:", err);
    this.failure = failure;
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
    const workstreams = list.body?.workstreams;
    // A list in another shape, such as an older server's, would never notify while the tray said notifications work.
    if (!Array.isArray(workstreams) || !workstreams.every((ws) => typeof ws?.ws_id === "string")) {
      return { status: "unsupported" };
    }
    return { status: "on", userId, workstreams };
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
    for (const ws of workstreams) {
      // The server lists every workstream the user may see, so another user's are skipped here.
      if (ws.user_id !== userId) continue;
      states.set(ws.ws_id, ws.state);
      if (known && known.get(ws.ws_id) !== ws.state) changed.push(ws);
    }
    // Recorded before anything is shown, so a notification that fails is not shown again on every poll.
    this.known = states;
    this.userId = userId;
    for (const ws of changed) {
      // One that fails to show does not keep the others from showing.
      try {
        this._announce(ws);
      } catch (err) {
        console.error("notifications:", err);
      }
    }
  }

  // Whoever signs in next starts from where things stand, not from the states recorded for the last user.
  _forget() {
    this.known = null;
    this.userId = null;
  }

  _report(status) {
    if (status === this.status) return;
    this.status = status;
    // A tray that fails to show it must not end the poll, or stop() on the way to quitting.
    try {
      this._onStatus(status);
    } catch (err) {
      console.error("notifications:", err);
    }
  }

  _announce(ws) {
    const label = workstreamLabel(ws);
    if (ws.state === "attention") {
      this._notify("Attention Needed", `${label} requires your input`);
    } else if (ws.state === "error") {
      this._notify("Error", `${label} encountered an error`);
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

module.exports = { NotificationManager, createNotificationLifecycle, workstreamLabel };
