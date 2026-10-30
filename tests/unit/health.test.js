import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Import the module under test
const { HealthPoller } = require("../../src/main/health.js");

describe("HealthPoller", () => {
  let poller;
  let onUpdate;

  beforeEach(() => {
    vi.useFakeTimers();
    onUpdate = vi.fn();
  });

  afterEach(() => {
    if (poller) poller.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeSettings(overrides = {}) {
    return {
      serverUrl: "http://localhost:8080",
      consoleUrl: "http://localhost:8090",
      hasServer: true,
      hasConsole: true,
      ...overrides,
    };
  }

  // Failure: a refused address is polled over plain http anyway, or it reads as switched off and the fault stays hidden.
  it("reports a refused address as refused and never polls it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    poller = new HealthPoller(
      makeSettings({ hasServer: false, serverRefused: true, serverUrl: "http://192.168.1.20:8080", hasConsole: false }),
      onUpdate,
    );

    await poller.poll();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(poller.status.server).toBe("refused");
    vi.unstubAllGlobals();
  });

  // Failure: a server's redirect is followed to another origin, so the health check travels over plain http to the target.
  it("does not follow a redirect, and reports it as not healthy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate);

    await poller.poll();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(poller.status.server).not.toBe("ok");
    vi.unstubAllGlobals();
  });

  // Failure: a redirect's body is never read or cancelled, so each poll leaves its connection open until garbage collection.
  it("cancels the body of a redirect response, so its connection is released", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302, body: { cancel } });
    vi.stubGlobal("fetch", fetchMock);
    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate);

    await poller.poll();

    expect(cancel).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  // Failure: the answer is reported before the body is cancelled, so the next poll can start while this connection is still open.
  it("reports the answer only once the body is cancelled", async () => {
    let finishCancel;
    const cancel = vi.fn(() => new Promise((resolve) => {
      finishCancel = resolve;
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 302, body: { cancel } }));
    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate);

    const polling = poller.poll();
    await vi.advanceTimersByTimeAsync(0);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(poller.status.server).toBe("unknown");

    finishCancel();
    await polling;
    expect(poller.status.server).toBe("error");
    vi.unstubAllGlobals();
  });

  it("polls both servers when both enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    poller = new HealthPoller(makeSettings(), onUpdate);
    await poller.poll();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/health",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8090/health",
      expect.any(Object),
    );
  });

  it("skips disabled servers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate);
    await poller.poll();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/health",
      expect.any(Object),
    );
    expect(onUpdate).toHaveBeenCalledWith(
      { server: "ok", console: "disabled" },
      { server: "unknown", console: "unknown" },
    );
  });

  it("reports disconnected on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    poller = new HealthPoller(makeSettings(), onUpdate);
    await poller.poll();

    expect(onUpdate).toHaveBeenCalledWith(
      { server: "disconnected", console: "disconnected" },
      { server: "unknown", console: "unknown" },
    );
  });

  it("reports error on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    poller = new HealthPoller(makeSettings(), onUpdate);
    await poller.poll();

    expect(onUpdate).toHaveBeenCalledWith(
      { server: "error", console: "error" },
      { server: "unknown", console: "unknown" },
    );
  });

  it("reports degraded when health status is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "degraded" }),
      }),
    );

    poller = new HealthPoller(makeSettings(), onUpdate);
    await poller.poll();

    expect(onUpdate).toHaveBeenCalledWith(
      { server: "degraded", console: "degraded" },
      { server: "unknown", console: "unknown" },
    );
  });

  it("does not fire onUpdate when status unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok" }),
      }),
    );

    poller = new HealthPoller(makeSettings(), onUpdate);
    await poller.poll();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await poller.poll();
    expect(onUpdate).toHaveBeenCalledTimes(1); // no change, no call
  });

  it("fires onUpdate on state transition", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: "ok" }),
          });
        }
        return Promise.reject(new Error("down"));
      }),
    );

    poller = new HealthPoller(makeSettings(), onUpdate);
    await poller.poll(); // ok -> fires
    await poller.poll(); // still ok -> no fire
    await poller.poll(); // disconnected -> fires

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith(
      { server: "disconnected", console: "disconnected" },
      { server: "ok", console: "ok" },
    );
  });
});
