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
    expect(fetchHealth.mock.calls.length).toBeGreaterThan(1);
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
      // Generous deadlines: the default 3ms is wall-clock and can flake.
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
        nodeTimeoutMs: 60,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
    );
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("NODE_TIMEOUT");
    expect(err.detail).toContain("no numeric nodes field");
    expect(fetchHealth.mock.calls.length).toBeGreaterThanOrEqual(3);
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

  it("stop() during the node wait cancels promptly instead of waiting out the timeout", async () => {
    const stages = [];
    const { rt, calls } = make(
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
    await new Promise((r) => setTimeout(r, 5));
    expect(stages).toContain("node");
    const t0 = Date.now();
    await rt.stop();
    expect(await startErr).toMatchObject({ code: "START_CANCELLED" });
    expect(Date.now() - t0).toBeLessThan(1000);
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
    await new Promise((r) => setTimeout(r, 0));
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
      "Turnstone is running, but its node has not come online yet. Retry in a moment.",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.started).toBe(false);
    expect(rt.active).toBe(true);
    releaseInspect();
    await starting;
    expect(rt.active).toBe(true);
  });

  it("stop ends console polling promptly instead of waiting out the timeout", async () => {
    const { rt, calls } = make(
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
    const rt = new LocalRuntime({
      run,
      fetchHealth: async () => READY,
      sleep: async () => {},
    });
    const startErr = rt.start().catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    const stopping = rt.stop();
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
