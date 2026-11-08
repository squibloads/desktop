import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSteppedClock } from "../helpers/fake-clock.js";
import { fakeElectronNet, removeFakeElectron } from "../helpers/fake-electron-net.js";

const { LocalRuntime, LocalRuntimeError, fetchHealthJson, HEALTH_REDIRECTED, runPodman } = require("../../src/main/local-runtime.js");
const { machineCheckCommand } = require("../../src/main/machine-hardening.js");
const { configCommand } = require("../../src/main/turnstone-config.js");

/**
 * Scripted podman: each entry maps a joined argv to a result. An unscripted
 * call fails the test loudly so a new CLI call can never slip in unreviewed.
 */
function makeRunner(script) {
  const calls = [];
  const run = vi.fn(async (args, options) => {
    const key = args.join(" ");
    calls.push(key);
    if (!(key in script)) throw new Error(`unscripted podman call: ${key}`);
    // A function answers each call afresh, so one call can answer differently the second time. It gets the call's
    // options, such as the abort signal a create is given.
    const out = typeof script[key] === "function" ? script[key](options) : script[key];
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
// The machine check, run as root inside the machine, and what a machine holding every ADR-05 setting answers.
const HARDEN = `machine ssh --username root turnstone ${machineCheckCommand()}`;
const HARDENED = "wslconf=ok\nsudo=refused\nend=ok\n";
// The config script, run as root inside the machine on a first run, and what it answers when it writes config.toml.
const CONFIG = `machine ssh --username root turnstone ${configCommand()}`;
const CONFIG_CREATED = "config=created\nend=ok\n";

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
  // Every start checks the machine, so a test that is not about the check gets a machine that passes it; a first run
  // that reaches the config step gets a script that writes the file.
  const runner = makeRunner({ [HARDEN]: HARDENED, [CONFIG]: CONFIG_CREATED, ...script });
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
    // Plenty of space unless a test says otherwise; the real reading is covered in disk-space.test.js.
    freeDiskBytes: opts.freeDiskBytes ?? (() => 100e9),
    diskPath: "C:\\Users\\joe\\.local\\share\\containers\\podman\\machine",
  });
  return { rt, calls: runner.calls, fetchHealth, run: runner.run };
}

// The calls that create a missing machine, as local-runtime.js passes them.
const VERSION = "version --format {{.Client.Version}}";
const MACHINE_INIT = "machine init turnstone --username user";
const MACHINE_RM = "machine rm --force turnstone";
const MACHINE_START = "machine start turnstone";

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
      HARDEN,
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
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE]);
  });

  it("reports PODMAN_NOT_FOUND when the binary is missing", async () => {
    const enoent = Object.assign(new Error("spawn podman ENOENT"), {
      code: "ENOENT",
    });
    const { rt } = make({ [MACHINE_LIST]: enoent });
    await expect(rt.start()).rejects.toMatchObject({ code: "PODMAN_NOT_FOUND" });
  });

  // Failure: a PC with Podman but no turnstone machine stops at an error asking the user to build the machine by hand.
  it("creates a missing machine, then starts it and checks it before the pod", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: JSON.stringify([{ Name: "other", Running: true }]),
      [VERSION]: "6.1.4\n",
      [MACHINE_INIT]: "",
      [MACHINE_START]: "",
      [POD_STATE]: "Exited",
      [POD_START]: "",
    });
    await rt.start();
    expect(calls).toEqual([MACHINE_LIST, VERSION, MACHINE_INIT, MACHINE_START, HARDEN, POD_STATE, POD_START]);
  });

  // Failure: init downloads the machine image, so the two-minute limit every other call gets kills it on most links.
  it("gives machine init a long time limit", async () => {
    const { rt, run } = make({
      [MACHINE_LIST]: "[]",
      [VERSION]: "6.1.4\n",
      [MACHINE_INIT]: "",
      [MACHINE_START]: "",
      [POD_STATE]: "Running",
    });
    await rt.start();
    const [, options] = run.mock.calls.find(([args]) => args.join(" ") === MACHINE_INIT);
    expect(options?.timeoutMs).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  // Failure: the loading page says "Starting" through a create that takes minutes, so the user thinks it has hung.
  it("reports the create stage before init, then the machine stage again", async () => {
    const stages = [];
    const { rt } = make(
      {
        [MACHINE_LIST]: "[]",
        [VERSION]: "6.1.4\n",
        [MACHINE_INIT]: "",
        [MACHINE_START]: "",
        [POD_STATE]: "Running",
      },
      { onProgress: (stage) => stages.push(stage) },
    );
    await rt.start();
    expect(stages).toEqual(["machine", "create", "machine", "pod", "console", "node"]);
  });

  // Failure: a Podman with the fresh-machine pids cgroup bug (fixed in 6.1.4) creates a machine where no container runs.
  it("refuses a Podman older than 6.1.4, and creates nothing", async () => {
    const { rt, calls } = make({ [MACHINE_LIST]: "[]", [VERSION]: "6.1.3\n" });
    await expect(rt.start()).rejects.toMatchObject({ code: "PODMAN_TOO_OLD", detail: expect.stringContaining("6.1.3") });
    expect(calls).toEqual([MACHINE_LIST, VERSION]);
  });

  // Failure: a newer Podman, or a pre-release of one, is refused as too old.
  it.each([["6.2.0"], ["7.0.0-rc1"], ["6.10.0"]])("accepts Podman %s", async (version) => {
    const { rt, calls } = make({
      [MACHINE_LIST]: "[]",
      [VERSION]: `${version}\n`,
      [MACHINE_INIT]: "",
      [MACHINE_START]: "",
      [POD_STATE]: "Running",
    });
    await rt.start();
    expect(calls).toContain(MACHINE_INIT);
  });

  // Failure: an unreadable version is taken as new enough, so the check passes on a guess.
  it("reports MACHINE_CREATE_FAILED when Podman's version cannot be read, and creates nothing", async () => {
    const { rt, calls } = make({ [MACHINE_LIST]: "[]", [VERSION]: "unknown\n" });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_CREATE_FAILED" });
    expect(calls).toEqual([MACHINE_LIST, VERSION]);
  });

  // Failure: a create that stops halfway leaves a broken machine, and every Retry then fails to start it.
  it("removes a half-made machine when init fails, so Retry starts clean", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: "[]",
      [VERSION]: "6.1.4\n",
      [MACHINE_INIT]: new Error("Command failed: podman machine init\nError: image download failed"),
      [MACHINE_RM]: "",
    });
    await expect(rt.start()).rejects.toMatchObject({
      code: "MACHINE_CREATE_FAILED",
      detail: expect.stringContaining("image download failed"),
    });
    expect(calls).toEqual([MACHINE_LIST, VERSION, MACHINE_INIT, MACHINE_RM]);
  });

  // Failure: quitting during a first-run create waits for init, up to its 15 minutes, so the app looks hung on quit.
  it("stops a create when the app quits, removes the half-made machine, and does not wait for init", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: "[]",
      [VERSION]: "6.1.4\n",
      // Init never finishes on its own: only the abort the quit sends ends it.
      [MACHINE_INIT]: (options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })),
          );
        }),
      [MACHINE_RM]: "",
      [STOP]: "",
    });
    const starting = rt.start();
    await vi.waitFor(() => expect(calls).toContain(MACHINE_INIT));

    await rt.stop();

    await expect(starting).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(calls).toEqual([MACHINE_LIST, VERSION, MACHINE_INIT, MACHINE_RM, STOP]);
  });

  // Failure: a cleanup that fails replaces the reason the create failed, or vanishes silently, so a Retry meets the
  // leftover WSL distribution and nothing says why.
  it("keeps the init error, and says and logs that the cleanup failed too", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt } = make({
      [MACHINE_LIST]: "[]",
      [VERSION]: "6.1.4\n",
      [MACHINE_INIT]: new Error("Command failed: podman machine init\nError: image download failed"),
      [MACHINE_RM]: new Error("Command failed: podman machine rm\nError: turnstone: VM does not exist"),
    });
    try {
      const err = await rt.start().catch((e) => e);

      expect(err.code).toBe("MACHINE_CREATE_FAILED");
      expect(err.detail).toContain("image download failed");
      expect(err.detail).toContain("The half-made machine could not be removed: Error: turnstone: VM does not exist");
      expect(err.detail).not.toContain("Command failed");
      expect(logged).toHaveBeenCalledWith("machine create cleanup failed:", "Error: turnstone: VM does not exist");
    } finally {
      // Restoring also clears the recorded calls, so it comes after the assertions.
      logged.mockRestore();
    }
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
      // The image is already there, so nothing is pulled.
      [IMAGE_EXISTS]: "",
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

describe("LocalRuntime machine hardening", () => {
  const MACHINE_STOP = "machine stop turnstone";
  const MACHINE_START = "machine start turnstone";

  // Failure: a machine that was already running is trusted as it is, so settings dropped while the app was closed
  // stay dropped (ADR-05: the app re-asserts them on every start).
  it("checks the machine on every start, before the pod, also when it was already running", async () => {
    const { rt, calls } = make({ [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" });
    await rt.start();
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE]);
  });

  // Failure: a rewritten wsl.conf is trusted before the machine boots with it, so automount and interop stay on.
  it("restarts the machine when wsl.conf was rewritten, then checks again before the pod", async () => {
    const reports = ["wslconf=rewritten\nsudo=refused\nend=ok\n", HARDENED];
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: () => reports.shift(),
      [MACHINE_STOP]: "",
      [MACHINE_START]: "",
      [POD_STATE]: "Exited",
      [POD_START]: "",
    });
    await rt.start();
    expect(calls).toEqual([MACHINE_LIST, HARDEN, MACHINE_STOP, MACHINE_START, HARDEN, POD_STATE, POD_START]);
  });

  // Failure: a machine with a gap runs the agent anyway, or a pod left running from before keeps running on it.
  it("refuses with MACHINE_NOT_HARDENED naming the gap, stops a pod left running, and never starts one", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: "wslconf=ok\nsudo=allowed\nend=ok\n",
      [STOP]: "",
    });
    const err = await rt.start().catch((e) => e);
    expect(err).toBeInstanceOf(LocalRuntimeError);
    expect(err.code).toBe("MACHINE_NOT_HARDENED");
    expect(err.detail).toBe("the machine user can use sudo without a password");
    expect(calls).toEqual([MACHINE_LIST, HARDEN, STOP]);
  });

  // Failure: a failed stop of the pod on an unhardened machine replaces the gap with POD_STOP_FAILED, so the user
  // is told the wrong thing.
  it("still reports MACHINE_NOT_HARDENED when stopping the pod fails", async () => {
    const { rt } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: "wslconf=ok\nsudo=allowed\nend=ok\n",
      [STOP]: new Error("Error: no pod with name or ID turnstone found"),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_NOT_HARDENED" });
  });

  // Failure: a wsl.conf that will not stay written restarts the machine on every start forever, or passes.
  it("reports MACHINE_NOT_HARDENED when wsl.conf still differs after the restart", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: "wslconf=rewritten\nsudo=refused\nend=ok\n",
      [MACHINE_STOP]: "",
      [MACHINE_START]: "",
      [STOP]: "",
    });
    await expect(rt.start()).rejects.toMatchObject({
      code: "MACHINE_NOT_HARDENED",
      detail: "wsl.conf does not keep the app's settings after a restart",
    });
    expect(calls.filter((c) => c === MACHINE_STOP)).toHaveLength(1);
  });

  // Failure: a check that could not run reads as a clean machine, and the error detail repeats the whole encoded
  // script instead of what went wrong.
  it("reports MACHINE_CHECK_FAILED with podman's error, not the command line, when the check cannot run", async () => {
    const failure = new Error(
      `Command failed: podman ${HARDEN}\nError: ssh: connect to host localhost port 51234: Connection refused`,
    );
    const { rt, calls } = make({ [MACHINE_LIST]: machines(true), [HARDEN]: failure, [STOP]: "" });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("MACHINE_CHECK_FAILED");
    expect(err.detail).toBe("Error: ssh: connect to host localhost port 51234: Connection refused");
    expect(calls).not.toContain(POD_START);
  });

  // Failure: a check that failed with nothing on stderr shows its command line, the whole encoded script, as the detail.
  it("never shows the command line as the detail when podman said nothing", async () => {
    const silent = Object.assign(new Error(`Command failed: podman ${HARDEN}`), { code: 255 });
    const { rt } = make({ [MACHINE_LIST]: machines(true), [HARDEN]: silent, [STOP]: "" });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("MACHINE_CHECK_FAILED");
    expect(err.detail).toBe("podman exited with code 255 and printed nothing");
  });

  // Failure: a check that hung until runPodman's timeout killed it reads as a check that failed for no reason.
  it("says a check that ran out of time was stopped", async () => {
    const killed = Object.assign(new Error(`Command failed: podman ${HARDEN}`), { killed: true, signal: "SIGTERM", code: null });
    const { rt } = make({ [MACHINE_LIST]: machines(true), [HARDEN]: killed, [STOP]: "" });
    const err = await rt.start().catch((e) => e);
    expect(err.detail).toBe("podman did not finish in time and was stopped");
  });

  // Failure: a pod left running from an earlier session keeps running on a machine the check could not vouch for.
  it("stops a pod left running when the check cannot run", async () => {
    const failure = new Error(`Command failed: podman ${HARDEN}\nError: ssh: handshake failed`);
    const { rt, calls } = make({ [MACHINE_LIST]: machines(true), [HARDEN]: failure, [STOP]: "" });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_CHECK_FAILED" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, STOP]);
  });

  // Failure: a check whose binary is missing reads as a failed check, so the user is not told to install Podman.
  it("reports PODMAN_NOT_FOUND when podman disappears before the check, and calls nothing more", async () => {
    const missing = Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" });
    const { rt, calls } = make({ [MACHINE_LIST]: machines(true), [HARDEN]: missing });
    await expect(rt.start()).rejects.toMatchObject({ code: "PODMAN_NOT_FOUND" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN]);
  });

  // Failure: a report cut off part way reads as a clean machine, because the gaps it never reached are not in it, or
  // the pod left running keeps running.
  it("reports MACHINE_CHECK_FAILED when the report has no end line, and stops a pod left running", async () => {
    const { rt, calls } = make({ [MACHINE_LIST]: machines(true), [HARDEN]: "wslconf=ok\nsudo=refused\n", [STOP]: "" });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_CHECK_FAILED" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, STOP]);
  });

  // Failure: a machine that will not restart after its settings were put back starts the pod on the old settings, or
  // a stop that failed leaves the pod running on them.
  it("reports MACHINE_RESTART_FAILED when the restart fails, stops a pod left running, and never reaches the pod", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: "wslconf=rewritten\nsudo=refused\nend=ok\n",
      [MACHINE_STOP]: new Error("Error: machine stop failed"),
      [STOP]: "",
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_RESTART_FAILED" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, MACHINE_STOP, STOP]);
  });

  // Failure: a restart that came back down halfway leaves the pod's stop unattempted, or its failure replaces the code.
  it("still reports MACHINE_RESTART_FAILED when the machine will not come back and the pod stop fails", async () => {
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: "wslconf=rewritten\nsudo=refused\nend=ok\n",
      [MACHINE_STOP]: "",
      [MACHINE_START]: new Error("Error: machine start failed"),
      [STOP]: new Error("Error: machine turnstone is not running"),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "MACHINE_RESTART_FAILED" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, MACHINE_STOP, MACHINE_START, STOP]);
  });

  // Failure: quitting during the restart lets the start carry on and bring the pod up after the quit.
  it("stop() during the restart cancels the start before the machine comes back", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { rt, calls } = make({
      [MACHINE_LIST]: machines(true),
      [HARDEN]: "wslconf=rewritten\nsudo=refused\nend=ok\n",
      [MACHINE_STOP]: () => gate.then(() => ""),
      [MACHINE_START]: "",
      [STOP]: "",
    });
    const started = rt.start().catch((e) => e);
    await vi.waitFor(() => expect(calls).toContain(MACHINE_STOP));
    const stopping = rt.stop();
    release();
    expect((await started).code).toBe("START_CANCELLED");
    await stopping;
    expect(calls).not.toContain(MACHINE_START);
    expect(calls).not.toContain(POD_STATE);
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
      [HARDEN]: HARDENED,
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
      if (key === HARDEN) return HARDENED;
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

// The pinned image and the calls that bring it in, as local-runtime.js passes them.
const PINNED = "ghcr.io/turnstonelabs/turnstone@sha256:c98762f1c339986d84c255476d0fe188466bb13da1ccee695612ec3a83660d12";
const PLATFORM = "ghcr.io/turnstonelabs/turnstone@sha256:48a7730e76096cba73d648c0f447090596dfd3721d06fc9ca2a35dcce5aaa752";
const IMAGE_EXISTS = `--connection turnstone image exists ${PINNED}`;
const PULL = `--connection turnstone pull ${PINNED}`;
const IMAGE_DIGESTS = `--connection turnstone image inspect ${PINNED} --format {{json .RepoDigests}}`;
const IMAGE_RM = `--connection turnstone image rm ${PINNED}`;
// `image exists` answers "no" with exit code 1; anything else is a failure to answer.
const IMAGE_ABSENT = Object.assign(new Error("Command failed: podman image exists"), { code: 1 });
const NO_POD = new Error("Error: no such pod turnstone");
// A machine that is up and hardened, with no pod yet: the state a first run reaches after the create.
const NEW_MACHINE = { [MACHINE_LIST]: machines(true), [POD_STATE]: NO_POD };

describe("LocalRuntime pinned image", () => {
  // Failure: a first run has no image for the pod, and nothing fetches the one the release was tested with.
  it("pulls the pinned image by digest when the pod is missing, checks its digest, then still reports POD_MISSING", async () => {
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: "",
      [IMAGE_DIGESTS]: JSON.stringify([PLATFORM, PINNED]),
    });
    // Creating the pod is #1681; until then a start that has the image and the config stops at the missing pod.
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, PULL, IMAGE_DIGESTS, CONFIG]);
  });

  // Failure: every start downloads 1.3 GB again, though the image is already there.
  it("does not pull when the pinned image is already there", async () => {
    const { rt, calls } = make({ ...NEW_MACHINE, [IMAGE_EXISTS]: "" });
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, CONFIG]);
  });

  // Failure: a download fills the disk, and the machine, the pod and the rest of the PC fail with it (NFR-04).
  it("refuses to pull with less than 5 GB free, and says where and how much", async () => {
    const { rt, calls } = make({ ...NEW_MACHINE, [IMAGE_EXISTS]: IMAGE_ABSENT }, { freeDiskBytes: () => 3e9 });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("DISK_SPACE_LOW");
    expect(err.detail).toContain("GB free");
    expect(err.detail).toContain("podman");
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS]);
  });

  // Failure: the machine create downloads its image with no disk check, so the first download can fill the disk.
  it("refuses to create the machine with less than 5 GB free", async () => {
    const { rt, calls } = make({ [MACHINE_LIST]: "[]", [VERSION]: "6.1.4\n" }, { freeDiskBytes: () => 1e9 });
    await expect(rt.start()).rejects.toMatchObject({ code: "DISK_SPACE_LOW" });
    expect(calls).toEqual([MACHINE_LIST, VERSION]);
  });

  // Failure: a free-space read that fails is taken as enough, so the check passes on a guess.
  it("reports DISK_SPACE_LOW when the free space cannot be read", async () => {
    const { rt } = make(
      { ...NEW_MACHINE, [IMAGE_EXISTS]: IMAGE_ABSENT },
      {
        freeDiskBytes: () => {
          throw new Error("EIO: i/o error, statfs");
        },
      },
    );
    await expect(rt.start()).rejects.toMatchObject({
      code: "DISK_SPACE_LOW",
      detail: expect.stringContaining("EIO"),
    });
  });

  // Failure: the 1.3 GB pull gets the two minutes every other call gets, and is cut off on most links.
  it("gives the pull a long time limit, and shows the image stage", async () => {
    const stages = [];
    const { rt, run } = make(
      { ...NEW_MACHINE, [IMAGE_EXISTS]: IMAGE_ABSENT, [PULL]: "", [IMAGE_DIGESTS]: JSON.stringify([PINNED]) },
      { onProgress: (stage) => stages.push(stage) },
    );
    await rt.start().catch(() => {});
    const [, options] = run.mock.calls.find(([args]) => args.join(" ") === PULL);
    expect(options?.timeoutMs).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(stages).toEqual(["machine", "pod", "image"]);
  });

  // Failure: a failed pull shows the whole podman command line, or a generic error, and the user cannot tell why.
  it("reports IMAGE_PULL_FAILED with Podman's error, and checks no digest", async () => {
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: new Error("Command failed: podman pull\nError: reading blob: connection reset by peer"),
    });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("IMAGE_PULL_FAILED");
    expect(err.detail).toBe("Error: reading blob: connection reset by peer");
    expect(calls).not.toContain(IMAGE_DIGESTS);
  });

  // Failure: a pull cut off halfway leaves the app stuck, so Retry fails again without pulling, or skips the digest
  // check on what the broken pull left behind.
  it("pulls again on Retry after a pull that failed, and checks the new image's digest", async () => {
    let pulls = 0;
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: () => (++pulls === 1 ? new Error("Command failed: podman pull\nError: reading blob: unexpected EOF") : ""),
      [IMAGE_DIGESTS]: JSON.stringify([PLATFORM, PINNED]),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "IMAGE_PULL_FAILED" });
    calls.length = 0;
    // Creating the pod is #1681; until then a Retry that gets the image stops at the missing pod.
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, PULL, IMAGE_DIGESTS, CONFIG]);
  });

  // Failure: after an image is refused for its digest, Retry finds nothing to pull, or finds the refused image and
  // uses it.
  it("pulls again on Retry after an image was refused for its digest", async () => {
    let inspects = 0;
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: "",
      [IMAGE_DIGESTS]: () => JSON.stringify(++inspects === 1 ? [PLATFORM] : [PLATFORM, PINNED]),
      [IMAGE_RM]: "",
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "IMAGE_PULL_FAILED" });
    calls.length = 0;
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, PULL, IMAGE_DIGESTS, CONFIG]);
  });

  // Failure: an image that does not carry the pinned digest is used anyway, and the pod runs code nobody pinned (D-2).
  it("refuses and removes an image that does not carry the pinned digest", async () => {
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: "",
      [IMAGE_DIGESTS]: JSON.stringify([PLATFORM]),
      [IMAGE_RM]: "",
    });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("IMAGE_PULL_FAILED");
    expect(err.detail).toContain("pinned digest");
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, PULL, IMAGE_DIGESTS, IMAGE_RM]);
  });

  // Failure: a digest check that cannot run leaves the pulled image in place unchecked, against "check after every pull".
  it("removes the pulled image when its digests cannot be read, and reports why", async () => {
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: "",
      [IMAGE_DIGESTS]: new Error("Command failed: podman image inspect\nError: storage is locked"),
      [IMAGE_RM]: "",
    });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("IMAGE_PULL_FAILED");
    expect(err.detail).toContain("Error: storage is locked");
    expect(err.detail).not.toContain("Command failed");
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, PULL, IMAGE_DIGESTS, IMAGE_RM]);
  });

  // Failure: podman failing to say whether the image is there is read as "not there", and a pull starts on a guess.
  it("reports IMAGE_PULL_FAILED when podman cannot say whether the image is there", async () => {
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: Object.assign(new Error("Command failed: podman image exists\nError: storage is locked"), { code: 125 }),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "IMAGE_PULL_FAILED" });
    expect(calls).not.toContain(PULL);
  });

  // Failure: quitting during the 1.3 GB pull waits for it to finish.
  it("stops a pull when the app quits, without waiting for it", async () => {
    const { rt, calls } = make({
      ...NEW_MACHINE,
      [IMAGE_EXISTS]: IMAGE_ABSENT,
      [PULL]: (options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })),
          );
        }),
      [STOP]: "",
    });
    const starting = rt.start();
    await vi.waitFor(() => expect(calls).toContain(PULL));

    await rt.stop();

    await expect(starting).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, PULL, STOP]);
  });
});

// A first run whose image is already in place, so the config step comes straight after the image check.
const FIRST_RUN = { ...NEW_MACHINE, [IMAGE_EXISTS]: "" };

describe("LocalRuntime config step", () => {
  // Failure: the pod #1681 creates finds no config.toml, and a server started without jwt_secret exits.
  it("writes config.toml on a first run, after the image and before the start stops at POD_MISSING", async () => {
    const { rt, calls } = make(FIRST_RUN);
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, CONFIG]);
  });

  // Failure: a file left by an earlier run is refused, so a removed pod can never be made again without losing the
  // install's secrets.
  it("accepts a config.toml that is already there", async () => {
    const { rt, calls } = make({ ...FIRST_RUN, [CONFIG]: "config=kept\nend=ok\n" });
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, CONFIG]);
  });

  // Failure: every start runs a root script it does not need, and an existing pod waits on it.
  it("never runs the config step when the pod exists", async () => {
    const { rt, calls } = make({ [MACHINE_LIST]: machines(true), [POD_STATE]: "Running" });
    await rt.start();
    expect(calls).not.toContain(CONFIG);
  });

  // Failure: a secret made in the app reaches a command line, where /proc/<pid>/cmdline shows it (L-11). The config
  // call carries the fixed script, the same on every run, so it holds no secret.
  it("sends the same fixed script on every run", async () => {
    const first = make(FIRST_RUN);
    await first.rt.start().catch(() => {});
    const second = make(FIRST_RUN);
    await second.rt.start().catch(() => {});
    const configArgs = (run) => run.mock.calls.map(([args]) => args).filter((args) => args.join(" ") === CONFIG);
    expect(configArgs(first.run)).toEqual([["machine", "ssh", "--username", "root", "turnstone", configCommand()]]);
    expect(configArgs(second.run)).toEqual(configArgs(first.run));
  });

  // Failure: a script that could not run shows its command line, the whole encoded script, instead of Podman's error.
  it("reports CONFIG_WRITE_FAILED with Podman's error, not the command line, when the script cannot run", async () => {
    const { rt } = make({
      ...FIRST_RUN,
      [CONFIG]: new Error(`Command failed: podman ${CONFIG}\nError: ssh: connect to host localhost: Connection refused`),
    });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("CONFIG_WRITE_FAILED");
    expect(err.detail).toBe("Error: ssh: connect to host localhost: Connection refused");
  });

  // Failure: a script that could not write the file is taken as a success, and the pod starts with no secrets.
  it("reports CONFIG_WRITE_FAILED when the script could not create or check the file", async () => {
    const { rt } = make({ ...FIRST_RUN, [CONFIG]: "config=failed\nend=ok\n" });
    await expect(rt.start()).rejects.toMatchObject({
      code: "CONFIG_WRITE_FAILED",
      detail: "the machine could not create config.toml, or could not check the one already there",
    });
  });

  // Failure: a report cut short, or one that says nothing about the file, reads as a written config.
  it("reports CONFIG_WRITE_FAILED when the report has no end line or no answer about the file", async () => {
    const cut = make({ ...FIRST_RUN, [CONFIG]: "config=created\n" });
    await expect(cut.rt.start()).rejects.toMatchObject({
      code: "CONFIG_WRITE_FAILED",
      detail: "the script stopped before it finished",
    });
    const silent = make({ ...FIRST_RUN, [CONFIG]: "end=ok\n" });
    await expect(silent.rt.start()).rejects.toMatchObject({
      code: "CONFIG_WRITE_FAILED",
      detail: "the script answered config=(nothing)",
    });
  });

  // Failure: Retry after a failed config step skips it, or cannot run it again, and the first run is stuck.
  it("runs the config step again on Retry", async () => {
    let runs = 0;
    const { rt, calls } = make({
      ...FIRST_RUN,
      [CONFIG]: () => (++runs === 1 ? "config=failed\nend=ok\n" : CONFIG_CREATED),
    });
    await expect(rt.start()).rejects.toMatchObject({ code: "CONFIG_WRITE_FAILED" });
    calls.length = 0;
    await expect(rt.start()).rejects.toMatchObject({ code: "POD_MISSING" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, CONFIG]);
  });

  // Failure: a quit during the config step is reported as a missing pod, and an error page opens while the app quits.
  it("reports START_CANCELLED when the app quits during the config step", async () => {
    let finish;
    const { rt, calls } = make({
      ...FIRST_RUN,
      [CONFIG]: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      [STOP]: "",
    });
    const starting = rt.start();
    await vi.waitFor(() => expect(calls).toContain(CONFIG));
    const stopping = rt.stop();
    finish(CONFIG_CREATED);
    await stopping;
    await expect(starting).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(calls).toEqual([MACHINE_LIST, HARDEN, POD_STATE, IMAGE_EXISTS, CONFIG, STOP]);
  });

  // Failure: the loading page shows a stage it has no label for.
  it("adds no loading stage", async () => {
    const stages = [];
    const { rt } = make(FIRST_RUN, { onProgress: (stage) => stages.push(stage) });
    await rt.start().catch(() => {});
    expect(stages).toEqual(["machine", "pod"]);
  });
});

// A podman failure whose command line and stderr both carry a secret, as a future call with a secret in it could.
function leakyFailure() {
  return new Error(
    "Command failed: podman --connection turnstone run --env TURNSTONE_JWT_SECRET=leak-in-argv\n" +
      "Error: TURNSTONE_JWT_SECRET=leak-in-stderr was rejected",
  );
}

describe("LocalRuntime error text", () => {
  // Failure: a secret in Podman's stderr reaches the error page and the log through the error's detail (L-11).
  it("masks secret values in an error's detail and message", () => {
    const e = new LocalRuntimeError("POD_START_FAILED", 'Error: bad config\njwt_secret = "abc123"');
    expect(e.detail).toBe("Error: bad config\njwt_secret = [redacted]");
    expect(e.message).toBe("POD_START_FAILED: Error: bad config\njwt_secret = [redacted]");
  });

  // Failure: an error raised without a detail gains the text "undefined" or a mask, and reads as if podman said it.
  it("keeps a missing detail missing", () => {
    expect(new LocalRuntimeError("START_CANCELLED").detail).toBeUndefined();
  });

  // Failure: these codes kept execFile's whole "Command failed:" line, so any secret on a command line reached the
  // error page and the log, and the detail opened with a command the user cannot act on.
  it.each([
    ["MACHINE_START_FAILED", { [MACHINE_LIST]: machines(false), [MACHINE_START]: leakyFailure }],
    ["POD_START_FAILED", { [MACHINE_LIST]: machines(true), [POD_STATE]: "Exited", [POD_START]: leakyFailure }],
    ["POD_MISSING", { [MACHINE_LIST]: machines(true), [POD_STATE]: leakyFailure, [IMAGE_EXISTS]: "" }],
  ])("%s shows Podman's error without the command line, with the secret masked", async (code, script) => {
    const { rt } = make(script);
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.detail).toBe("Error: TURNSTONE_JWT_SECRET=[redacted] was rejected");
    expect(err.message).not.toContain("leak");
  });

  // Failure: the quit-time stop logs the whole command line and any secret in it ("pod stop failed:" in main.js).
  it("POD_STOP_FAILED shows Podman's error without the command line, with the secret masked", async () => {
    const { rt } = make({ [STOP]: leakyFailure });
    const err = await rt.stop().catch((e) => e);
    expect(err.code).toBe("POD_STOP_FAILED");
    expect(err.detail).toBe("Error: TURNSTONE_JWT_SECRET=[redacted] was rejected");
    expect(err.message).not.toContain("leak");
  });

  // Failure: the cleanup of a half-made machine logs Podman's stderr unmasked, before any LocalRuntimeError exists.
  it("masks the half-made machine cleanup line it logs", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt } = make({
      [MACHINE_LIST]: "[]",
      [VERSION]: "6.1.4\n",
      [MACHINE_INIT]: new Error("Command failed: podman machine init\nError: image download failed"),
      [MACHINE_RM]: new Error("Command failed: podman machine rm\nError: api_key=leak-in-cleanup refused"),
    });
    const err = await rt.start().catch((e) => e);
    expect(err.code).toBe("MACHINE_CREATE_FAILED");
    expect(logged).toHaveBeenCalledWith("machine create cleanup failed:", "Error: api_key=[redacted] refused");
    expect(err.detail).not.toContain("leak");
  });
});

describe("LocalRuntimeError messages", () => {
  const CODES = [
    "PODMAN_NOT_FOUND",
    "PODMAN_TOO_OLD",
    "MACHINE_CREATE_FAILED",
    "DISK_SPACE_LOW",
    "IMAGE_PULL_FAILED",
    "MACHINE_LIST_FAILED",
    "MACHINE_START_FAILED",
    "POD_MISSING",
    "POD_START_FAILED",
    "POD_STOP_FAILED",
    "CONFIG_WRITE_FAILED",
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
      if (key === HARDEN) return HARDENED;
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
      if (key === HARDEN) return HARDENED;
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
      if (key === HARDEN) return HARDENED;
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

describe("runPodman", () => {
  // Failure: the abort a quit sends never reaches the podman process, so the quit still waits for it to finish.
  it("stops a call when its signal aborts, without waiting for the call to end", async () => {
    // A stand-in podman that would run for a minute. The override is read per call.
    vi.stubEnv("TURNSTONE_PODMAN", JSON.stringify([process.execPath, "-e", "setTimeout(() => {}, 60000)"]));
    try {
      const controller = new AbortController();
      const started = performance.now();
      const call = runPodman(["machine", "init"], { signal: controller.signal });
      setTimeout(() => controller.abort(), 200);

      await expect(call).rejects.toMatchObject({ name: "AbortError" });
      expect(performance.now() - started).toBeLessThan(10000);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
