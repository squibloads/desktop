import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// notifications.js does not load electron, so this file runs under plain Node.
// The Notification class and fetch are injected, which keeps the electron package
// and its binary out of every test here.
const { NotificationManager, createNotificationLifecycle } = require("../../src/main/notifications.js");

const SETTINGS = { serverUrl: "http://127.0.0.1" };
// How often the manager asks: POLL_INTERVAL_MS in notifications.js.
const POLL_MS = 10000;

// Records each Notification constructed and each show() call, with an
// isSupported() answer chosen by the test. With failFirstShow, the first show()
// throws, as it can where the system has no notification service.
function makeFakeNotification({ supported = true, failFirstShow = false } = {}) {
  const constructed = [];
  const shown = [];
  let failNext = failFirstShow;
  class FakeNotification {
    constructor(options) {
      this.options = options;
      constructed.push(options);
    }
    show() {
      if (failNext) {
        failNext = false;
        throw new Error("no notification service");
      }
      shown.push(this.options);
    }
    static isSupported() {
      return supported;
    }
  }
  return { Notification: FakeNotification, constructed, shown };
}

const json = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

// A workstream as the server lists it, owned by the signed-in user unless the fields say otherwise.
const ws = (id, state, fields = {}) => ({ ws_id: id, name: id, state, user_id: "u1", ...fields });

/**
 * A Turnstone server as the poll sees it: whoami names the signed-in user, and the workstream list holds every
 * workstream that user may see, whoever owns it. A test changes the fields between polls. With refuse set, every
 * request is answered with that status, or rejected with it when it is an Error.
 */
function fakeServer() {
  const server = { userId: "u1", workstreams: [], refuse: null };
  const fetch = vi.fn(async (url) => {
    if (server.refuse instanceof Error) throw server.refuse;
    if (server.refuse !== null) return { ok: false, status: server.refuse };
    const { pathname } = new URL(url);
    if (pathname === "/v1/api/auth/whoami") return json({ user_id: server.userId });
    if (pathname === "/v1/api/workstreams") return json({ workstreams: server.workstreams });
    return { ok: false, status: 404 };
  });
  return { server, fetch };
}

// The paths a fetch mock was asked for, in order.
const paths = (fetch) => fetch.mock.calls.map(([url]) => new URL(url).pathname);
const whoamiCount = (fetch) => paths(fetch).filter((p) => p === "/v1/api/auth/whoami").length;

let manager;
let fake;
let statuses;

function makeManager(fetch, { settings = SETTINGS, ...notification } = {}) {
  fake = makeFakeNotification(notification);
  statuses = [];
  manager = new NotificationManager(settings, {
    fetch,
    Notification: fake.Notification,
    onStatus: (status) => statuses.push(status),
  });
  return manager;
}

// Lets a poll that has started finish.
const settle = () => vi.advanceTimersByTimeAsync(0);
// Runs the next polls.
const nextPoll = (count = 1) => vi.advanceTimersByTimeAsync(POLL_MS * count);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (manager) manager.stop();
  manager = undefined;
  vi.useRealTimers();
});

describe("NotificationManager asks as the signed-in user", () => {
  // Failure: the poll asks a server other than the configured one, or follows a redirect, so the user's workstreams
  // are read from a server they never chose.
  it("asks the configured server who is signed in, then for the workstreams, and follows no redirect", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1/v1/api/auth/whoami",
      "http://127.0.0.1/v1/api/workstreams",
    ]);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ redirect: "manual" });
  });

  // Failure: the manager asks a URL fixed when it was built, so a URL edit that restarts it still reaches the old server.
  it("asks the server URL the settings hold when it polls", async () => {
    const { fetch } = fakeServer();
    const settings = { serverUrl: "http://old.example" };
    makeManager(fetch, { settings });

    settings.serverUrl = "http://new.example";
    manager.start();
    await settle();

    expect(fetch.mock.calls[0][0]).toEqual("http://new.example/v1/api/auth/whoami");
  });

  // Failure: the poll runs in a tight loop and loads the server, or so rarely that a waiting workstream goes unnoticed.
  it("asks again every 10 seconds", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();

    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    const beforeInterval = whoamiCount(fetch);
    await vi.advanceTimersByTimeAsync(1);

    expect([beforeInterval, whoamiCount(fetch)]).toEqual([1, 2]);
  });
});

describe("NotificationManager notifies", () => {
  // Failure: every workstream that already waits is announced at start, so each launch floods the user.
  it("only records where things stand on the first answer", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "attention"), ws("w2", "error")];
    makeManager(fetch).start();
    await settle();

    expect(fake.constructed).toEqual([]);
    expect(statuses).toEqual(["on"]);
  });

  // Failure: a workstream that starts waiting for the user raises no alert.
  it("notifies when one of the user's workstreams starts needing their input", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running", { name: "Build" })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w1", "attention", { name: "Build" })];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: "Build requires your input" }]);
    expect(fake.shown.length).toEqual(1);
  });

  // Failure: a workstream that fails raises no alert, or one under the attention title.
  it("notifies when one of them fails", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running", { name: "Build" })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w1", "error", { name: "Build" })];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Error", body: "Build encountered an error" }]);
  });

  // Failure: a workstream started and blocked between two polls is never announced, because it was not in the last answer.
  it("notifies for a workstream that is new since the last answer and already needs the user", async () => {
    const { server, fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w2", "attention")];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: "w2 requires your input" }]);
  });

  // Failure: a workstream that keeps waiting is announced again on every poll.
  it("notifies once while a workstream stays in the same state", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w1", "attention")];
    await nextPoll(3);

    expect(fake.constructed.length).toEqual(1);
  });

  // Failure: a workstream that needs the user a second time is not announced again.
  it("notifies again when a workstream comes back to a state that needs the user", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch).start();
    await settle();

    for (const state of ["attention", "running", "attention"]) {
      server.workstreams = [ws("w1", state)];
      await nextPoll();
    }

    expect(fake.constructed.map((n) => n.body)).toEqual(["w1 requires your input", "w1 requires your input"]);
  });

  // Failure: on a shared server, every other user's waiting workstream reaches this user's desktop.
  it("ignores workstreams that belong to other users", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w2", "running", { user_id: "u2" }), ws("w3", "running", { user_id: "" })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w2", "attention", { user_id: "u2" }), ws("w3", "error", { user_id: "" })];
    await nextPoll();

    expect(fake.constructed).toEqual([]);
  });

  // Failure: routine progress notifies the user and buries real alerts.
  it("ignores states other than attention and error", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "idle")];
    makeManager(fetch).start();
    await settle();

    for (const state of ["thinking", "running", "evaluation", "idle", "closed"]) {
      server.workstreams = [ws("w1", state)];
      await nextPoll();
    }

    expect(fake.constructed).toEqual([]);
  });

  // Failure: a list that is not the shape asked for throws out of the poll and stops it.
  it("reads a list it does not recognise as no workstreams, and keeps polling", async () => {
    const fetch = vi.fn(async (url) =>
      new URL(url).pathname === "/v1/api/auth/whoami"
        ? json({ user_id: "u1" })
        : json({ workstreams: [null, 7, { state: "attention", user_id: "u1" }] }),
    );
    makeManager(fetch).start();
    await settle();
    await nextPoll();

    expect(fake.constructed).toEqual([]);
    expect(statuses).toEqual(["on"]);
    expect(whoamiCount(fetch)).toEqual(2);
  });

  // Failure: a notification that fails to show throws out of the poll, and no later notification arrives.
  it("keeps polling after a notification fails to show", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running"), ws("w2", "running")];
    makeManager(fetch, { failFirstShow: true }).start();
    await settle();

    server.workstreams = [ws("w1", "attention"), ws("w2", "running")];
    await nextPoll();
    server.workstreams = [ws("w1", "attention"), ws("w2", "attention")];
    await nextPoll();

    expect(fake.shown).toEqual([{ title: "Turnstone: Attention Needed", body: "w2 requires your input" }]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationManager names the workstream", () => {
  // Failure: a workstream with an empty or missing name shows " requires your input" or "undefined requires your input".
  it("falls back to the ws_id when the name is empty or missing", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w8", "idle", { name: "" }), ws("w9", "idle", { name: undefined })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w8", "attention", { name: "" }), ws("w9", "attention", { name: undefined })];
    await nextPoll();

    expect(fake.constructed.map((n) => n.body)).toEqual(["w8 requires your input", "w9 requires your input"]);
  });

  // Failure: a workstream with neither a name nor an ID shows a blank subject.
  it("falls back to Workstream when there is neither", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("", "idle", { name: "" })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("", "error", { name: "" })];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Error", body: "Workstream encountered an error" }]);
  });

  // Failure: on a platform without notification support the app builds one anyway and crashes.
  it("builds no notification where notifications are not supported", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch, { supported: false }).start();
    await settle();

    server.workstreams = [ws("w1", "attention")];
    await nextPoll();

    expect(fake.constructed).toEqual([]);
    expect(fake.shown).toEqual([]);
  });
});

describe("NotificationManager reports whether notifications work", () => {
  // Failure: a server that wants a sign-in is polled silently, so the user never learns why no notification arrives.
  it("reports a server that asks for a sign-in as signed out, and asks it for nothing more", async () => {
    const { server, fetch } = fakeServer();
    server.refuse = 401;
    makeManager(fetch).start();
    await settle();

    expect(statuses).toEqual(["signed-out"]);
    expect(paths(fetch)).toEqual(["/v1/api/auth/whoami"]);
  });

  // Failure: a server's lasting refusal reads as a server that is down, or as notifications that work.
  it.each([400, 403, 404])("reports a %i as refused", async (status) => {
    const { server, fetch } = fakeServer();
    server.refuse = status;
    makeManager(fetch).start();
    await settle();

    expect(statuses).toEqual(["refused"]);
  });

  // Failure: a redirect, which Electron's fetch fails instead of returning, reads as a server that is down.
  it("reports a redirect as refused", async () => {
    const { server, fetch } = fakeServer();
    server.refuse = new Error("Redirect was cancelled");
    makeManager(fetch).start();
    await settle();

    expect(statuses).toEqual(["refused"]);
  });

  // Failure: a whoami answer with no user matches every workstream that has no owner, or throws.
  it("reports a whoami answer that names no user as refused, and asks for no workstreams", async () => {
    const fetch = vi.fn(async () => json({}));
    makeManager(fetch).start();
    await settle();

    expect(statuses).toEqual(["refused"]);
    expect(paths(fetch)).toEqual(["/v1/api/auth/whoami"]);
  });

  // Failure: a server that is down or busy reads as a refusal, so the tray tells the user to sign in again.
  it.each([
    ["no connection", new Error("connect ECONNREFUSED")],
    ["a server error", 500],
    ["a server that is unavailable", 503],
    ["a rate limit", 429],
  ])("reports %s as waiting", async (_name, refuse) => {
    const { server, fetch } = fakeServer();
    server.refuse = refuse;
    makeManager(fetch).start();
    await settle();

    expect(statuses).toEqual(["waiting"]);
  });

  // Failure: an OK answer that is not JSON, such as a sign-in page served in its place, throws out of the poll and stops it.
  it("reports an OK answer that is not JSON as waiting, and polls again", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token <")) }));
    makeManager(fetch).start();
    await settle();
    await nextPoll();

    expect(statuses).toEqual(["waiting"]);
    expect(whoamiCount(fetch)).toEqual(2);
  });

  // Failure: a status that has not changed is reported on every poll, so the log gains a line every 10 seconds.
  it("reports a status only when it changes", async () => {
    const { server, fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();
    await nextPoll();
    server.refuse = 401;
    await nextPoll(2);
    server.refuse = null;
    await nextPoll();

    expect(statuses).toEqual(["on", "signed-out", "on"]);
  });

  // Failure: the tray still says notifications are on after a switch to a mode with no server.
  it("reports no status once stopped", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();
    manager.stop();

    expect(statuses).toEqual(["on", null]);
  });

  // Failure: a refused answer's request is left open, which under Electron's fetch keeps its connection open, so every
  // poll leaves one more.
  it.each([401, 503])("aborts the request of a %i answer", async (status) => {
    const { server, fetch } = fakeServer();
    server.refuse = status;
    makeManager(fetch).start();
    await settle();

    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe("NotificationManager after a sign-out or an outage", () => {
  // Failure: after a sign-out and a new sign-in, the states recorded before decide what is announced, so a workstream
  // that waited all along is announced as if it had just started waiting.
  it("forgets the workstreams it knew when the server asks for a sign-in", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch).start();
    await settle();

    server.refuse = 401;
    await nextPoll();
    server.refuse = null;
    server.workstreams = [ws("w1", "attention")];
    await nextPoll();

    expect(fake.constructed).toEqual([]);
  });

  // Failure: when another user signs in, the states recorded for the last user decide what is announced to the new one.
  it("starts from where things stand when another user signs in", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running"), ws("w2", "running", { user_id: "u2" })];
    makeManager(fetch).start();
    await settle();

    server.userId = "u2";
    server.workstreams = [ws("w1", "running"), ws("w2", "attention", { user_id: "u2" })];
    await nextPoll();
    expect(fake.constructed).toEqual([]);

    server.workstreams = [ws("w1", "running"), ws("w2", "error", { user_id: "u2" })];
    await nextPoll();
    expect(fake.constructed).toEqual([{ title: "Turnstone: Error", body: "w2 encountered an error" }]);
  });

  // Failure: an outage makes the manager forget the states it knew, so a workstream that started waiting during it
  // is never announced.
  it("keeps the workstreams it knew through an outage, and announces what changed during it", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch).start();
    await settle();

    server.refuse = new Error("connect ECONNREFUSED");
    await nextPoll();
    server.refuse = null;
    server.workstreams = [ws("w1", "attention")];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: "w1 requires your input" }]);
  });
});

describe("NotificationManager start and stop", () => {
  // Failure: stop() on quit or a mode switch leaves the request open, or a timer that polls again.
  it("stop() aborts the request in flight and asks nothing more", async () => {
    const fetch = vi.fn(
      (url, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    makeManager(fetch).start();
    const { signal } = fetch.mock.calls[0][1];
    manager.stop();
    await vi.advanceTimersByTimeAsync(60000);

    expect(signal.aborted).toBe(true);
    expect(fetch.mock.calls.length).toBe(1);
  });

  // Failure: stop() leaves the next poll armed, so it fires later and polls a server the user turned off.
  it("stop() cancels the next poll", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();
    manager.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  // Failure: a poll that stop() ended goes on to its next request, so a stopped loop still reaches the server.
  it("makes no further request for a poll that a restart ended between its requests", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch);
    manager.start();
    manager.start();
    await settle();

    expect(paths(fetch)).toEqual(["/v1/api/auth/whoami", "/v1/api/auth/whoami", "/v1/api/workstreams"]);
  });

  // Failure: calling start() twice runs two loops, which poll twice as often, and a later stop() reaches only one.
  it("keeps one loop when start() is called twice", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch);
    manager.start();
    manager.start();
    await settle();

    const afterStart = fetch.mock.calls.length;
    await nextPoll();

    expect(fetch.mock.calls.length - afterStart).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  // Failure: an answer to a poll from before a restart is announced, or replaces the states the live loop knows.
  it("drops a late answer to a poll from before a restart", async () => {
    const { server, fetch } = fakeServer();
    let answerLate;
    const late = new Promise((resolve) => {
      answerLate = resolve;
    });
    let lists = 0;
    const firstListIsLate = vi.fn((url, init) => {
      if (new URL(url).pathname === "/v1/api/workstreams" && lists++ === 0) return late;
      return fetch(url, init);
    });
    server.workstreams = [ws("w1", "running")];
    makeManager(firstListIsLate).start();
    await settle();
    manager.stop();
    manager.start();
    await settle();

    answerLate(json({ workstreams: [ws("w1", "attention")] }));
    await settle();
    expect(fake.constructed).toEqual([]);

    server.workstreams = [ws("w1", "attention")];
    await nextPoll();
    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: "w1 requires your input" }]);
    expect(statuses).toEqual(["on"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  // Failure: a restart for a new Server URL compares the new server's workstreams with the states recorded for the
  // old one, so it announces workstreams that differ only because the server did.
  it("starts from where things stand after a restart", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w1", "attention")];
    manager.stop();
    manager.start();
    await settle();

    expect(fake.constructed).toEqual([]);
  });

  // Failure: a restart waits out the interval before it asks, so a corrected URL shows nothing for 10 seconds.
  it("asks at once after a restart", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();
    await vi.advanceTimersByTimeAsync(POLL_MS / 2);

    manager.stop();
    manager.start();

    expect(whoamiCount(fetch)).toBe(2);
  });
});

describe("createNotificationLifecycle", () => {
  // A factory whose managers record their own starts and stops.
  function fakeFactory() {
    const made = [];
    const create = (settings) => {
      const manager = {
        settings,
        starts: 0,
        stops: 0,
        start() {
          this.starts += 1;
        },
        stop() {
          this.stops += 1;
        },
      };
      made.push(manager);
      return manager;
    };
    return { create, made };
  }

  // Failure: a switch into a mode without a server starts a manager that dials the remote server saved for another mode.
  it("starts nothing in a mode without a server", () => {
    const { create, made } = fakeFactory();
    createNotificationLifecycle(create).apply({ hasServer: false, serverUrl: "http://127.0.0.1" });

    expect(made).toEqual([]);
  });

  // Failure: a mode with a server runs no alerts, or runs them from a copy of the settings that goes stale.
  it("starts one manager for a mode with a server, given the live settings", () => {
    const { create, made } = fakeFactory();
    const settings = { hasServer: true, serverUrl: "http://127.0.0.1" };
    createNotificationLifecycle(create).apply(settings);

    expect(made.length).toEqual(1);
    expect(made[0].starts).toEqual(1);
    expect(made[0].settings).toBe(settings);
  });

  // Failure: applying a new mode leaves the previous manager connected beside the new one.
  it("stops the previous manager when the settings are applied again", () => {
    const { create, made } = fakeFactory();
    const lifecycle = createNotificationLifecycle(create);
    lifecycle.apply({ hasServer: true });
    lifecycle.apply({ hasServer: false });

    expect(made[0].stops).toEqual(1);
    expect(made.length).toEqual(1);
  });

  // Failure: a URL change in the same mode leaves the old connection open, and no new one starts.
  it("restarts the same manager on a URL change", () => {
    const { create, made } = fakeFactory();
    const lifecycle = createNotificationLifecycle(create);
    lifecycle.apply({ hasServer: true });
    lifecycle.restart();

    expect(made.length).toEqual(1);
    expect(made[0].stops).toEqual(1);
    expect(made[0].starts).toEqual(2);
  });

  // Failure: a save that arrives after a stop revives a manager the user turned off.
  it("does nothing on restart after stop", () => {
    const { create, made } = fakeFactory();
    const lifecycle = createNotificationLifecycle(create);
    lifecycle.apply({ hasServer: true });
    lifecycle.stop();
    lifecycle.restart();

    expect(made[0].stops).toEqual(1);
    expect(made[0].starts).toEqual(1);
  });

  // Failure: a restart with no manager running starts one for a mode that has none.
  it("does nothing on restart when no manager runs", () => {
    const { create, made } = fakeFactory();
    createNotificationLifecycle(create).restart();

    expect(made).toEqual([]);
  });
});
