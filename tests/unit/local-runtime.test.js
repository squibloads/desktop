import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSteppedClock } from "../helpers/fake-clock.js";
import { fakeElectronNet, removeFakeElectron } from "../helpers/fake-electron-net.js";

const { LocalRuntime, LocalRuntimeError, fetchHealthJson, HEALTH_REDIRECTED } = require("../../src/main/local-runtime.js");

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

// Whether podman was invoked with this command; a barrier waits on it.
function calledWith(run, key) {
  return run.mock.calls.some(([args]) => args.join(" ") === key);
}

const MACHINE_LIST = "machine list --format json";
const POD_STATE = "--connection turnstone pod inspect turnstone --format {{.State}}";
const STOP = "--connection turnstone pod stop turnstone";
const POD_START = "--connection turnstone pod start turnstone";
const HEALTH_URL = "http://127.0.0.1:8090";
const READY = { status: "ok", nodes: 1 };

function machines(running) {
  return JSON.stringify([{ Name: "turnstone", Running: running }]);
}

/** Returns each item in order, then keeps returning the last one. */
function healthSequence(...items) {
  const queue = [...items];
  return vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]));
}

function make(script, opts = {}) {
  // Deadlines read Date.now(), so the clock is stepped: each timeout counts
  // polls, not wall time. Pass `step` to change the cost of one read.
  installSteppedClock({ step: opts.step ?? 1 });
  const runner = makeRunner(script);
  const fetchHealth = opts.fetchHealth || vi.fn(async () => READY);
  const rt = new LocalRuntime({
    run: runner.run,
    fetchHealth,
    sleep: opts.sleep || (async () => {}),
    healthTimeoutMs: opts.healthTimeoutMs ?? 3,
    nodeTimeoutMs: opts.nodeTimeoutMs ?? 3,
    healthIntervalMs: 1,
    healthUrl: HEALTH_URL,
    onProgress: opts.onProgress,
  });
  return { rt, calls: runner.calls, fetchHealth };
}

describe("LocalRuntime.start", () => {
  it("starts a stopped machine, then the pod, then waits for health", async () => {
    const { rt, calls, fetchHealth } = make({
      [MACHINE_LIST]: machines(false),
      "machine start turnstone": "",
      [POD_STATE]: "Exited",
      [POD_START]: "",
    });
    await rt.start();
    expect(calls).toEqual([
      MACHINE_LIST,
      "machine start turnstone",
      POD_STATE,
      POD_START,
    ]);
    expect(fetchHealth).toHaveBeenCalledWith(HEALTH_URL);
  });

  it("skips machine start when it is already running", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [POD_STATE]: "Exited",
      [POD_START]: "",
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
      [POD_START]: new Error("conmon"),
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

  it("reports HEALTH_TIMEOUT when the console is never reachable", async () => {
    const { rt, fetchHealth } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { fetchHealth: vi.fn(async () => null) },
    );
    await expect(rt.start()).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    // Deadline of 3 reads at 1 per read: three polls.
    expect(fetchHealth).toHaveBeenCalledTimes(3);
  });

  it("keeps polling the console past a degraded status until ok, then waits for the node", async () => {
    const fetchHealth = healthSequence(
      null,
      { status: "degraded", nodes: 1 },
      { status: "ok", nodes: 1 },
    );
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { fetchHealth, healthTimeoutMs: 50 },
    );
    await rt.start();
    // Three console polls, then one node-stage poll that sees nodes=1.
    expect(fetchHealth).toHaveBeenCalledTimes(4);
  });
});

describe("LocalRuntime node stage", () => {
  it("keeps polling until nodes reports 1, then resolves", async () => {
    const fetchHealth = healthSequence(
      { status: "ok", nodes: 0 },
      { status: "ok", nodes: 0 },
      { status: "ok", nodes: 1 },
    );
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      // The clock is stepped (see make()), so these bounds count polls.
      { fetchHealth, healthTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await expect(rt.start()).resolves.toBeUndefined();
    expect(fetchHealth).toHaveBeenCalledTimes(3);
  });

  it("reports the stages machine, pod, console, node in order", async () => {
    const stages = [];
    const { rt } = make(
      {
        [MACHINE_LIST]: machines(false),
        "machine start turnstone": "",
        [POD_STATE]: "Exited",
        [POD_START]: "",
      },
      { onProgress: (stage) => stages.push(stage) },
    );
    await rt.start();
    expect(stages).toEqual(["machine", "pod", "console", "node"]);
  });

  it("reports NODE_TIMEOUT when nodes stays 0, naming what was last seen", async () => {
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { fetchHealth: vi.fn(async () => ({ status: "ok", nodes: 0 })) },
    );
    const err = await rt.start().catch((e) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    expect(err.code).toBe("NODE_TIMEOUT");
    expect(err.detail).toContain("nodes=0");
  });

  it("keeps waiting when nodes is missing or non-numeric, then reports NODE_TIMEOUT", async () => {
    const fetchHealth = healthSequence(
      { status: "ok" },
      { status: "ok", nodes: "1" },
      { status: "ok", nodes: null },
    );
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      {
        fetchHealth,
        healthTimeoutMs: 1000,
        // Reads advance 10ms, so the 40ms node deadline is hit on the 4th node check.
        nodeTimeoutMs: 40,
        step: 10,
      },
    );
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("NODE_TIMEOUT");
    expect(err.detail).toContain("no numeric nodes field");
    // One console poll (status ok, nodes missing), then four node polls.
    expect(fetchHealth).toHaveBeenCalledTimes(5);
  });

  it("does not look at nodes until the console reports ok", async () => {
    const stages = [];
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      {
        fetchHealth: vi.fn(async () => ({ status: "degraded", nodes: 1 })),
        onProgress: (stage) => stages.push(stage),
      },
    );
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("HEALTH_TIMEOUT");
    expect(err.detail).toContain("status=degraded");
    expect(stages).not.toContain("node");
  });

  it("reports HEALTH_TIMEOUT as unreachable when the console does not answer", async () => {
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { fetchHealth: vi.fn(async () => null) },
    );
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("HEALTH_TIMEOUT");
    expect(err.detail).toContain("unreachable");
  });

  // Failure: a console that answers /health with a redirect times out as unreachable, while a browser opened on
  // /health, as the README's troubleshooting says, follows the redirect and shows it answering.
  it("reports HEALTH_TIMEOUT as a redirect when the console answers with one", async () => {
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { fetchHealth: vi.fn(async () => HEALTH_REDIRECTED) },
    );
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("HEALTH_TIMEOUT");
    expect(err.detail).toContain("console answered /health with a redirect, which is not followed");
  });

  it("stop() during the node wait cancels promptly instead of waiting out the timeout", async () => {
    const stages = [];
    const { rt, calls, fetchHealth } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running", [STOP]: "" },
      {
        fetchHealth: vi.fn(async () => ({ status: "ok", nodes: 0 })),
        // Real timer so the loop yields to the event loop (a no-op sleep
        // would starve the stop() call this test issues).
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        healthTimeoutMs: 60 * 60 * 1000,
        nodeTimeoutMs: 60 * 60 * 1000,
        onProgress: (stage) => stages.push(stage),
      },
    );
    const startErr = rt.start().catch((e) => e);
    await vi.waitFor(() => expect(stages).toContain("node"));
    // Read before stop(): the loop is confirmed running and nothing between
    // this read and stop() can poll, so this count is the baseline.
    const pollsAtStop = fetchHealth.mock.calls.length;
    const maxPolls = pollsAtStop + 1;
    await rt.stop();
    expect(await startErr).toMatchObject({ code: "START_CANCELLED" });
    // Start has settled, so the loop is finished and the count is final. Cancel
    // ends the loop: at most the one poll already in flight may follow stop().
    expect(fetchHealth.mock.calls.length).toBeLessThanOrEqual(maxPolls);
    expect(calls[calls.length - 1]).toBe(STOP);
  });

  it("a throwing onProgress callback does not break start", async () => {
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      {
        onProgress: () => {
          throw new Error("listener broke");
        },
      },
    );
    await expect(rt.start()).resolves.toBeUndefined();
  });
});

describe("LocalRuntime.stop", () => {
  it("stops the pod with pod stop, never restart", async () => {
    const { rt, calls } = make({ [STOP]: "" });
    await rt.stop();
    expect(calls).toEqual([STOP]);
  });

  it("surfaces a failed stop as POD_STOP_FAILED", async () => {
    const { rt } = make({ [STOP]: new Error("busy") });
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
      fetchHealth: vi.fn(async () => READY),
      sleep: async () => {},
      healthTimeoutMs: 3,
      nodeTimeoutMs: 3,
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

describe("LocalRuntime.starting", () => {
  it("is true only while a start is in flight", async () => {
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
      fetchHealth: async () => READY,
      sleep: async () => {},
    });
    expect(rt.starting).toBe(false);
    const starting = rt.start();
    await vi.waitFor(() => expect(calledWith(run, POD_STATE)).toBe(true));
    expect(rt.starting).toBe(true);
    releaseInspect();
    await starting;
    expect(rt.starting).toBe(false);
  });

  it("is false again after a failed start", async () => {
    const { rt } = make({ [MACHINE_LIST]: new Error("no podman") });
    await rt.start().catch(() => {});
    expect(rt.starting).toBe(false);
  });
});

describe("LocalRuntimeError messages", () => {
  const CODES = [
    "PODMAN_NOT_FOUND",
    "MACHINE_MISSING",
    "MACHINE_LIST_FAILED",
    "MACHINE_START_FAILED",
    "POD_MISSING",
    "POD_START_FAILED",
    "POD_STOP_FAILED",
    "HEALTH_TIMEOUT",
    "NODE_TIMEOUT",
  ];

  it.each(CODES)("%s has its own user-facing message", (code) => {
    const e = new LocalRuntimeError(code, "x");
    expect(e.userMessage).toBeTruthy();
    const others = CODES.filter((c) => c !== code).map(
      (c) => new LocalRuntimeError(c, "x").userMessage,
    );
    expect(others).not.toContain(e.userMessage);
  });

  it("NODE_TIMEOUT says the console is up and the node is not", () => {
    expect(new LocalRuntimeError("NODE_TIMEOUT", "x").userMessage).toBe(
      "Turnstone is running, but its node has not come online yet; opening the console anyway.",
    );
  });
});

describe("LocalRuntime stop and started semantics", () => {
  it("stop waits for an in-flight pod start before issuing pod stop", async () => {
    let releasePodStart;
    const gate = new Promise((r) => (releasePodStart = r));
    const calls = [];
    const run = vi.fn(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === MACHINE_LIST) return machines(true);
      if (key === POD_STATE) return "Exited";
      if (key === POD_START) {
        await gate;
        return "";
      }
      if (key === STOP) return "";
      throw new Error(`unscripted podman call: ${key}`);
    });
    const rt = new LocalRuntime({
      run,
      fetchHealth: async () => READY,
      sleep: async () => {},
    });
    const startErr = rt.start().catch((e) => e);
    await vi.waitFor(() => expect(calls).toContain(POD_START));
    const stopping = rt.stop();
    // The gate holds the start open, so this is a drain, not a race.
    await new Promise((r) => setImmediate(r));
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
      [POD_START]: new Error("conmon"),
    });
    await rt.start().catch(() => {});
    expect(rt.started).toBe(true);
  });
});

describe("LocalRuntime cancellation", () => {
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
      fetchHealth: async () => READY,
      sleep: async () => {},
    });
    expect(rt.active).toBe(false);
    const starting = rt.start();
    await vi.waitFor(() => expect(calledWith(run, POD_STATE)).toBe(true));
    expect(rt.started).toBe(false);
    expect(rt.active).toBe(true);
    releaseInspect();
    await starting;
    expect(rt.active).toBe(true);
  });

  it("stop ends console polling promptly instead of waiting out the timeout", async () => {
    const { rt, calls, fetchHealth } = make(
      {
        [MACHINE_LIST]: machines(true),
        [POD_STATE]: "Running",
        [STOP]: "",
      },
      {
        fetchHealth: vi.fn(async () => null),
        // Real timer so the loop yields to the event loop (a no-op sleep
        // would starve the stop() call this test issues).
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        healthTimeoutMs: 60 * 60 * 1000,
      },
    );
    const starting = rt.start();
    const startErr = starting.catch((e) => e);
    await vi.waitFor(() => expect(fetchHealth).toHaveBeenCalled());
    // Read before stop(), as in the node-stage twin above.
    const pollsAtStop = fetchHealth.mock.calls.length;
    const maxPolls = pollsAtStop + 1;
    await rt.stop();
    expect(await startErr).toMatchObject({ code: "START_CANCELLED" });
    expect(fetchHealth.mock.calls.length).toBeLessThanOrEqual(maxPolls);
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
    const rt = new LocalRuntime({
      run,
      fetchHealth: async () => READY,
      sleep: async () => {},
    });
    const startErr = rt.start().catch((e) => e);
    await vi.waitFor(() => expect(calls).toContain("machine start turnstone"));
    const stopping = rt.stop();
    // The gate holds the start open, so this is a drain, not a race.
    await new Promise((r) => setImmediate(r));
    releaseMachine();
    await stopping;
    expect(await startErr).toMatchObject({ code: "START_CANCELLED" });
    expect(calls).not.toContain(POD_START);
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

describe("LocalRuntime stage", () => {
  it("exposes the current stage so a late loading page can catch up", async () => {
    const seen = [];
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      { fetchHealth: vi.fn(async () => ({ status: "ok", nodes: 1 })) },
    );
    expect(rt.stage).toBe(null);
    const origProgress = rt._progress.bind(rt);
    rt._progress = (s) => {
      origProgress(s);
      seen.push(rt.stage);
    };
    await rt.start();
    expect(seen).toEqual(["machine", "pod", "console", "node"]);
    expect(rt.stage).toBe("node");
  });
});

describe("LocalRuntime node wait when the console drops", () => {
  it("reports HEALTH_TIMEOUT, not NODE_TIMEOUT, if the console stops answering", async () => {
    const fetchHealth = vi
      .fn()
      .mockResolvedValueOnce({ status: "ok", nodes: 0 })
      .mockResolvedValue(null);
    const { rt } = make(
      { [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" },
      {
        fetchHealth,
        healthTimeoutMs: 1000,
        // Reads advance 10ms, so the 40ms node deadline is hit on the 4th node check.
        nodeTimeoutMs: 40,
        step: 10,
      },
    );
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("HEALTH_TIMEOUT");
    expect(err.detail).toContain("stopped answering");
    // One console poll (ok, nodes=0), then four node polls.
    expect(fetchHealth).toHaveBeenCalledTimes(5);
  });
});

describe("LocalRuntime console address", () => {
  // Failure: with the override unset, the health poll targets another address than the README's 127.0.0.1:8090, so startup waits on a console nobody runs.
  it("defaults healthUrl to the README address when the override is unset", () => {
    vi.stubEnv("TURNSTONE_LOCAL_CONSOLE_URL", "");
    const rt = new LocalRuntime({ run: vi.fn(), fetchHealth: vi.fn() });
    expect(rt.healthUrl).toBe("http://127.0.0.1:8090");
  });

  // Failure: the override is read but not used as the default, so the health poll still targets 8090 and the smoke tier waits on the wrong console.
  it("uses TURNSTONE_LOCAL_CONSOLE_URL as the default healthUrl", () => {
    vi.stubEnv("TURNSTONE_LOCAL_CONSOLE_URL", "http://127.0.0.1:9191/");
    const rt = new LocalRuntime({ run: vi.fn(), fetchHealth: vi.fn() });
    expect(rt.healthUrl).toBe("http://127.0.0.1:9191");
  });

  // Failure: a malformed override is ignored at construction, so the health poll runs against the default address instead of reporting the bad setting.
  it("throws naming the variable when the override is malformed", () => {
    vi.stubEnv("TURNSTONE_LOCAL_CONSOLE_URL", "http://example.com:8090");
    expect(() => new LocalRuntime({ run: vi.fn(), fetchHealth: vi.fn() })).toThrow(/TURNSTONE_LOCAL_CONSOLE_URL/);
  });
});

describe("runPodman argv under the TURNSTONE_PODMAN override", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "turnstone-podman-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Failure: the override's leading arguments are dropped or put after the podman arguments, so the smoke tier's fake podman receives the wrong argv and every smoke check reads the wrong result.
  it("runs the override executable with its leading arguments before the podman arguments", async () => {
    const script = join(dir, "fake-podman.js");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    vi.stubEnv("TURNSTONE_PODMAN", JSON.stringify([process.execPath, script, "--marker"]));
    const rt = new LocalRuntime({ fetchHealth: vi.fn(), sleep: async () => {} });

    const out = await rt.run(["machine", "list"]);

    expect(JSON.parse(out)).toEqual(["--marker", "machine", "list"]);
  });
});

describe("fetchHealthJson", () => {
  afterEach(removeFakeElectron);

  // Failure: a non-OK answer is left unread with its request open, which under Electron's fetch holds the
  // connection until the three-second timeout, while the start-up wait asks again every second.
  it("aborts the request of a non-OK answer and reads it as not ready", async () => {
    const netFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    fakeElectronNet(netFetch);

    const health = await fetchHealthJson("http://127.0.0.1:8090");

    expect(health).toBe(null);
    expect(netFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  // Failure: the start-up probe follows a redirect, so whatever answers at the target, on another port or host,
  // passes for the local console, and the start opens the console on that answer.
  it("does not follow a redirect, and reads the refused one as a redirect", async () => {
    // Electron's fetch rejects a redirect it was told not to follow. One it follows lands on a healthy answer.
    const netFetch = vi.fn(async (_url, init) => {
      if (init.redirect === "manual") throw new Error("Redirect was cancelled");
      return { ok: true, status: 200, json: async () => ({ status: "ok", nodes: 1 }) };
    });
    fakeElectronNet(netFetch);

    const health = await fetchHealthJson("http://127.0.0.1:8090");

    expect(health).toBe(HEALTH_REDIRECTED);
    expect(netFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  // Failure: a redirect answered as a response rather than a rejection, a 3xx or an opaque redirect, reads as healthy,
  // or as an unreachable console; or its request is left open.
  it.each([
    ["a 302", { ok: false, status: 302 }],
    ["an opaque redirect", { ok: false, status: 0, type: "opaqueredirect" }],
  ])("reads %s as a redirect", async (_name, answer) => {
    const netFetch = vi.fn().mockResolvedValue({ ...answer, json: async () => ({ status: "ok", nodes: 1 }) });
    fakeElectronNet(netFetch);

    expect(await fetchHealthJson("http://127.0.0.1:8090")).toBe(HEALTH_REDIRECTED);
    expect(netFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  // Failure: a connection failure, a timeout or another rejection reads as a redirect, so the detail misleads.
  it("reads any other rejection as unreachable", async () => {
    fakeElectronNet(vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")));

    expect(await fetchHealthJson("http://127.0.0.1:8090")).toBe(null);
  });
});
