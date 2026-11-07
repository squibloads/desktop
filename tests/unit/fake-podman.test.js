import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FAKE_PODMAN = fileURLToPath(new URL("../helpers/fake-podman.js", import.meta.url));

let dir;
let statePath;
let logPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnstone-fake-podman-"));
  statePath = join(dir, "state.json");
  logPath = join(dir, "log.txt");
  writeFileSync(statePath, JSON.stringify({ machine: "running", pod: "Running", failStart: false, failStop: false }));
  writeFileSync(logPath, "");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Runs fake-podman.js the way the app does: node on the script, with the two state variables set.
function callPodman(argv, state = {}) {
  if (Object.keys(state).length > 0) {
    writeFileSync(
      statePath,
      JSON.stringify({ machine: "running", pod: "Running", failStart: false, failStop: false, ...state }),
    );
  }
  return spawnSync(process.execPath, [FAKE_PODMAN, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_PODMAN_STATE: statePath,
      FAKE_PODMAN_LOG: logPath,
      FAKE_PODMAN_STOP_DELAY_MS: "",
    },
  });
}

function logLines() {
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
}

function savedState() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

describe("fake-podman known calls", () => {
  // Failure: the machine check the app makes at every launch returns the wrong shape, so the app reads a running machine as missing.
  it("answers machine list with the machine, and logs the call", () => {
    const result = callPodman(["machine", "list", "--format", "json"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('[{"Name":"turnstone","Running":true}]');
    expect(logLines()).toEqual(["machine list --format json"]);
  });

  // Failure: a stopped machine is not started, so the pod calls that follow fail against a machine that is still down.
  it("starts a stopped machine", () => {
    const result = callPodman(["machine", "start", "turnstone"], { machine: "stopped" });

    expect(result.status).toBe(0);
    expect(savedState().machine).toBe("running");
    expect(logLines()).toEqual(["machine start turnstone"]);
  });

  // Failure: the pod state read at every launch comes back empty, so the app cannot tell whether to start the pod.
  it("reports the pod state for inspect", () => {
    const result = callPodman(
      ["--connection", "turnstone", "pod", "inspect", "turnstone", "--format", "{{.State}}"],
      { pod: "Exited" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Exited");
    expect(logLines()).toEqual(["--connection turnstone pod inspect turnstone --format {{.State}}"]);
  });

  // Failure: a stopped pod is not started, and the console never comes up.
  it("starts a stopped pod", () => {
    const result = callPodman(["--connection", "turnstone", "pod", "start", "turnstone"], { pod: "Exited" });

    expect(result.status).toBe(0);
    expect(savedState().pod).toBe("Running");
    expect(logLines()).toEqual(["--connection turnstone pod start turnstone"]);
  });

  // Failure: the pod is not stopped on quit, so it keeps the machine busy after the user closed the app.
  it("stops the pod, and logs the stop done line after the state change", () => {
    const result = callPodman(["--connection", "turnstone", "pod", "stop", "turnstone"]);

    expect(result.status).toBe(0);
    expect(savedState().pod).toBe("Exited");
    expect(logLines()).toEqual(["--connection turnstone pod stop turnstone", "pod stop done"]);
  });

  // Failure: the machine check the app runs at every launch is refused, so every e2e start fails at the machine stage.
  it("answers the machine check as root with a hardened machine by default", () => {
    const result = callPodman(["machine", "ssh", "--username", "root", "turnstone", "printf %s abc | base64 -d | sh"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("wslconf=ok\nsudo=refused\nend=ok\n");
    expect(logLines()).toEqual(["machine ssh --username root turnstone printf %s abc | base64 -d | sh"]);
  });

  // Failure: no test can show the app refusing a machine with a gap, because the fake only ever answers clean.
  it("answers the machine check with passwordless sudo when hardening is gap", () => {
    const result = callPodman(["machine", "ssh", "--username", "root", "turnstone", "check"], { hardening: "gap" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("wslconf=ok\nsudo=allowed\nend=ok\n");
  });

  // Failure: no test can show the app failing closed when the check cannot run.
  it("fails the machine check when hardening is fails", () => {
    const result = callPodman(["machine", "ssh", "--username", "root", "turnstone", "check"], { hardening: "fails" });

    expect(result.status).toBe(1);
  });

  // Failure: the restart after a rewritten wsl.conf has no stop to call, so the machine is never restarted in a test.
  it("stops a running machine", () => {
    const result = callPodman(["machine", "stop", "turnstone"]);

    expect(result.status).toBe(0);
    expect(savedState().machine).toBe("stopped");
    expect(logLines()).toEqual(["machine stop turnstone"]);
  });
});

describe("fake-podman rejects unknown calls", () => {
  // Failure: a podman call the fake does not know passes silently, so the test that makes it never sees the call's effect.
  it("exits 1 for a call it does not implement", () => {
    const result = callPodman(["machine", "list"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fake-podman: unexpected call: machine list");
    expect(logLines()).toEqual(["machine list"]);
  });

  // Failure: an extra argument is ignored, so a changed command line still looks like the known call.
  it("exits 1 when a known call carries an extra argument", () => {
    const result = callPodman(["machine", "list", "--format", "json", "extra"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fake-podman: unexpected call: machine list --format json extra");
  });

  // Failure: a different connection name is treated as the turnstone pod, so the app's calls to another connection pass silently.
  it("exits 1 when the connection name is different", () => {
    const result = callPodman(["--connection", "other", "pod", "stop", "turnstone"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fake-podman: unexpected call: --connection other pod stop turnstone");
  });

  // Failure: a machine check run as the machine user, or with its script split in pieces, passes as the root check.
  it("exits 1 for a machine check not run as root, or with more than one script argument", () => {
    expect(callPodman(["machine", "ssh", "turnstone", "check"]).status).toBe(1);
    expect(callPodman(["machine", "ssh", "--username", "root", "turnstone", "check", "extra"]).status).toBe(1);
    expect(callPodman(["machine", "ssh", "--username", "root", "turnstone"]).status).toBe(1);
  });

  // Failure: the whole command is passed as one argument, and the fake matches it as if the words were separate arguments.
  it("exits 1 when a call is passed as one argument instead of separate words", () => {
    const result = callPodman(["machine start turnstone"]);

    expect(result.status).toBe(1);
  });
});
