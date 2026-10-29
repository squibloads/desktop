import { describe, it, expect, vi } from "vitest";

const { LocalRuntime, LocalRuntimeError } = require("./local-runtime.js");

/**
 * Scripted podman: each entry maps a joined argv to a result. An unscripted
 * call fails the test loudly so a new CLI call can never slip in unreviewed.
 */
function makeRunner(script) {
  const calls = [];
  const run = vi.fn(async (args) => {
    const key = args.join(" ");
    calls.push(key);
    if (!(key in script)) throw new Error(`unscripted podman call: ${key}`);
    const out = script[key];
    if (out instanceof Error) throw out;
    return out;
  });
  return { run, calls };
}

const MACHINE_LIST = "machine list --format json";
const POD_STATE = "--connection turnstone pod inspect turnstone --format {{.State}}";

function machines(running) {
  return JSON.stringify([{ Name: "turnstone", Running: running }]);
}

function make(script, opts = {}) {
  const runner = makeRunner(script);
  const checkHealth = opts.checkHealth || vi.fn(async () => "ok");
  const rt = new LocalRuntime({
    run: runner.run,
    checkHealth,
    sleep: opts.sleep || (async () => {}),
    healthTimeoutMs: opts.healthTimeoutMs ?? 3,
    healthIntervalMs: 1,
    healthUrl: "http://127.0.0.1:8090",
  });
  return { rt, calls: runner.calls, checkHealth };
}

describe("LocalRuntime.start", () => {
  it("starts a stopped machine, then the pod, then waits for health", async () => {
    const { rt, calls, checkHealth } = make({
      [MACHINE_LIST]: machines(false),
      "machine start turnstone": "",
      [POD_STATE]: "Exited",
      "--connection turnstone pod start turnstone": "",
    });
    await rt.start();
    expect(calls).toEqual([
      MACHINE_LIST,
      "machine start turnstone",
      POD_STATE,
      "--connection turnstone pod start turnstone",
    ]);
    expect(checkHealth).toHaveBeenCalledWith("http://127.0.0.1:8090");
  });

  it("skips machine start when it is already running", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Exited",
      "--connection turnstone pod start turnstone": "",
    });
    await rt.start();
    expect(calls).not.toContain("machine start turnstone");
  });

  it("skips pod start when the pod is already running", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Running",
    });
    await rt.start();
    expect(calls).toEqual([MACHINE_LIST, POD_STATE]);
  });

  it("reports PODMAN_NOT_FOUND when the binary is missing", async () => {
    const enoent = Object.assign(new Error("spawn podman ENOENT"), {
      code: "ENOENT",
    });
    const { rt } = make({ [MACHINE_LIST]: enoent });
    await expect(rt.start()).rejects.toMatchObject({ code: "PODMAN_NOT_FOUND" });
  });

  it("reports MACHINE_MISSING when no turnstone machine exists", async () => {
    const { rt } = make({
      [MACHINE_LIST]: JSON.stringify([{ Name: "other", Running: true }]),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_MISSING" });
  });

  it("treats unparseable machine list output as an error, not as empty", async () => {
    const { rt } = make({ [MACHINE_LIST]: "not json" });
    await expect(rt.start()).rejects.toMatchObject({
      code: "MACHINE_LIST_FAILED",
    });
  });

  it("reports MACHINE_START_FAILED with the podman stderr", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(false),
      "machine start turnstone": new Error("wsl exploded"),
    });
    const err = await rt.start().catch((e) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    expect(err.code).toBe("MACHINE_START_FAILED");
    expect(err.detail).toContain("wsl exploded");
  });

  it("reports POD_START_FAILED when the pod will not start", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Exited",
      "--connection turnstone pod start turnstone": new Error("conmon"),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_START_FAILED" });
  });

  it("reports POD_MISSING when the pod does not exist", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: new Error("no such pod turnstone"),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
  });

  it("reports HEALTH_TIMEOUT when the console never becomes healthy", async () => {
    const { rt, checkHealth } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { checkHealth: vi.fn(async () => "disconnected") },
    );
    await expect(rt.start()).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    expect(checkHealth.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps polling past a degraded status until ok", async () => {
    const statuses = ["disconnected", "degraded", "ok"];
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { checkHealth: vi.fn(async () => statuses.shift()), healthTimeoutMs: 50 },
    );
    await rt.start();
    expect(statuses).toEqual([]);
  });
});

describe("LocalRuntime.stop", () => {
  it("stops the pod with pod stop, never restart", async () => {
    const { rt, calls } = make({ "--connection turnstone pod stop turnstone": "" });
    await rt.stop();
    expect(calls).toEqual(["--connection turnstone pod stop turnstone"]);
  });

  it("surfaces a failed stop as POD_STOP_FAILED", async () => {
    const { rt } = make({ "--connection turnstone pod stop turnstone": new Error("busy") });
    await expect(rt.stop()).rejects.toMatchObject({ code: "POD_STOP_FAILED" });
  });
});

describe("LocalRuntime.start overlap guard", () => {
  it("returns the in-flight promise to an overlapping call", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Running",
    });
    const first = rt.start();
    const second = rt.start();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(calls.filter((c) => c === MACHINE_LIST)).toHaveLength(1);
  });

  it("runs again after a failed start settles", async () => {
    const script = {
      [MACHINE_LIST]: new Error("podman busy"),
      [POD_STATE]: "Running",
    };
    const runner = makeRunner(script);
    const rt = new LocalRuntime({
      run: runner.run,
      checkHealth: vi.fn(async () => "ok"),
      sleep: async () => {},
      healthTimeoutMs: 3,
      healthIntervalMs: 1,
    });
    await expect(rt.start()).rejects.toMatchObject({
      code: "MACHINE_LIST_FAILED",
    });
    script[MACHINE_LIST] = machines(true);
    await rt.start();
    expect(runner.calls.filter((c) => c === MACHINE_LIST)).toHaveLength(2);
  });
});

describe("LocalRuntime.started", () => {
  it("is false before any start", () => {
    expect(make({}).rt.started).toBe(false);
  });

  it("stays false when the machine check fails", async () => {
    const { rt } = make({ [MACHINE_LIST]: new Error("no podman") });
    await rt.start().catch(() => {});
    expect(rt.started).toBe(false);
  });

  it("stays false when the turnstone machine is missing", async () => {
    const { rt } = make({ [MACHINE_LIST]: JSON.stringify([]) });
    await rt.start().catch(() => {});
    expect(rt.started).toBe(false);
  });

  it("becomes true once a pod call succeeds past the machine check", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Running",
    });
    await rt.start();
    expect(rt.started).toBe(true);
  });
});

describe("LocalRuntimeError messages", () => {
  it.each([
    "PODMAN_NOT_FOUND",
    "MACHINE_MISSING",
    "MACHINE_LIST_FAILED",
    "MACHINE_START_FAILED",
    "POD_MISSING",
    "POD_START_FAILED",
    "POD_STOP_FAILED",
    "HEALTH_TIMEOUT",
  ])("%s has its own user-facing message", (code) => {
    const msgs = new Set();
    const e = new LocalRuntimeError(code, "x");
    expect(e.userMessage).toBeTruthy();
    msgs.add(e.userMessage);
    expect(e.userMessage).not.toBe(
      new LocalRuntimeError("PODMAN_NOT_FOUND" === code ? "HEALTH_TIMEOUT" : "PODMAN_NOT_FOUND", "x").userMessage,
    );
  });
});

describe("LocalRuntime stop and started semantics", () => {
  it("stop waits for an in-flight pod start before issuing pod stop", async () => {
    let releasePodStart;
    const gate = new Promise((r) => (releasePodStart = r));
    const calls = [];
    const STOP = "--connection turnstone pod stop turnstone";
    const run = vi.fn(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === MACHINE_LIST) return machines(true);
      if (key === POD_STATE) return "Exited";
      if (key === "--connection turnstone pod start turnstone") {
        await gate;
        return "";
      }
      if (key === STOP) return "";
      throw new Error(`unscripted podman call: ${key}`);
    });
    const rt = new LocalRuntime({ run, checkHealth: async () => "ok", sleep: async () => {} });
    const startErr = rt.start().catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    const stopping = rt.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).not.toContain(STOP);
    releasePodStart();
    await stopping;
    await startErr;
    expect(calls[calls.length - 1]).toBe(STOP);
  });

  it("started is true even when pod start then fails, so quit still stops it", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Exited",
      "--connection turnstone pod start turnstone": new Error("conmon"),
    });
    await rt.start().catch(() => {});
    expect(rt.started).toBe(true);
  });
});

describe("LocalRuntime cancellation", () => {
  const STOP = "--connection turnstone pod stop turnstone";

  it("is active while pod inspection is still pending, before started is set", async () => {
    let releaseInspect;
    const gate = new Promise((r) => (releaseInspect = r));
    const run = vi.fn(async (args) => {
      const key = args.join(" ");
      if (key === MACHINE_LIST) return machines(true);
      if (key === POD_STATE) {
        await gate;
        return "Running";
      }
      throw new Error(`unscripted podman call: ${key}`);
    });
    const rt = new LocalRuntime({
      run,
      checkHealth: async () => "ok",
      sleep: async () => {},
    });
    expect(rt.active).toBe(false);
    const starting = rt.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.started).toBe(false);
    expect(rt.active).toBe(true);
    releaseInspect();
    await starting;
    expect(rt.active).toBe(true);
  });

  it("stop ends health polling promptly instead of waiting out the timeout", async () => {
    const { rt, calls } = make(
      {
        [MACHINE_LIST]: machines(true),
        [POD_STATE]: "Running",
        [STOP]: "",
      },
      {
        checkHealth: vi.fn(async () => "disconnected"),
        // Real timer so the loop yields to the event loop (a no-op sleep
        // would starve the stop() call this test issues).
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        healthTimeoutMs: 60 * 60 * 1000,
      },
    );
    const starting = rt.start();
    const startErr = starting.catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    await rt.stop();
    expect(await startErr).toMatchObject({ code: "START_CANCELLED" });
    expect(calls[calls.length - 1]).toBe(STOP);
  });

  it("a stop requested before pod start skips pod start", async () => {
    let releaseMachine;
    const gate = new Promise((r) => (releaseMachine = r));
    const calls = [];
    const run = vi.fn(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === MACHINE_LIST) return machines(false);
      if (key === "machine start turnstone") {
        await gate;
        return "";
      }
      if (key === POD_STATE) return "Exited";
      if (key === STOP) return "";
      throw new Error(`unscripted podman call: ${key}`);
    });
    const rt = new LocalRuntime({ run, checkHealth: async () => "ok", sleep: async () => {} });
    const startErr = rt.start().catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    const stopping = rt.stop();
    releaseMachine();
    await stopping;
    expect(await startErr).toMatchObject({ code: "START_CANCELLED" });
    expect(calls).not.toContain("--connection turnstone pod start turnstone");
  });

  it("a start after a stop runs normally again", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Running",
      [STOP]: "",
    });
    await rt.stop();
    await expect(rt.start()).resolves.toBeUndefined();
  });
});
