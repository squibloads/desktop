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
const POD_STATE = "pod inspect turnstone --format {{.State}}";

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
      "pod start turnstone": "",
    });
    await rt.start();
    expect(calls).toEqual([
      MACHINE_LIST,
      "machine start turnstone",
      POD_STATE,
      "pod start turnstone",
    ]);
    expect(checkHealth).toHaveBeenCalledWith("http://127.0.0.1:8090");
  });

  it("skips machine start when it is already running", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Exited",
      "pod start turnstone": "",
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
      "pod start turnstone": new Error("conmon"),
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
    const { rt, calls } = make({ "pod stop turnstone": "" });
    await rt.stop();
    expect(calls).toEqual(["pod stop turnstone"]);
  });

  it("surfaces a failed stop as POD_STOP_FAILED", async () => {
    const { rt } = make({ "pod stop turnstone": new Error("busy") });
    await expect(rt.stop()).rejects.toMatchObject({ code: "POD_STOP_FAILED" });
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
