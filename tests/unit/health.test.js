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
