import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FAKE_PODMAN = fileURLToPath(new URL("../helpers/fake-podman.js", import.meta.url));
const { configCommand } = require("../../src/main/turnstone-config.js");

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

  // Failure: every e2e first run fails at the config step, or the fake answers the config script with a hardening
  // report, so a first run never reaches the missing pod.
  it("answers the config script as root with a written file by default", () => {
    const result = callPodman(["machine", "ssh", "--username", "root", "turnstone", configCommand()]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("config=created\nend=ok\n");
  });

  // Failure: no e2e test can show a kept file, or the app refusing a script that failed or could not run.
  it("answers the config script with kept or failed when config says so, and exits 1 when it is fails", () => {
    const argv = ["machine", "ssh", "--username", "root", "turnstone", configCommand()];
    expect(callPodman(argv, { config: "kept" }).stdout).toBe("config=kept\nend=ok\n");
    expect(callPodman(argv, { config: "failed" }).stdout).toBe("config=failed\nend=ok\n");
    expect(callPodman(argv, { config: "fails" }).status).toBe(1);
  });

  // Failure: the restart after a rewritten wsl.conf has no stop to call, so the machine is never restarted in a test.
  it("stops a running machine", () => {
    const result = callPodman(["machine", "stop", "turnstone"]);

    expect(result.status).toBe(0);
    expect(savedState().machine).toBe("stopped");
    expect(logLines()).toEqual(["machine stop turnstone"]);
  });

  // Failure: the version check before a create gets no version, so every create test fails before it starts.
  it("answers the client version, 6.1.4 by default or the version the state names", () => {
    expect(callPodman(["version", "--format", "{{.Client.Version}}"]).stdout.trim()).toBe("6.1.4");
    expect(callPodman(["version", "--format", "{{.Client.Version}}"], { podmanVersion: "6.0.2" }).stdout.trim()).toBe(
      "6.0.2",
    );
  });

  // Failure: a create leaves the machine missing, so the start after it fails as if nothing was made.
  it("creates a missing machine as stopped", () => {
    const result = callPodman(["machine", "init", "turnstone", "--username", "user"], { machine: "missing" });

    expect(result.status).toBe(0);
    expect(savedState().machine).toBe("stopped");
  });

  // Failure: a failed create cannot be tested, so the app's cleanup and its error page go unchecked.
  it("fails a create when failInit is set, leaving a half-made machine", () => {
    const result = callPodman(["machine", "init", "turnstone", "--username", "user"], { machine: "missing", failInit: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error:");
    expect(savedState().machine).toBe("stopped");
  });

  // Failure: the cleanup after a failed create leaves the half-made machine, so Retry meets it again.
  it("removes the machine", () => {
    const result = callPodman(["machine", "rm", "--force", "turnstone"], { machine: "stopped" });

    expect(result.status).toBe(0);
    expect(savedState().machine).toBe("missing");
  });

  // Failure: creating over an existing machine succeeds in the fake, so a test misses the app creating twice.
  it("refuses to create a machine that exists", () => {
    const result = callPodman(["machine", "init", "turnstone", "--username", "user"], { machine: "running" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
  });
});

describe("fake-podman image calls", () => {
  const PINNED = require("../../src/main/turnstone-image.js").pinnedImageRef();
  const conn = (...rest) => ["--connection", "turnstone", ...rest];

  // Failure: the image check before a pull has no answer, so every first-run test fails before it starts.
  it("answers image exists with 0 when the image is there and 1 when it is not", () => {
    expect(callPodman(conn("image", "exists", PINNED)).status).toBe(0);
    expect(callPodman(conn("image", "exists", PINNED), { image: "missing" }).status).toBe(1);
  });

  // Failure: a pull leaves the image missing, so the digest check after it fails as if nothing came down.
  it("pulls the pinned image", () => {
    const result = callPodman(conn("pull", PINNED), { image: "missing" });

    expect(result.status).toBe(0);
    expect(savedState().image).toBe("present");
  });

  // Failure: a failed pull cannot be tested, so the app's error page for it goes unchecked.
  it("fails a pull when failPull is set, leaving the image missing", () => {
    const result = callPodman(conn("pull", PINNED), { image: "missing", failPull: true });

    expect(result.status).toBe(1);
    expect(savedState().image).toBe("missing");
  });

  // Failure: the digest check has nothing to read, or cannot be shown a wrong digest.
  it("lists the image's digests, without the pinned one when wrongDigest is set", () => {
    const args = conn("image", "inspect", PINNED, "--format", "{{json .RepoDigests}}");
    expect(JSON.parse(callPodman(args).stdout)).toContain(PINNED);
    expect(JSON.parse(callPodman(args, { wrongDigest: true }).stdout)).not.toContain(PINNED);
  });

  // Failure: an image refused for its digest stays in storage, and the next start finds it "there" and uses it.
  it("removes the image", () => {
    const result = callPodman(conn("image", "rm", PINNED));

    expect(result.status).toBe(0);
    expect(savedState().image).toBe("missing");
  });

  // Failure: a pull by tag, or of another image, passes as the pinned pull.
  it("rejects a pull of anything but the pinned reference", () => {
    const result = callPodman(conn("pull", "ghcr.io/turnstonelabs/turnstone:1.9.1"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fake-podman: unexpected call");
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
