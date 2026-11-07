import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Import the module under test
const { HealthPoller } = require("../../src/main/health.js");

// The poller's own fetch goes through Electron's network stack, which these Node tests do not have.
// The tests stub the global fetch, and each poller is given a fetch that calls it.
const viaGlobalFetch = (url, init) => fetch(url, init);

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
      { fetch: viaGlobalFetch },
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
    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate, { fetch: viaGlobalFetch });

    await poller.poll();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(poller.status.server).not.toBe("ok");
    vi.unstubAllGlobals();
  });

  // Failure: a non-OK answer's body is only cancelled, which under Electron's fetch leaves its connection open until
  // the three-second timeout aborts the request.
  it("aborts the request of a non-OK answer before it reports the answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302, body: {} });
    vi.stubGlobal("fetch", fetchMock);
    let abortedWhenReported = null;
    onUpdate = vi.fn(() => {
      abortedWhenReported = fetchMock.mock.calls[0][1].signal.aborted;
    });
    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate, { fetch: viaGlobalFetch });

    await poller.poll();

    expect(poller.status.server).toBe("error");
    expect(abortedWhenReported).toBe(true);
    vi.unstubAllGlobals();
  });

  it("polls both servers when both enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    poller = new HealthPoller(makeSettings(), onUpdate, { fetch: viaGlobalFetch });
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

    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate, { fetch: viaGlobalFetch });
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

  // Failure: Electron's fetch fails a redirect it does not follow, so a server that answers with a redirect reads as disconnected, as if it were down.
  it("reports a refused redirect as an error, not as disconnected", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Redirect was cancelled"));
    poller = new HealthPoller(makeSettings({ hasConsole: false }), onUpdate, { fetch: fetchMock });

    await poller.poll();

    expect(poller.status.server).toBe("error");
  });

  it("reports disconnected on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    poller = new HealthPoller(makeSettings(), onUpdate, { fetch: viaGlobalFetch });
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

    poller = new HealthPoller(makeSettings(), onUpdate, { fetch: viaGlobalFetch });
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

    poller = new HealthPoller(makeSettings(), onUpdate, { fetch: viaGlobalFetch });
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

    poller = new HealthPoller(makeSettings(), onUpdate, { fetch: viaGlobalFetch });
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

    poller = new HealthPoller(makeSettings(), onUpdate, { fetch: viaGlobalFetch });
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
