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
  HEALTH_TIMEOUT:
    "Turnstone started but did not become healthy before the timeout.",
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

async function checkConsoleHealth(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return "error";
    const data = await resp.json();
    return data.status === "ok" ? "ok" : "degraded";
  } catch {
    return "disconnected";
  }
}

/**
 * Drives the local Podman machine and pod. Pod lifecycle is stop-then-start
 * only: `pod restart`, or restarting a single container, kills conmon and
 * strands the pod. A failed read is an error, never a default.
 */
class LocalRuntime {
  constructor({
    run = runPodman,
    checkHealth = checkConsoleHealth,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    healthUrl = "http://127.0.0.1:8090",
    healthTimeoutMs = 120000,
    healthIntervalMs = 1000,
  } = {}) {
    this.run = run;
    this.checkHealth = checkHealth;
    this.sleep = sleep;
    this.healthUrl = healthUrl;
    this.healthTimeoutMs = healthTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    // True once a pod call has succeeded past the machine check, so quit can
    // stop a pod this session started without touching one it never saw.
    this.started = false;
    this._starting = null;
  }

  // Overlapping callers (double-click Retry, fast mode switching) share one
  // run instead of racing podman against itself.
  start() {
    if (!this._starting) {
      this._starting = this._start().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _start() {
    const running = await this._machineRunning();
    if (!running) {
      await this._podman(["machine", "start", MACHINE], "MACHINE_START_FAILED");
    }
    const state = await this._podState();
    this.started = true;
    if (state !== "Running") {
      await this._podman(podArgs(["pod", "start", POD]), "POD_START_FAILED");
    }
    await this._waitHealthy();
  }

  async stop() {
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

  async _waitHealthy() {
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      if ((await this.checkHealth(this.healthUrl)) === "ok") return;
      if (Date.now() >= deadline) {
        throw new LocalRuntimeError(
          "HEALTH_TIMEOUT",
          `${this.healthUrl} not healthy after ${this.healthTimeoutMs}ms`,
        );
      }
      await this.sleep(this.healthIntervalMs);
    }
  }
}

module.exports = { LocalRuntime, LocalRuntimeError };
