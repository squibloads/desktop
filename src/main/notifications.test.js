import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("NotificationManager SSE parser", () => {
  // Test the SSE parsing logic by invoking _connect with mock fetch,
  // and spying on _handleEvent and _notify directly

  let manager;
  let notifySpy;

  beforeEach(() => {
    // Require with electron mocked just enough to not crash on load
    vi.mock("electron", () => ({
      Notification: Object.assign(
        function () {
          this.show = () => {};
        },
        {
          isSupported: () => true,
        },
      ),
    }));
  });

  afterEach(() => {
    if (manager) manager.stop();
    vi.restoreAllMocks();
  });

  function createManager() {
    const { NotificationManager } = require("./notifications.js");
    const m = new NotificationManager({ serverUrl: "http://localhost:8080" });
    // Spy on _notify to verify what notifications would fire
    notifySpy = vi.spyOn(m, "_notify");
    return m;
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

  it("calls _notify on attention event", async () => {
    const sse = `event: ws_state\ndata: {"state":"attention","name":"my-ws"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).toHaveBeenCalledWith(
      "Attention Needed",
      "my-ws requires your input",
    );
  });

  it("calls _notify on error event", async () => {
    const sse = `event: ws_state\ndata: {"state":"error","name":"broken"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).toHaveBeenCalledWith(
      "Error",
      "broken encountered an error",
    );
  });

  it("ignores running/idle states", async () => {
    const sse = `event: ws_state\ndata: {"state":"running","name":"ws1"}\n\nevent: ws_state\ndata: {"state":"idle","name":"ws2"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("handles multi-line data fields per SSE spec", async () => {
    const sse = `event: ws_state\ndata: {"state":\ndata: "attention","name":"ws"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).toHaveBeenCalledWith(
      "Attention Needed",
      "ws requires your input",
    );
  });

  it("ignores malformed JSON", async () => {
    const sse = `event: ws_state\ndata: not-json\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("uses ws_id as fallback name", async () => {
    const sse = `event: ws_state\ndata: {"state":"attention","ws_id":"abc123"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).toHaveBeenCalledWith(
      "Attention Needed",
      "abc123 requires your input",
    );
  });

  it("ignores unrelated event types", async () => {
    const sse = `event: heartbeat\ndata: {}\n\nevent: connected\ndata: {"model":"test"}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSSEResponse(sse)));

    manager = createManager();
    manager.running = true;
    await manager._connect();

    expect(notifySpy).not.toHaveBeenCalled();
  });
});
