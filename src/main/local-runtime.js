const { execFile } = require("child_process");
const { podmanCommand, localConsoleUrl } = require("./runtime-config.js");
const { sessionFetch, isRefusedRedirect } = require("./session-fetch.js");
const { machineCheckCommand, parseMachineReport, hardeningGaps } = require("./machine-hardening.js");
const { TURNSTONE_IMAGE, pinnedImageRef } = require("./turnstone-image.js");
const { freeDiskBytes: readFreeDiskBytes, podmanDataDir } = require("./disk-space.js");
const { redactSecrets } = require("./redact-secrets.js");
const { configCommand, parseConfigReport } = require("./turnstone-config.js");

const MACHINE = "turnstone";
const POD = "turnstone";
// Podman's default connection can point at another machine (turnstone-root
// exists), so pod commands name this connection explicitly.
const PODMAN_CONNECTION = "turnstone";

// A fresh machine on WSL 2.9 and later could not run a container under older Podman, over the pids cgroup; 6.1.4 fixed
// it (Phase 2 Analysis). Only a create checks it: a machine that already exists was made by a Podman that worked.
const MIN_PODMAN = [6, 1, 4];
// The machine's user. machine-hardening.js writes `default=user` into wsl.conf, so the create names it rather than
// leave it to the provider's default.
const MACHINE_USER = "user";
const MACHINE_INIT = ["machine", "init", MACHINE, "--username", MACHINE_USER];
// Init downloads the machine image, which every other call's two minutes do not cover on most links.
const INIT_TIMEOUT_MS = 15 * 60 * 1000;
// The pinned image is about 1.3 GB, so its pull gets the same allowance.
const PULL_TIMEOUT_MS = 15 * 60 * 1000;
// Free space each download needs first, on the drive the machine's disk grows on (NFR-04).
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

const USER_MESSAGES = {
  PODMAN_NOT_FOUND:
    "Podman is not installed. Install Podman, then reopen Turnstone.",
  PODMAN_TOO_OLD:
    "Podman is older than 6.1.4, which Turnstone needs to create its machine. Update Podman, then reopen Turnstone.",
  MACHINE_CREATE_FAILED: "The Turnstone Podman machine could not be created.",
  DISK_SPACE_LOW:
    "Turnstone could not confirm 5 GB of free disk space for its download. Free up space, then reopen Turnstone.",
  IMAGE_PULL_FAILED: "The Turnstone image could not be downloaded.",
  MACHINE_LIST_FAILED:
    "Podman answered, but its machine list could not be read.",
  MACHINE_START_FAILED: "The Turnstone Podman machine would not start.",
  MACHINE_CHECK_FAILED:
    "The Turnstone machine's safety settings could not be checked, so Turnstone was not started.",
  MACHINE_RESTART_FAILED:
    "The Turnstone machine's safety settings were put back, but the machine would not restart to apply them.",
  MACHINE_NOT_HARDENED:
    "The Turnstone machine's safety settings are not holding, so Turnstone was not started.",
  POD_MISSING: "The Turnstone pod does not exist on the Podman machine.",
  CONFIG_WRITE_FAILED: "Turnstone could not create its settings file in its machine.",
  POD_START_FAILED: "The Turnstone pod would not start.",
  POD_STOP_FAILED: "The Turnstone pod would not stop cleanly.",
  START_CANCELLED: "Startup was cancelled because Turnstone is quitting.",
  HEALTH_TIMEOUT:
    "Turnstone started but did not become healthy before the timeout.",
  NODE_TIMEOUT:
    "Turnstone is running, but its node has not come online yet; opening the console anyway.",
};

// Every detail is masked here, once, because the error page, the start log and the quit log all read it from this
// object (L-11). A missing detail stays missing.
class LocalRuntimeError extends Error {
  constructor(code, detail) {
    const clean = detail == null ? detail : redactSecrets(detail);
    super(`${code}: ${clean}`);
    this.code = code;
    this.detail = clean;
    this.userMessage = USER_MESSAGES[code];
  }
}

// The machine check's failures that leave the machine unverified. A pod left running is stopped for each. A missing
// podman cannot stop anything, and a cancelled start leaves the pod to the stop that cancelled it.
const UNVERIFIED_MACHINE = new Set(["MACHINE_NOT_HARDENED", "MACHINE_CHECK_FAILED", "MACHINE_RESTART_FAILED"]);

function podArgs(args) {
  return ["--connection", PODMAN_CONNECTION, ...args];
}

/**
 * Real podman runner. ENOENT is kept on the error so a missing binary is distinguishable. timeoutMs is two minutes
 * unless a call needs longer; the output limit is raised because a machine create can print a lot. A signal, when
 * given, ends the call early: a quit uses it so it never waits out a machine create.
 */
function runPodman(args, { timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    // Read per call; a malformed override rejects here (the app also checks it once at start).
    const cmd = podmanCommand();
    execFile(
      cmd.file,
      [...cmd.prefixArgs, ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal },
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

// What fetchHealthJson returns when the console answers /health with a redirect. It is not ready, as null is, but a
// start that times out on it says the console answered with a redirect: a browser opened on /health, as the README's
// troubleshooting says, follows the redirect and can show a healthy page, so "unreachable" would contradict it.
const HEALTH_REDIRECTED = Object.freeze({ redirected: true });

/**
 * Returns the parsed /health body; HEALTH_REDIRECTED when the console answers
 * with a redirect; or null when it is unreachable, answers non-200, or does not
 * return a JSON object. Callers treat anything but a body with status "ok" as
 * "not ready", never as a default state.
 */
async function fetchHealthJson(baseUrl) {
  // Aborting the request is what closes its connection. Electron's fetch keeps the connection open while an
  // answer is left unread.
  const controller = new AbortController();
  try {
    const resp = await sessionFetch(`${baseUrl}/health`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      // A redirect is not followed: the local console answers /health itself, and whatever answers at the target
      // is not it. Electron's fetch rejects the redirect, which the catch below reads; a redirect returned as an
      // answer, as Node's fetch returns it, reads the same.
      redirect: "manual",
    });
    if (!resp.ok) {
      controller.abort();
      const redirected = resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400);
      return redirected ? HEALTH_REDIRECTED : null;
    }
    const data = await resp.json();
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    return isRefusedRedirect(err) ? HEALTH_REDIRECTED : null;
  }
}

// Last-seen summary for timeout details, so a support report says whether the
// console was down or up without a registered node.
function describeHealth(health) {
  if (health === null) return "console unreachable";
  if (health === HEALTH_REDIRECTED) return "console answered /health with a redirect, which is not followed";
  const nodes =
    typeof health.nodes === "number" ? `nodes=${health.nodes}` : "no numeric nodes field";
  return `status=${String(health.status)}, ${nodes}`;
}

// What a failed podman call said, never its command line: execFile puts the whole command line in the first line, and
// for the machine check that is a long encoded script that says nothing about what went wrong. With nothing on stderr,
// such as a call runPodman's timeout killed, the detail says how the call ended instead.
function withoutCommandLine(err) {
  const message = String((err && err.message) || "");
  const lines = message.split(/\r?\n/);
  const rest = lines.slice(1).join("\n").trim();
  if (rest) return rest;
  if (err && err.killed) return "podman did not finish in time and was stopped";
  if (lines[0] && !lines[0].startsWith("Command failed:")) return lines[0];
  if (err && typeof err.code === "number") return `podman exited with code ${err.code} and printed nothing`;
  return "podman failed with no message";
}

// Negative, zero or positive as version a is older than, the same as, or newer than b; each is [major, minor, patch].
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Drives the local Podman machine and pod, and creates the machine on first run. Pod lifecycle is stop-then-start
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
    healthUrl = localConsoleUrl(),
    healthTimeoutMs = 120000,
    nodeTimeoutMs = 180000,
    healthIntervalMs = 1000,
    onProgress = null,
    freeDiskBytes = readFreeDiskBytes,
    diskPath = podmanDataDir(),
  } = {}) {
    this.run = run;
    this.fetchHealth = fetchHealth;
    this.sleep = sleep;
    this.healthUrl = healthUrl;
    this.healthTimeoutMs = healthTimeoutMs;
    this.nodeTimeoutMs = nodeTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.onProgress = onProgress;
    this.freeDiskBytes = freeDiskBytes;
    this.diskPath = diskPath;
    // True once a pod call has succeeded past the machine check, so quit can
    // stop a pod this session started without touching one it never saw.
    this.started = false;
    this._starting = null;
    this._cancelled = false;
    // Set while a download runs (the machine create or the image pull), so a quit can end it instead of waiting up to
    // its 15 minutes.
    this._downloadAbort = null;
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
    let machine = await this._machineState();
    this._checkCancelled();
    if (machine === "missing") {
      await this._createMachine();
      this._checkCancelled();
      this._progress("machine");
      machine = "stopped";
    }
    if (machine !== "running") {
      await this._podman(["machine", "start", MACHINE], "MACHINE_START_FAILED");
      this._checkCancelled();
    }
    await this._hardenMachine();
    this._progress("pod");
    let state;
    try {
      state = await this._podState();
    } catch (err) {
      // A missing pod is a first run: the pinned image comes in now, then config.toml with this install's secrets,
      // which the pod mounts. Creating the pod is #1681; until then the start still stops at POD_MISSING, with the
      // image and the config in place.
      if (err && err.code === "POD_MISSING") {
        await this._ensureImage();
        this._checkCancelled();
        await this._ensureConfig();
        this._checkCancelled();
      }
      throw err;
    }
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
    // A machine create or an image pull can run for minutes; it is ended rather than waited for, and a create's
    // half-made machine is removed.
    if (this._downloadAbort) this._downloadAbort.abort();
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
    return new LocalRuntimeError(failCode, withoutCommandLine(err));
  }

  /** "missing", "running" or "stopped", from the machine list. A list that cannot be read is an error, never empty. */
  async _machineState() {
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
    if (!m) return "missing";
    return m.Running === true ? "running" : "stopped";
  }

  /**
   * First run on this PC: no turnstone machine exists, so the app makes one instead of asking the user to. The start
   * goes on from there as for a stopped machine, so the safety settings are put back and checked before any pod runs.
   * A create that fails is removed, so Retry starts clean; it did not exist before this create, so nothing of the
   * user's goes with it. A removal that fails is logged and named on the error page.
   */
  async _createMachine() {
    await this._checkPodmanVersion();
    this._checkDiskSpace();
    this._checkCancelled();
    this._progress("create");
    const abort = new AbortController();
    this._downloadAbort = abort;
    try {
      await this.run(MACHINE_INIT, { timeoutMs: INIT_TIMEOUT_MS, signal: abort.signal });
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err, "MACHINE_CREATE_FAILED");
      const cleanup = await this._removeHalfMadeMachine();
      if (abort.signal.aborted) throw new LocalRuntimeError("START_CANCELLED", "stopped during the machine create");
      const reason = withoutCommandLine(err);
      throw new LocalRuntimeError(
        "MACHINE_CREATE_FAILED",
        cleanup ? `${reason}\nThe half-made machine could not be removed: ${cleanup}` : reason,
      );
    } finally {
      this._downloadAbort = null;
    }
  }

  /**
   * Removes what a failed or ended create left; null when that worked, else what went wrong, which is also logged.
   * Podman cannot remove a create it stopped before writing the machine's settings, and WSL can then still hold the
   * podman-turnstone distribution, which a Retry's create meets. The app does not remove a distribution Podman does
   * not know: it could be a working machine whose Podman settings were lost. The error says so, and the README gives
   * the command.
   */
  async _removeHalfMadeMachine() {
    try {
      await this.run(["machine", "rm", "--force", MACHINE]);
      return null;
    } catch (rmErr) {
      const cleanup = withoutCommandLine(rmErr);
      // Logged before any LocalRuntimeError exists, so it is masked here.
      console.error("machine create cleanup failed:", redactSecrets(cleanup));
      return cleanup;
    }
  }

  // A version that cannot be read is an error, never taken as new enough.
  async _checkPodmanVersion() {
    const out = await this._podman(["version", "--format", "{{.Client.Version}}"], "MACHINE_CREATE_FAILED");
    const text = String(out).trim();
    const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (!parsed) {
      throw new LocalRuntimeError("MACHINE_CREATE_FAILED", `Podman's version could not be read: ${text || "(no output)"}`);
    }
    if (compareVersions(parsed.slice(1).map(Number), MIN_PODMAN) < 0) {
      throw new LocalRuntimeError("PODMAN_TOO_OLD", `found Podman ${text}; ${MIN_PODMAN.join(".")} or later is needed`);
    }
  }

  // Before each download. A free-space read that fails is an error, never taken as enough.
  _checkDiskSpace() {
    const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
    let free;
    try {
      free = this.freeDiskBytes(this.diskPath);
    } catch (err) {
      throw new LocalRuntimeError(
        "DISK_SPACE_LOW",
        `the free space on the drive holding ${this.diskPath} could not be read: ${err && err.message}`,
      );
    }
    if (!(free >= MIN_FREE_BYTES)) {
      throw new LocalRuntimeError(
        "DISK_SPACE_LOW",
        `${gb(MIN_FREE_BYTES)} GB needed on the drive holding ${this.diskPath}; ${gb(free)} GB free`,
      );
    }
  }

  /**
   * First run: the pod needs the image this release pins (ADR-03). It is pulled by digest when the machine does not
   * have it, after the disk check and with a quit able to end the pull, and then its digest is checked (D-2). An
   * interrupted pull leaves no image under the pinned reference, so a Retry pulls again; nothing is built on the image
   * until its digest checks out.
   */
  async _ensureImage() {
    const ref = pinnedImageRef();
    if (await this._imageExists(ref)) return;
    this._checkDiskSpace();
    this._checkCancelled();
    this._progress("image");
    const abort = new AbortController();
    this._downloadAbort = abort;
    try {
      await this.run(podArgs(["pull", ref]), { timeoutMs: PULL_TIMEOUT_MS, signal: abort.signal });
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err, "IMAGE_PULL_FAILED");
      if (abort.signal.aborted) throw new LocalRuntimeError("START_CANCELLED", "stopped during the image download");
      throw new LocalRuntimeError("IMAGE_PULL_FAILED", withoutCommandLine(err));
    } finally {
      this._downloadAbort = null;
    }
    this._checkCancelled();
    await this._verifyImageDigest(ref);
  }

  // `image exists` answers "no" with exit code 1. Any other failure is an error, never read as "not there".
  async _imageExists(ref) {
    try {
      await this.run(podArgs(["image", "exists", ref]));
      return true;
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err, "IMAGE_PULL_FAILED");
      if (err && err.code === 1) return false;
      throw new LocalRuntimeError("IMAGE_PULL_FAILED", withoutCommandLine(err));
    }
  }

  // The pulled image must carry the pinned index digest among its repo digests. One that does not, or whose digests
  // cannot be read, is removed, so the next start does not find it "there" and skip the check.
  async _verifyImageDigest(ref) {
    let out;
    try {
      out = await this.run(podArgs(["image", "inspect", ref, "--format", "{{json .RepoDigests}}"]));
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err, "IMAGE_PULL_FAILED");
      await this.run(podArgs(["image", "rm", ref])).catch(() => {});
      throw new LocalRuntimeError(
        "IMAGE_PULL_FAILED",
        `the downloaded image's digest could not be checked, so it was removed: ${withoutCommandLine(err)}`,
      );
    }
    let digests = null;
    try {
      digests = JSON.parse(out);
    } catch {
      // Unreadable output is a failed check, handled below.
    }
    if (Array.isArray(digests) && digests.includes(ref)) return;
    await this.run(podArgs(["image", "rm", ref])).catch(() => {});
    throw new LocalRuntimeError(
      "IMAGE_PULL_FAILED",
      `the downloaded image does not carry the pinned digest ${TURNSTONE_IMAGE.digest}; it was removed`,
    );
  }

  /**
   * ADR-05: the machine's own settings keep the Windows host out of it, and nothing in the machine holds them in
   * place, so they are put back on every start and the gaps they close are checked before the pod runs. A gap, a check
   * that could not run and a restart that failed all stop the start, and each stops a pod left running from before,
   * so the agent never runs on a machine nobody has shown to be safe.
   */
  async _hardenMachine() {
    try {
      await this._assertHardened();
    } catch (err) {
      if (err && UNVERIFIED_MACHINE.has(err.code)) {
        await this.run(podArgs(["pod", "stop", POD])).catch(() => {});
      }
      throw err;
    }
  }

  async _assertHardened() {
    let report = await this._checkMachine();
    this._checkCancelled();
    if (report.wslconf === "rewritten") {
      // The machine reads wsl.conf only when it boots, so a rewritten file means nothing until a restart.
      await this._podman(["machine", "stop", MACHINE], "MACHINE_RESTART_FAILED");
      this._checkCancelled();
      await this._podman(["machine", "start", MACHINE], "MACHINE_RESTART_FAILED");
      this._checkCancelled();
      report = await this._checkMachine();
      this._checkCancelled();
    }
    const gaps = hardeningGaps(report);
    if (gaps.length > 0) throw new LocalRuntimeError("MACHINE_NOT_HARDENED", gaps.join("; "));
  }

  // One run of the machine script, as root. A report without its end line was cut short, so it is a failed check,
  // never a clean machine.
  async _checkMachine() {
    let out;
    try {
      out = await this.run(["machine", "ssh", "--username", "root", MACHINE, machineCheckCommand()]);
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err);
      throw new LocalRuntimeError("MACHINE_CHECK_FAILED", withoutCommandLine(err));
    }
    const report = parseMachineReport(out);
    if (!report.complete) {
      throw new LocalRuntimeError("MACHINE_CHECK_FAILED", "the check stopped before it finished");
    }
    return report;
  }

  // One run of the config script, as root (#1680). The machine makes the secrets, so the report says only whether the
  // file was created, kept or could not be set up. A report without its end line was cut short, so it is a failure,
  // never a written file. It runs under the "pod" stage: the loading page has no label for another.
  async _ensureConfig() {
    let out;
    try {
      out = await this.run(["machine", "ssh", "--username", "root", MACHINE, configCommand()]);
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err);
      throw new LocalRuntimeError("CONFIG_WRITE_FAILED", withoutCommandLine(err));
    }
    const report = parseConfigReport(out);
    if (!report.complete) {
      throw new LocalRuntimeError("CONFIG_WRITE_FAILED", "the script stopped before it finished");
    }
    if (report.config === "failed") {
      throw new LocalRuntimeError(
        "CONFIG_WRITE_FAILED",
        "the machine could not create config.toml, or could not check the one already there",
      );
    }
    if (report.config !== "created" && report.config !== "kept") {
      throw new LocalRuntimeError("CONFIG_WRITE_FAILED", `the script answered config=${report.config ?? "(nothing)"}`);
    }
    return report.config;
  }

  async _podState() {
    let out;
    try {
      out = await this.run(
        podArgs(["pod", "inspect", POD, "--format", "{{.State}}"]),
      );
    } catch (err) {
      if (err && err.code === "ENOENT") throw this._wrap(err);
      throw new LocalRuntimeError("POD_MISSING", withoutCommandLine(err));
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

module.exports = { LocalRuntime, LocalRuntimeError, fetchHealthJson, HEALTH_REDIRECTED, runPodman };
