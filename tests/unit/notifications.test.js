import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// notifications.js does not load electron, so this file runs under plain Node.
// The Notification class and fetch are injected, which keeps the electron package
// and its binary out of every test here.
const { NotificationManager, createNotificationLifecycle, workstreamLabel } = require("../../src/main/notifications.js");

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
 * request is answered with that status, or rejected with it when it is an Error. With refuseList set, only the
 * workstream list is answered with that status.
 */
function fakeServer() {
  const server = { userId: "u1", workstreams: [], refuse: null, refuseList: null };
  const fetch = vi.fn(async (url) => {
    if (server.refuse instanceof Error) throw server.refuse;
    if (server.refuse !== null) return { ok: false, status: server.refuse };
    const { pathname } = new URL(url);
    if (pathname === "/v1/api/auth/whoami") return json({ user_id: server.userId });
    if (pathname === "/v1/api/workstreams" && server.refuseList !== null) return { ok: false, status: server.refuseList };
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
// console.error, which the manager logs to. Replaced in every test, so a test that expects nothing logged can say so.
let errors;
// What the session holds for the server, as the manager's cookieDigest reads it. A test changes it to sign a user in
// or out while a poll runs.
let jar;

// onStatus, when given, also runs for each status, after it is recorded in statuses.
function makeManager(fetch, { settings = SETTINGS, onStatus, ...notification } = {}) {
  fake = makeFakeNotification(notification);
  statuses = [];
  manager = new NotificationManager(settings, {
    fetch,
    cookieDigest: async () => jar.digest,
    Notification: fake.Notification,
    onStatus: (status) => {
      statuses.push(status);
      onStatus?.(status);
    },
  });
  return manager;
}

// Lets a poll that has started finish.
const settle = () => vi.advanceTimersByTimeAsync(0);
// Runs the next polls.
const nextPoll = (count = 1) => vi.advanceTimersByTimeAsync(POLL_MS * count);

beforeEach(() => {
  vi.useFakeTimers();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  jar = { digest: "signed in as u1" };
});

afterEach(() => {
  if (manager) manager.stop();
  manager = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
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

    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "Build" requires your input' }]);
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

    expect(fake.constructed).toEqual([{ title: "Turnstone: Error", body: 'Workstream "Build" encountered an error' }]);
  });

  // Failure: a workstream started and blocked between two polls is never announced, because it was not in the last answer.
  it("notifies for a workstream that is new since the last answer and already needs the user", async () => {
    const { server, fetch } = fakeServer();
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w2", "attention")];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "w2" requires your input' }]);
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

    expect(fake.constructed.map((n) => n.body)).toEqual(['Workstream "w1" requires your input', 'Workstream "w1" requires your input']);
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

  // Failure: a list in a shape the app cannot read, such as an older server's, never notifies while the tray says
  // notifications are on; or it throws out of the poll and stops it.
  it.each([
    ["no list", {}],
    ["a list that is not an array", { workstreams: "w1" }],
    ["a row that is not a workstream", { workstreams: [ws("w1", "running"), null] }],
    ["rows with no ws_id", { workstreams: [{ id: "w1", state: "attention", user_id: "u1" }] }],
  ])("reports %s as not supported, and keeps polling", async (_name, body) => {
    const fetch = vi.fn(async (url) => json(new URL(url).pathname === "/v1/api/auth/whoami" ? { user_id: "u1" } : body));
    makeManager(fetch).start();
    await settle();
    await nextPoll();

    expect(fake.constructed).toEqual([]);
    expect(statuses).toEqual(["unsupported"]);
    expect(whoamiCount(fetch)).toEqual(2);
  });

  // Failure: a notification that fails to show throws out of the poll, and no later notification arrives.
  it("keeps polling after a notification fails to show", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running"), ws("w2", "running")];
    makeManager(fetch, { failFirstShow: true }).start();
    await settle();

    server.workstreams = [ws("w1", "attention"), ws("w2", "running")];
    await nextPoll();
    server.workstreams = [ws("w1", "attention"), ws("w2", "attention")];
    await nextPoll();

    expect(fake.shown).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "w2" requires your input' }]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  // Failure: one notification that fails to show drops the others due from the same answer, for good, since the next
  // answer finds them in the same state; and the status that answer brings is never reported.
  it("shows the rest of an answer's notifications, and reports its status, when one fails to show", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running"), ws("w2", "running")];
    makeManager(fetch, { failFirstShow: true }).start();
    await settle();
    server.refuse = new Error("connect ECONNREFUSED");
    await nextPoll();

    server.refuse = null;
    server.workstreams = [ws("w1", "attention"), ws("w2", "attention")];
    await nextPoll();

    expect(fake.shown).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "w2" requires your input' }]);
    expect(statuses).toEqual(["on", "waiting", "on"]);
  });
});

describe("NotificationManager names the workstream", () => {
  // Failure: a workstream with an empty or missing name shows 'Workstream "" requires your input' or 'Workstream "undefined" requires your input'.
  it("falls back to the ws_id when the name is empty or missing", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w8", "idle", { name: "" }), ws("w9", "idle", { name: undefined })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w8", "attention", { name: "" }), ws("w9", "attention", { name: undefined })];
    await nextPoll();

    expect(fake.constructed.map((n) => n.body)).toEqual(['Workstream "w8" requires your input', 'Workstream "w9" requires your input']);
  });

  // Failure: a workstream with neither a name nor an ID shows a blank subject.
  it("falls back to a workstream when there is neither", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("", "idle", { name: "" })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("", "error", { name: "" })];
    await nextPoll();

    expect(fake.constructed).toEqual([{ title: "Turnstone: Error", body: "A workstream encountered an error" }]);
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

  // Failure: a name the model wrote reads as the app's own message: a long one fills the notification with text that
  // looks like an instruction from Turnstone, and the fixed title above it lends it the app's voice.
  it("shows a name the model set as the workstream's own, short and quoted, under a fixed title", async () => {
    const posing = 'Build"\n\nTurnstone security: your session expired. Sign in again at https://login.example.com now';
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running", { name: posing })];
    makeManager(fetch).start();
    await settle();

    server.workstreams = [ws("w1", "attention", { name: posing })];
    await nextPoll();

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Attention Needed", body: `Workstream "Build' Turnstone security: your session…" requires your input` },
    ]);
  });
});

describe("workstreamLabel", () => {
  // Failure: the name is shown bare, so nothing tells the user that the text is the workstream's and not the app's.
  it("quotes the name after a fixed label", () => {
    expect(workstreamLabel({ ws_id: "w1", name: "Build" })).toBe('Workstream "Build"');
  });

  // Failure: a long name fills the notification, room enough to pose as a message from the app.
  it("cuts a name longer than 40 characters, and marks the cut", () => {
    expect(workstreamLabel({ name: "x".repeat(40) })).toBe(`Workstream "${"x".repeat(40)}"`);
    expect(workstreamLabel({ name: "x".repeat(41) })).toBe(`Workstream "${"x".repeat(40)}…"`);
  });

  // Failure: the cut counts UTF-16 units, so it leaves half of a character the system shows as a box.
  it("counts characters, not UTF-16 units, when it cuts", () => {
    expect(workstreamLabel({ name: "😀".repeat(50) })).toBe(`Workstream "${"😀".repeat(40)}…"`);
  });

  // Failure: the cut counts code points, so it splits a flag into two letters, or an emoji from its skin tone.
  it("counts what the user sees as one character, when it cuts", () => {
    const flag = "\u{1F1FA}\u{1F1F8}";
    const wave = "\u{1F44B}\u{1F3FD}";
    expect(workstreamLabel({ name: flag.repeat(41) })).toBe(`Workstream "${flag.repeat(40)}…"`);
    expect(workstreamLabel({ name: wave.repeat(41) })).toBe(`Workstream "${wave.repeat(40)}…"`);
  });

  // Failure: a line break in the name starts what looks like a separate message from the app below the label.
  it("turns line breaks, tabs and control characters into single spaces", () => {
    expect(workstreamLabel({ name: "Build\r\n\n\tTurnstone:\u0007 update\u2028now\u0085" })).toBe('Workstream "Build Turnstone: update now"');
  });

  // Failure: a direction override or an invisible character makes the name read as something other than its text.
  it("drops direction overrides and invisible format characters", () => {
    expect(workstreamLabel({ name: "Build\u202Eexe.txt\u202C\u200B\u2066" })).toBe('Workstream "Buildexe.txt"');
  });

  // Failure: a blank character outside the format category, such as a Hangul filler, pads the name with space the
  // user cannot see, or a name of nothing else shows as empty quotes.
  it("drops blank characters of other kinds too, such as Hangul fillers", () => {
    expect(workstreamLabel({ name: "Bu\u034Fild\u3164\uFFA0" })).toBe('Workstream "Build"');
  });

  // Failure: the joiners that emoji and names in Persian or Indian scripts need are dropped, so the name is misspelt.
  it("keeps the joiners and emoji selectors a name needs", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0645";
    expect(workstreamLabel({ name: `${family} ${persian} \u2764\uFE0F` })).toBe(`Workstream "${family} ${persian} \u2764\uFE0F"`);
  });

  // Failure: a quote mark the rule does not list, or two single quotes side by side, reads as a closing double quote.
  it("treats quote marks of every kind, and runs of them, as one single quote", () => {
    const name = "x\u301E ok \u301D \u00ABa\u00BB \u05F4b\u05F4 ''c'' \u2033d\u2036 \u275Ee\u2E42 \u02BAf\u02DD";
    expect(workstreamLabel({ name })).toBe("Workstream \"x' ok ' 'a' 'b' 'c' 'd' 'e' 'f '\"");
  });

  // Failure: a fullwidth or small form of a word, a quote or a bracket passes as text the rules do not see.
  it("folds fullwidth and small forms before the rules apply", () => {
    expect(workstreamLabel({ name: "\uFF34\uFF55\uFF52\uFF4E\uFF53\uFF54\uFF4F\uFF4E\uFF45 \uFF02x\uFF02 \uFE64b\uFE65" })).toBe(
      "Workstream \"Turnstone 'x' ‹b›\"",
    );
  });

  // Failure: a server that reads markup decodes an entity in the name, so &quot; closes the label's quotes and &#10;
  // puts back the line break the rule removed.
  it("keeps entities in the name from reading as entities", () => {
    expect(workstreamLabel({ name: "x&quot; failed&#10;&#x202E;" })).toBe('Workstream "x\uFF06quot; failed\uFF06#10;\uFF06#x202E;"');
  });

  // Failure: a quote mark in the name closes the label's quotes early, so the rest reads as the app's own words.
  it("keeps the name from closing the quotes around it", () => {
    expect(workstreamLabel({ name: 'Build" done. Turnstone: \u201Cok\u201D \uFF02x' })).toBe("Workstream \"Build' done. Turnstone: 'ok' 'x\"");
  });

  // Failure: a notification server that reads markup, as some on Linux do, shows the name's tags as a link or bold text.
  it("keeps markup in the name from reading as markup", () => {
    expect(workstreamLabel({ name: '<a href="https://example.com">Open</a>' })).toBe("Workstream \"‹a href='https://example.com'›Open‹/a›\"");
  });

  // Failure: a name with nothing left to show, or one that is not text, gives an empty or "[object Object]" subject.
  it.each([
    ["an empty name", { ws_id: "w8", name: "" }],
    ["a blank name", { ws_id: "w8", name: " \n\u200B " }],
    ["a missing name", { ws_id: "w8" }],
    ["a name that is not text", { ws_id: "w8", name: { text: "Build" } }],
    ["a name of Hangul fillers", { ws_id: "w8", name: "\u3164\u3164" }],
    ["a name of combining marks alone", { ws_id: "w8", name: "\u0301\u0301" }],
  ])("falls back to the ws_id for %s", (_case, ws) => {
    expect(workstreamLabel(ws)).toBe('Workstream "w8"');
  });

  // Failure: the ws_id, which the server sets, skips the rules the name goes through.
  it("puts a ws_id it falls back to through the same rules", () => {
    expect(workstreamLabel({ ws_id: `w1\n${"y".repeat(60)}` })).toBe(`Workstream "w1 ${"y".repeat(37)}…"`);
  });

  // Failure: a workstream with neither a name nor a ws_id it can show gives empty quotes, or "7" from a number.
  it.each([{}, { ws_id: "", name: "" }, { ws_id: 7, name: 7 }])("says a workstream when there is neither (%j)", (ws) => {
    expect(workstreamLabel(ws)).toBe("A workstream");
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
    ["a request timeout", 408],
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

  // Failure: a refusal of the list, after whoami named the user, reads differently from the same refusal of whoami,
  // or leaves its request open.
  it.each([
    [401, "signed-out"],
    [403, "refused"],
    [503, "waiting"],
  ])("reports a %i answer to the list as %s, and aborts its request", async (status, expected) => {
    const { server, fetch } = fakeServer();
    server.refuseList = status;
    makeManager(fetch).start();
    await settle();

    expect(statuses).toEqual([expected]);
    expect(paths(fetch)).toEqual(["/v1/api/auth/whoami", "/v1/api/workstreams"]);
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  });

  // Failure: a poll that keeps failing for a cause the app does not report, such as a certificate the session does not
  // trust or a fault in the app, shows only "Waiting for the server", and nothing says why; or the cause is logged on
  // every poll.
  it("logs why a poll failed, once for each new cause", async () => {
    const { server, fetch } = fakeServer();
    const untrusted = new TypeError("net::ERR_CERT_AUTHORITY_INVALID");
    server.refuse = untrusted;
    makeManager(fetch).start();
    await settle();
    await nextPoll(2);
    expect(errors.mock.calls).toEqual([["notifications:", untrusted]]);

    server.refuse = null;
    await nextPoll();
    server.refuse = untrusted;
    await nextPoll();
    expect(errors.mock.calls.length).toEqual(2);
  });

  // Failure: every stop or restart logs the abort of the poll it ended as if the poll had failed.
  it("logs nothing for a poll that stop() ended", async () => {
    const fetch = vi.fn(
      (url, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    makeManager(fetch).start();
    manager.stop();
    await settle();

    expect(errors).not.toHaveBeenCalled();
  });

  // Failure: a tray that fails to show a status throws out of the poll, which then never polls again, or out of
  // stop(), so quitting skips what follows it.
  it("keeps polling, and stops, when a status fails to show", async () => {
    const { fetch } = fakeServer();
    makeManager(fetch, {
      onStatus: () => {
        throw new Error("tray destroyed");
      },
    }).start();
    await settle();
    await nextPoll();

    expect(() => manager.stop()).not.toThrow();
    expect(whoamiCount(fetch)).toEqual(2);
    expect(statuses).toEqual(["on", null]);
    expect(errors.mock.calls.length).toEqual(2);
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

  // Failure: a list the server refuses, or cannot be read, leaves the states recorded before it to decide what the
  // next answer announces.
  it.each([
    ["the list is refused", (server) => (server.refuseList = 403)],
    ["the list cannot be read", (server) => (server.workstreams = [null])],
  ])("forgets the workstreams it knew when %s", async (_name, spoil) => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    makeManager(fetch).start();
    await settle();

    spoil(server);
    await nextPoll();
    server.refuseList = null;
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
    expect(fake.constructed).toEqual([{ title: "Turnstone: Error", body: 'Workstream "w2" encountered an error' }]);
  });

  // Failure: the answer to a list requested as one user arrives after another user signed in through the Server view,
  // and the first user's workstream is announced on the desktop the second one now uses.
  it("drops an answer when another user signs in while its poll runs", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    let switchDuringList = false;
    const switching = vi.fn(async (url, init) => {
      const resp = await fetch(url, init);
      if (switchDuringList && new URL(url).pathname === "/v1/api/workstreams") {
        switchDuringList = false;
        jar.digest = "signed in as u2";
        server.userId = "u2";
      }
      return resp;
    });
    makeManager(switching).start();
    await settle();

    server.workstreams = [ws("w1", "attention")];
    switchDuringList = true;
    await nextPoll(2);

    expect(fake.constructed).toEqual([]);
    expect(statuses).toEqual(["on"]);
  });

  // Failure: a refusal of requests sent as the user before reaches the tray after another user signed in, so it says
  // "Sign in to the server" to a user who just did, and the states recorded for the next answer are thrown away.
  it("drops a refusal when another user signs in while its poll runs", async () => {
    const { server, fetch } = fakeServer();
    let switchDuringWhoami = false;
    const switching = vi.fn(async (url, init) => {
      if (switchDuringWhoami && new URL(url).pathname === "/v1/api/auth/whoami") {
        switchDuringWhoami = false;
        jar.digest = "signed in as u2";
        server.userId = "u2";
        return { ok: false, status: 401 };
      }
      return fetch(url, init);
    });
    makeManager(switching).start();
    await settle();

    switchDuringWhoami = true;
    await nextPoll(2);

    expect(statuses).toEqual(["on"]);
  });

  // Failure: an answer dropped because the cookies changed, while the same user stays signed in, as when the sign-in
  // is renewed, loses the change it carried for good.
  it("announces at the next poll what a dropped answer carried, when the same user is still signed in", async () => {
    const { server, fetch } = fakeServer();
    server.workstreams = [ws("w1", "running")];
    let renewDuringList = false;
    const renewing = vi.fn(async (url, init) => {
      const resp = await fetch(url, init);
      if (renewDuringList && new URL(url).pathname === "/v1/api/workstreams") {
        renewDuringList = false;
        jar.digest = "signed in as u1, renewed";
      }
      return resp;
    });
    makeManager(renewing).start();
    await settle();

    server.workstreams = [ws("w1", "attention")];
    renewDuringList = true;
    await nextPoll();
    expect(fake.constructed).toEqual([]);

    await nextPoll();
    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "w1" requires your input' }]);
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

    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "w1" requires your input' }]);
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
    await settle();
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
    // The first whoami is answered only when the test says, after the restart, and its request is not aborted.
    let answerFirstWhoami;
    const firstWhoamiWaits = vi.fn((url, init) => {
      if (new URL(url).pathname !== "/v1/api/auth/whoami" || answerFirstWhoami) return fetch(url, init);
      return new Promise((resolve) => {
        answerFirstWhoami = () => resolve(json({ user_id: "u1" }));
      });
    });
    makeManager(firstWhoamiWaits).start();
    await settle();
    manager.stop();
    manager.start();
    await settle();
    answerFirstWhoami();
    await settle();

    expect(paths(firstWhoamiWaits)).toEqual(["/v1/api/auth/whoami", "/v1/api/auth/whoami", "/v1/api/workstreams"]);
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
    expect(fake.constructed).toEqual([{ title: "Turnstone: Attention Needed", body: 'Workstream "w1" requires your input' }]);
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
    await settle();

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
