const { execFile } = require("child_process");

const MACHINE = "turnstone";
const POD = "turnstone";
// Podman's default connection can point at another machine (turnstone-root
// exists), so pod commands name this connection explicitly.
const PODMAN_CONNECTION = "turnstone";

const USER_MESSAGES = {
  PODMAN_NOT_FOUND:
    "Podman is not installed. Install Podman, then reopen Turnstone.",
  MACHINE_MISSING:
    "The Turnstone Podman machine does not exist. Create it, then reopen Turnstone.",
  MACHINE_LIST_FAILED:
    "Podman answered, but its machine list could not be read.",
  MACHINE_START_FAILED: "The Turnstone Podman machine would not start.",
  POD_MISSING: "The Turnstone pod does not exist on the Podman machine.",
  POD_START_FAILED: "The Turnstone pod would not start.",
  POD_STOP_FAILED: "The Turnstone pod would not stop cleanly.",
  START_CANCELLED: "Startup was cancelled because Turnstone is quitting.",
  HEALTH_TIMEOUT:
    "Turnstone started but did not become healthy before the timeout.",
  NODE_TIMEOUT:
    "Turnstone is running, but its node has not come online yet; opening the console anyway.",
};

class LocalRuntimeError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.userMessage = USER_MESSAGES[code];
  }
}

function podArgs(args) {
  return ["--connection", PODMAN_CONNECTION, ...args];
}

/** Real podman runner. ENOENT is kept on the error so a missing binary is distinguishable. */
function runPodman(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "podman",
      args,
      { windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `${err.message}${stderr ? `\n${stderr}` : ""}`;
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Returns the parsed /health body, or null when the console is unreachable,
 * answers non-200, or does not return a JSON object. Callers treat null as
 * "not ready", never as a default state.
 */
async function fetchHealthJson(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// Last-seen summary for timeout details, so a support report says whether the
// console was down or up without a registered node.
function describeHealth(health) {
  if (health === null) return "console unreachable";
  const nodes =
    typeof health.nodes === "number" ? `nodes=${health.nodes}` : "no numeric nodes field";
  return `status=${String(health.status)}, ${nodes}`;
}

/**
 * Drives the local Podman machine and pod. Pod lifecycle is stop-then-start
 * only: `pod restart`, or restarting a single container, kills conmon and
 * strands the pod. A failed read is an error, never a default.
 *
 * Start is not done until the console reports ok AND its node is registered:
 * the console answers /health within seconds, but the node takes about a
 * minute to appear, and a console with no node cannot run sessions.
 */
class LocalRuntime {
  constructor({
    run = runPodman,
    fetchHealth = fetchHealthJson,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    healthUrl = "http://127.0.0.1:8090",
    healthTimeoutMs = 120000,
    nodeTimeoutMs = 180000,
    healthIntervalMs = 1000,
    onProgress = null,
  } = {}) {
    this.run = run;
    this.fetchHealth = fetchHealth;
    this.sleep = sleep;
    this.healthUrl = healthUrl;
    this.healthTimeoutMs = healthTimeoutMs;
    this.nodeTimeoutMs = nodeTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.onProgress = onProgress;
    // True once a pod call has succeeded past the machine check, so quit can
    // stop a pod this session started without touching one it never saw.
    this.started = false;
    this._starting = null;
    this._cancelled = false;
    // Latest progress stage; the loading page asks for it when it attaches
    // after the event was already sent.
    this.stage = null;
  }

  // True from the moment a start begins: quit must handle a run still
  // inspecting the pod, before `started` is set.
  get active() {
    return this.started || this._starting !== null;
  }

  // True only while a start is in flight. The loading page is shown for
  // exactly this window, so the health poller must not reload the console
  // during it.
  get starting() {
    return this._starting !== null;
  }

  // Overlapping callers (double-click Retry, fast mode switching) share one
  // run instead of racing podman against itself.
  start() {
    if (!this._starting) {
      this._cancelled = false;
      this._starting = this._start().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _start() {
    this._progress("machine");
    const running = await this._machineRunning();
    this._checkCancelled();
    if (!running) {
      await this._podman(["machine", "start", MACHINE], "MACHINE_START_FAILED");
      this._checkCancelled();
    }
    this._progress("pod");
    const state = await this._podState();
    this.started = true;
    this._checkCancelled();
    if (state !== "Running") {
      await this._podman(podArgs(["pod", "start", POD]), "POD_START_FAILED");
    }
    this._progress("console");
    await this._waitConsole();
    this._progress("node");
    await this._waitNode();
  }

  // A throwing listener must never fail a start; the loading page is cosmetic.
  _progress(stage) {
    this.stage = stage;
    if (!this.onProgress) return;
    try {
      this.onProgress(stage);
    } catch {
      // Ignored on purpose: see above.
    }
  }

  // stop() records intent; start() checks it after each await so a quit
  // never waits out the health window or lets a pod start after the stop.
  _checkCancelled() {
    if (this._cancelled) {
      throw new LocalRuntimeError("START_CANCELLED", "stopped during start");
    }
  }

  async stop() {
    this._cancelled = true;
    // A pod start still in flight would bring the pod back up after this
    // stop, so let it settle first; its own error is reported to its caller.
    if (this._starting) await this._starting.catch(() => {});
    await this._podman(podArgs(["pod", "stop", POD]), "POD_STOP_FAILED");
  }

  async _podman(args, failCode) {
    try {
      return await this.run(args);
    } catch (err) {
      throw this._wrap(err, failCode);
    }
  }

  _wrap(err, failCode) {
    if (err && err.code === "ENOENT") {
      return new LocalRuntimeError("PODMAN_NOT_FOUND", err.message);
    }
    return new LocalRuntimeError(failCode, err && err.message);
  }

  async _machineRunning() {
    const out = await this._podman(
      ["machine", "list", "--format", "json"],
      "MACHINE_LIST_FAILED",
    );
    let list;
    try {
      list = JSON.parse(out);
    } catch (err) {
      throw new LocalRuntimeError("MACHINE_LIST_FAILED", err.message);
    }
    if (!Array.isArray(list)) {
      throw new LocalRuntimeError("MACHINE_LIST_FAILED", "not a JSON array");
    }
    const m = list.find((x) => x.Name === MACHINE);
    if (!m) throw new LocalRuntimeError("MACHINE_MISSING", MACHINE);
    return m.Running === true;
  }

  async _podState() {
    let out;
    try {
      out = await this.run(
        podArgs(["pod", "inspect", POD, "--format", "{{.State}}"]),
      );
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err);
      throw new LocalRuntimeError("POD_MISSING", err && err.message);
    }
    return String(out).trim();
  }

  async _waitConsole() {
    const deadline = Date.now() + this.healthTimeoutMs;
    let last;
    for (;;) {
      this._checkCancelled();
      const health = await this.fetchHealth(this.healthUrl);
      if (health !== null && health.status === "ok") return;
      last = describeHealth(health);
      if (Date.now() >= deadline) {
        throw new LocalRuntimeError(
          "HEALTH_TIMEOUT",
          `${this.healthUrl} not healthy after ${this.healthTimeoutMs}ms (last seen: ${last})`,
        );
      }
      await this.sleep(this.healthIntervalMs);
    }
  }

  async _waitNode() {
    const deadline = Date.now() + this.nodeTimeoutMs;
    let last;
    for (;;) {
      this._checkCancelled();
      const health = await this.fetchHealth(this.healthUrl);
      if (
        health !== null &&
        typeof health.nodes === "number" &&
        health.nodes >= 1
      ) {
        return;
      }
      last = describeHealth(health);
      if (Date.now() >= deadline) {
        // The console dropped while we waited: that is a health failure, not
        // a late node, and must not be mistaken for "console up, nodes=0".
        if (health === null || health.status !== "ok") {
          throw new LocalRuntimeError(
            "HEALTH_TIMEOUT",
            `${this.healthUrl} stopped answering during the node wait (last seen: ${last})`,
          );
        }
        throw new LocalRuntimeError(
          "NODE_TIMEOUT",
          `${this.healthUrl} console ready but node not registered after ${this.nodeTimeoutMs}ms (last seen: ${last})`,
        );
      }
      await this.sleep(this.healthIntervalMs);
    }
  }
}

module.exports = { LocalRuntime, LocalRuntimeError };
