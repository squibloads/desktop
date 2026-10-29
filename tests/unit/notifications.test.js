import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// notifications.js does not load electron, so this file runs under plain Node.
// The Notification class is injected, which keeps the electron package and its
// binary out of every test here.
const { NotificationManager } = require("../../src/main/notifications.js");

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
    await manager._connect();

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "my-ws requires your input"]]);
  });

  // Failure: a workstream that errors out raises no alert.
  it("calls _notify on error event", async () => {
    const sse = `event: ws_state\ndata: {"state":"error","name":"broken"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy.mock.calls).toEqual([["Error", "broken encountered an error"]]);
  });

  // Failure: routine running or idle transitions notify the user and bury real alerts.
  it("ignores running/idle states", async () => {
    const sse = `event: ws_state\ndata: {"state":"running","name":"ws1"}\n\nevent: ws_state\ndata: {"state":"idle","name":"ws2"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy.mock.calls).toEqual([]);
  });

  // Failure: a data payload split over several data: lines is dropped, so the alert is lost.
  it("handles multi-line data fields per SSE spec", async () => {
    const sse = `event: ws_state\ndata: {"state":\ndata: "attention","name":"ws"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "ws requires your input"]]);
  });

  // Failure: a corrupt SSE frame throws out of the read loop and kills the stream.
  it("ignores malformed JSON", async () => {
    const sse = `event: ws_state\ndata: not-json\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy.mock.calls).toEqual([]);
  });

  // Failure: an event with only a ws_id produces an alert with no workstream name.
  it("uses ws_id as fallback name", async () => {
    const sse = `event: ws_state\ndata: {"state":"attention","ws_id":"abc123"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy.mock.calls).toEqual([["Attention Needed", "abc123 requires your input"]]);
  });

  // Failure: heartbeat or connected events are treated as workstream state and notify.
  it("ignores unrelated event types", async () => {
    const sse = `event: heartbeat\ndata: {}\n\nevent: connected\ndata: {"model":"test"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

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
