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
    sleep: async () => {},
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
  it("stop waits for an in-flight start before issuing pod stop", async () => {
    let releaseHealth;
    const gate = new Promise((r) => (releaseHealth = r));
    const { rt, calls } = make(
      {
        [MACHINE_LIST]: machines(true),
        [POD_STATE]: "Running",
        "--connection turnstone pod stop turnstone": "",
      },
      { checkHealth: vi.fn(async () => (await gate, "ok")) },
    );
    const starting = rt.start();
    await Promise.resolve();
    const stopping = rt.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).not.toContain("--connection turnstone pod stop turnstone");
    releaseHealth();
    await starting;
    await stopping;
    expect(calls[calls.length - 1]).toBe(
      "--connection turnstone pod stop turnstone",
    );
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
