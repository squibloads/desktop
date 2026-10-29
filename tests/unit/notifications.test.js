import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// notifications.js does not load electron, so this file runs under plain Node.
// The Notification class is injected, which keeps the electron package and its
// binary out of every test here.
const { NotificationManager, createNotificationLifecycle } = require("../../src/main/notifications.js");

const SETTINGS = { serverUrl: "http://127.0.0.1" };

// Records each Notification constructed and each show() call, with an
// isSupported() answer chosen by the test.
function makeFakeNotification({ supported = true } = {}) {
  const constructed = [];
  const shown = [];
  class FakeNotification {
    constructor(options) {
      this.options = options;
      constructed.push(options);
    }
    show() {
      shown.push(this.options);
    }
    static isSupported() {
      return supported;
    }
  }
  return { Notification: FakeNotification, constructed, shown };
}

function makeSSEResponse(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let read = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          if (!read) {
            read = true;
            return Promise.resolve({ done: false, value: bytes });
          }
          return Promise.resolve({ done: true });
        },
      }),
    },
  };
}

// A response whose body the test feeds by hand. Like a real fetch, the body
// errors when the request is aborted, so a stream the manager has stopped
// delivers nothing more.
function controlledStream(signal) {
  let open = true;
  let streamController;
  const body = new ReadableStream({
    start(c) {
      streamController = c;
      signal.addEventListener("abort", () => {
        open = false;
        c.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return {
    response: { ok: true, body },
    push(text) {
      if (open) streamController.enqueue(new TextEncoder().encode(text));
    },
    close() {
      streamController.close();
    },
  };
}

// Connections the mock fetch opened that no abort has reached yet.
function liveConnections(fetchMock) {
  return fetchMock.mock.calls.filter(([, init]) => !init.signal.aborted).length;
}

describe("NotificationManager SSE parser", () => {
  let manager;
  let notifySpy;

  afterEach(() => {
    if (manager) manager.stop();
    manager = undefined;
  });

  function createManager() {
    const m = new NotificationManager(SETTINGS, { Notification: makeFakeNotification().Notification });
    // Spy on _notify to verify what notifications would fire; the real method still runs.
    notifySpy = vi.spyOn(m, "_notify");
    return m;
  }

  // Failure: an attention event in the global SSE stream raises no alert.
  it("calls _notify on attention event", async () => {
    const sse = `event: ws_state\ndata: {"state":"attention","name":"my-ws"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "my-ws requires your input"]]);
  });

  // Failure: a workstream that errors out raises no alert.
  it("calls _notify on error event", async () => {
    const sse = `event: ws_state\ndata: {"state":"error","name":"broken"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(notifySpy.mock.calls).toEqual([["Error", "broken encountered an error"]]);
  });

  // Failure: routine running or idle transitions notify the user and bury real alerts.
  it("ignores running/idle states", async () => {
    const sse = `event: ws_state\ndata: {"state":"running","name":"ws1"}\n\nevent: ws_state\ndata: {"state":"idle","name":"ws2"}\n\n`;
    const fetchMock = vi.fn().mockResolvedValue(makeSSEResponse(sse));
    vi.stubGlobal("fetch", fetchMock);

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls).toEqual([]);
  });

  // Failure: a data payload split over several data: lines is dropped, so the alert is lost.
  it("handles multi-line data fields per SSE spec", async () => {
    const sse = `event: ws_state\ndata: {"state":\ndata: "attention","name":"ws"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "ws requires your input"]]);
  });

  // Failure: a corrupt SSE frame throws out of the read loop and kills the stream.
  it("ignores malformed JSON", async () => {
    const sse = `event: ws_state\ndata: not-json\n\n`;
    const fetchMock = vi.fn().mockResolvedValue(makeSSEResponse(sse));
    vi.stubGlobal("fetch", fetchMock);

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls).toEqual([]);
  });

  // Failure: an event with only a ws_id produces an alert with no workstream name.
  it("uses ws_id as fallback name", async () => {
    const sse = `event: ws_state\ndata: {"state":"attention","ws_id":"abc123"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "abc123 requires your input"]]);
  });

  // Failure: heartbeat or connected events are treated as workstream state and notify.
  it("ignores unrelated event types", async () => {
    const sse = `event: heartbeat\ndata: {}\n\nevent: connected\ndata: {"model":"test"}\n\n`;
    const fetchMock = vi.fn().mockResolvedValue(makeSSEResponse(sse));
    vi.stubGlobal("fetch", fetchMock);

    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls).toEqual([]);
  });
});

// Like makeSSEResponse, but each string is one network chunk, so a test can put a
// chunk boundary anywhere in a frame.
function makeChunkedSSEResponse(chunks) {
  const encoder = new TextEncoder();
  let next = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          if (next < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[next++]) });
          }
          return Promise.resolve({ done: true });
        },
      }),
    },
  };
}

// An SSE frame can arrive split anywhere across network chunks, and every split
// must still produce its alert.
describe("NotificationManager SSE frames across chunks", () => {
  const FRAME = 'event: ws_state\ndata: {"state":"attention","name":"ws"}\n\n';
  let manager;
  let notifySpy;

  afterEach(() => {
    if (manager) manager.stop();
    manager = undefined;
  });

  function createManager() {
    const m = new NotificationManager(SETTINGS, { Notification: makeFakeNotification().Notification });
    notifySpy = vi.spyOn(m, "_notify");
    return m;
  }

  // Failure: a chunk that ends inside an event drops the event's fields before its blank line arrives, so the alert is lost.
  it.each(Array.from({ length: FRAME.length - 1 }, (_, i) => i + 1))(
    "keeps the alert when the frame is split after byte %i",
    async (split) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(makeChunkedSSEResponse([FRAME.slice(0, split), FRAME.slice(split)])),
      );
      manager = createManager();
      manager.running = true;
      await manager._connect(manager.generation);

      expect(notifySpy.mock.calls).toEqual([["Attention Needed", "ws requires your input"]]);
    },
  );

  // Failure: a frame that arrives whole stops alerting when the split handling changes.
  it("keeps the alert when the frame arrives in one chunk", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeChunkedSSEResponse([FRAME])));
    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "ws requires your input"]]);
  });

  // Failure: an unfinished event from one connection fires when the next connection's blank line arrives, so a reconnect raises an alert nobody sent.
  it("does not carry an unfinished event into a new connection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeChunkedSSEResponse([FRAME.slice(0, -1)]))
      .mockResolvedValueOnce(makeChunkedSSEResponse(["\n"]));
    vi.stubGlobal("fetch", fetchMock);
    manager = createManager();
    manager.running = true;
    await manager._connect(manager.generation);
    await manager._connect(manager.generation);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(notifySpy.mock.calls).toEqual([]);
  });
});

describe("NotificationManager notification content", () => {
  let manager;
  let fake;

  beforeEach(() => {
    fake = makeFakeNotification();
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });
  });

  afterEach(() => {
    manager.stop();
  });

  // Failure: an attention event shows a title or body the user cannot tell apart from other alerts.
  it("shows 'Turnstone: Attention Needed' with the workstream name", () => {
    manager._handleEvent("ws_state", '{"state":"attention","name":"my-ws"}');

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Attention Needed", body: "my-ws requires your input" },
    ]);
    expect(fake.shown.length).toEqual(1);
  });

  // Failure: an error event is shown under the attention title, so the user misses the failure.
  it("shows 'Turnstone: Error' with the workstream name", () => {
    manager._handleEvent("ws_state", '{"state":"error","name":"broken"}');

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Error", body: "broken encountered an error" },
    ]);
    expect(fake.shown.length).toEqual(1);
  });

  // Failure: a workstream with no name shows "undefined requires your input".
  it("falls back to ws_id when name is absent", () => {
    manager._handleEvent("ws_state", '{"state":"attention","ws_id":"abc123"}');

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Attention Needed", body: "abc123 requires your input" },
    ]);
  });

  // Failure: a workstream with neither name nor ws_id shows a blank subject.
  it("falls back to 'Workstream' when neither name nor ws_id is set", () => {
    manager._handleEvent("ws_state", '{"state":"error"}');

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Error", body: "Workstream encountered an error" },
    ]);
  });

  // Failure: an empty name string blocks the ws_id fallback and shows " requires your input".
  it("treats an empty name as absent and uses ws_id", () => {
    manager._handleEvent("ws_state", '{"state":"attention","name":"","ws_id":"abc"}');

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Attention Needed", body: "abc requires your input" },
    ]);
  });

  // Failure: a cluster that needs attention stays silent because only ws_state is handled.
  it("notifies for cluster_state attention events", () => {
    manager._handleEvent("cluster_state", '{"state":"attention","name":"cluster-a"}');

    expect(fake.constructed).toEqual([
      { title: "Turnstone: Attention Needed", body: "cluster-a requires your input" },
    ]);
  });

  // Failure: non-attention, non-error states such as completed produce an alert.
  it("ignores states other than attention and error", () => {
    manager._handleEvent("ws_state", '{"state":"running","name":"a"}');
    manager._handleEvent("ws_state", '{"state":"idle","name":"b"}');
    manager._handleEvent("ws_state", '{"state":"completed","name":"c"}');

    expect(fake.constructed).toEqual([]);
  });

  // Failure: an unrelated event type with an attention state raises an alert.
  it("ignores event types other than ws_state and cluster_state", () => {
    manager._handleEvent("heartbeat", '{"state":"attention","name":"a"}');

    expect(fake.constructed).toEqual([]);
  });

  // Failure: a malformed payload throws out of the handler instead of being ignored.
  it("ignores malformed JSON without constructing a notification", () => {
    manager._handleEvent("ws_state", "not-json");

    expect(fake.constructed).toEqual([]);
  });

  // Failure: on a platform without notification support the app builds one anyway and crashes.
  it("does not construct a notification when isSupported() is false", () => {
    const unsupported = makeFakeNotification({ supported: false });
    manager = new NotificationManager(SETTINGS, { Notification: unsupported.Notification });

    manager._handleEvent("ws_state", '{"state":"attention","name":"a"}');
    manager._handleEvent("ws_state", '{"state":"error","name":"b"}');

    expect(unsupported.constructed).toEqual([]);
    expect(unsupported.shown).toEqual([]);
  });
});

describe("NotificationManager reconnect and stop", () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (manager) manager.stop();
    manager = undefined;
    vi.useRealTimers();
  });

  // Failure: a server that stays down is retried in a tight loop, or the delay never caps and the app goes silent for hours.
  it("doubles the retry delay after each failed connect and caps it at 30 seconds", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect refused"));
    vi.stubGlobal("fetch", fetchMock);
    manager = new NotificationManager(SETTINGS, { Notification: makeFakeNotification().Notification });

    manager.start();
    const attemptsAt = [fetchMock.mock.calls.length];
    // Attempt times with a 1 s start, doubling, capped at 30 s: 0, 1000, 3000, 7000, 15000, 31000, 61000.
    await vi.advanceTimersByTimeAsync(1000);
    attemptsAt.push(fetchMock.mock.calls.length);
    await vi.advanceTimersByTimeAsync(2000);
    attemptsAt.push(fetchMock.mock.calls.length);
    await vi.advanceTimersByTimeAsync(4000);
    attemptsAt.push(fetchMock.mock.calls.length);
    await vi.advanceTimersByTimeAsync(8000);
    attemptsAt.push(fetchMock.mock.calls.length);
    await vi.advanceTimersByTimeAsync(16000);
    attemptsAt.push(fetchMock.mock.calls.length);
    await vi.advanceTimersByTimeAsync(30000);
    attemptsAt.push(fetchMock.mock.calls.length);

    expect(attemptsAt).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  // Failure: stop() on quit leaves a request open or a reconnect timer that reopens the stream.
  it("stop() aborts the in-flight request and cancels the pending reconnect", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect refused"));
    vi.stubGlobal("fetch", fetchMock);
    manager = new NotificationManager(SETTINGS, { Notification: makeFakeNotification().Notification });

    manager.start();
    const signal = fetchMock.mock.calls[0][1].signal;
    manager.stop();
    await vi.advanceTimersByTimeAsync(60000);

    expect(signal.aborted).toEqual(true);
    expect(fetchMock.mock.calls.length).toEqual(1);
  });

  // Failure: a non-2xx answer is read as an event stream, so an error page raises alerts or the retry never happens.
  it("treats a non-2xx response as a failed connect and retries", async () => {
    const bad = makeSSEResponse(`event: ws_state
data: {"state":"attention","name":"x"}

`);
    bad.ok = false;
    bad.status = 500;
    const fetchMock = vi.fn().mockResolvedValue(bad);
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeNotification();
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fake.shown).toEqual([]);
    expect(fetchMock.mock.calls.length).toEqual(2);
  });

  // Failure: after a good connection the delay stays at its old backed-off value, so a later drop waits far too long.
  it("resets the retry delay to one second after a successful connect", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(makeSSEResponse(""))
      .mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    manager = new NotificationManager(SETTINGS, { Notification: makeFakeNotification().Notification });

    manager.start();
    // Attempts at 0 (fail, wait 1 s), 1000 (fail, wait 2 s), 3000 (connects, stream ends).
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock.mock.calls.length).toEqual(3);
    // With the reset the next attempt is 1 s later; without it, 4 s later.
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock.mock.calls.length).toEqual(4);
  });
});

describe("NotificationManager connection lifecycle", () => {
  let manager;
  let fake;

  const ATTENTION = `event: ws_state\ndata: {"state":"attention","name":"ws"}\n\n`;

  // With failFirst the first connect fails, so a retry is pending. Every other
  // connect opens a stream the test controls.
  function stubStreamingFetch({ failFirst = false } = {}) {
    const connections = [];
    const fetchMock = vi.fn();
    if (failFirst) fetchMock.mockRejectedValueOnce(new Error("connect refused"));
    fetchMock.mockImplementation((url, { signal }) => {
      const conn = controlledStream(signal);
      connections.push(conn);
      return Promise.resolve(conn.response);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, connections };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fake = makeFakeNotification();
  });

  afterEach(() => {
    if (manager) manager.stop();
    manager = undefined;
    vi.useRealTimers();
  });

  // Failure: a save that restarts notifications while a retry is pending starts a second loop, and two streams stay open.
  it("does not open a second connection when a restart runs while a retry is pending", async () => {
    const { fetchMock } = stubStreamingFetch({ failFirst: true });
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    manager.stop();
    manager.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock.mock.calls.length).toEqual(2);
    expect(liveConnections(fetchMock)).toEqual(1);
  });

  // Failure: after a restart and a stop, a stream left from the earlier loop still raises server alerts in a mode with no server.
  it("delivers no alert from any connection after a restart and a stop", async () => {
    const { connections } = stubStreamingFetch({ failFirst: true });
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    manager.stop();
    manager.start();
    await vi.advanceTimersByTimeAsync(1000);
    manager.stop();
    expect(connections.length).toEqual(1);
    for (const conn of connections) conn.push(ATTENTION);
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.constructed).toEqual([]);
  });

  // Failure: calling start() twice runs two loops, and a later stop() reaches only the newer one.
  it("keeps one live connection when start() is called twice", async () => {
    const { fetchMock } = stubStreamingFetch();
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    manager.start();

    expect(liveConnections(fetchMock)).toEqual(1);
  });

  // Failure: an event read just before stop() runs notifies after the user has switched to a mode with no server.
  it("drops an event that was already read when stop() ran", async () => {
    const { connections } = stubStreamingFetch();
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    connections[0].push(ATTENTION);
    manager.stop();
    // The save handler restarts right after a stop, so a check on running alone would pass here.
    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.constructed).toEqual([]);
  });

  // Failure: the manager dials a URL fixed when it was built, so a URL edit that restarts it still reaches the old server.
  it("dials the server URL the settings hold when it connects", async () => {
    const { fetchMock } = stubStreamingFetch();
    const settings = { serverUrl: "http://old.example" };
    manager = new NotificationManager(settings, { Notification: fake.Notification });

    settings.serverUrl = "http://new.example";
    manager.start();

    expect(fetchMock.mock.calls[0][0]).toEqual("http://new.example/v1/api/events/global");
  });

  // Failure: stop() leaves the retry timer armed, so it fires later and reopens a connection the user turned off.
  it("cancels a pending retry timer when stop() runs", async () => {
    stubStreamingFetch({ failFirst: true });
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    manager.stop();

    expect(vi.getTimerCount()).toEqual(0);
  });

  // Failure: a stream from before a restart that ends on its own queues a retry, so the old loop comes back beside the new one.
  it("schedules no retry when a stale stream ends after a restart", async () => {
    const { connections } = stubStreamingFetch();
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    connections[0].close();
    manager.stop();
    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toEqual(0);
  });

  // Failure: a connect left over from before a stop opens a connection that stop() can no longer reach.
  it("opens nothing for a connect started under an earlier generation", async () => {
    const { fetchMock } = stubStreamingFetch();
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    const stale = manager.generation;
    manager.stop();
    manager.start();
    const before = fetchMock.mock.calls.length;
    await manager._connect(stale);

    expect(fetchMock.mock.calls.length).toEqual(before);
  });

  // Failure: a restart after a long outage waits out the old 30 s backoff before it tries again.
  it("retries one second after a restart, not after the backoff the old loop built up", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect refused"));
    vi.stubGlobal("fetch", fetchMock);
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    await vi.advanceTimersByTimeAsync(15000);
    manager.stop();
    manager.start();
    const afterRestart = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock.mock.calls.length - afterRestart).toEqual(1);
  });

  // Failure: a connect from before a restart that answers late resets the backoff the live loop is using, so its next retry comes too soon.
  it("leaves the live backoff alone when a stale connect answers late", async () => {
    let answerFirst;
    const late = new Promise((resolve) => {
      answerFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(late)
      .mockRejectedValueOnce(new Error("connect refused"));
    vi.stubGlobal("fetch", fetchMock);
    manager = new NotificationManager(SETTINGS, { Notification: fake.Notification });

    manager.start();
    manager.stop();
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.retryDelay).toEqual(2000);

    answerFirst(makeSSEResponse(""));
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.retryDelay).toEqual(2000);
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
