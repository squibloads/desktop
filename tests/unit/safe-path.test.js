import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPodmanOverride, pathWithoutPodman } from "../helpers/safe-path.js";

// Every case passes its own separator, so the expected strings are the same on Windows and POSIX
// hosts; a Windows temp path contains a colon, so the POSIX separator cannot be assumed.
const SEP = ";";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turnstone-safe-path-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function dirWith(name, files) {
  const dir = join(root, name);
  mkdirSync(dir);
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

describe("pathWithoutPodman", () => {
  // Failure: a real podman on the PATH is found by the app when the fake override is lost, so the smoke tier runs against the user's machine.
  it("drops a directory that holds podman and keeps the others, in order", () => {
    const plain = dirWith("plain", ["node.exe"]);
    const holdsPodman = dirWith("holds-podman", ["podman"]);
    const other = dirWith("other", ["git"]);

    const result = pathWithoutPodman([plain, holdsPodman, other].join(SEP), { platform: "linux", separator: SEP });

    expect(result).toBe([plain, other].join(SEP));
  });

  // Failure: a Windows install of podman (podman.exe, .cmd or .bat) is still reachable through PATH.
  it("drops a directory holding any of the four podman file names", () => {
    const exe = dirWith("exe", ["podman.exe"]);
    const cmd = dirWith("cmd", ["podman.cmd"]);
    const bat = dirWith("bat", ["podman.bat"]);
    const bare = dirWith("bare", ["podman"]);

    const result = pathWithoutPodman([exe, cmd, bat, bare].join(SEP), { platform: "linux", separator: SEP });

    expect(result).toBe("");
  });

  // Failure: on Windows, PODMAN.EXE in a PATH directory is still podman, because the file system ignores case.
  it("matches file names case-insensitively on win32 only", () => {
    const upper = dirWith("upper", ["PODMAN.EXE"]);

    expect(pathWithoutPodman(upper, { platform: "win32", separator: SEP })).toBe("");
    expect(pathWithoutPodman(upper, { platform: "linux", separator: SEP })).toBe(upper);
  });

  // Failure: a quoted PATH entry (a directory with spaces) keeps a podman directory on the path.
  it("drops a quoted entry that holds podman", () => {
    const holdsPodman = dirWith("quoted", ["podman.exe"]);

    const result = pathWithoutPodman(`"${holdsPodman}"`, { platform: "win32", separator: SEP });

    expect(result).toBe("");
  });

  // Failure: the filter drops directories that do not exist, so a PATH with a stale entry loses it silently and the app's own paths shrink.
  it("keeps a directory that does not exist", () => {
    const missing = join(root, "not-there");

    expect(pathWithoutPodman(missing, { platform: "linux", separator: SEP })).toBe(missing);
  });
});

describe("checkPodmanOverride", () => {
  const EXEC = "/usr/bin/node";

  // Failure: the app launches with a TURNSTONE_PODMAN that runs something other than the test's node, so a real podman can be reached.
  it("accepts an array that starts with the node binary", () => {
    const raw = JSON.stringify([EXEC, "fake-podman.js"]);

    expect(checkPodmanOverride(raw, EXEC)).toBeNull();
  });

  // Failure: the override is lost from the child environment, and the app would fall back to a real podman without any signal.
  it("refuses an unset or empty override", () => {
    expect(checkPodmanOverride(undefined, EXEC)).not.toBeNull();
    expect(checkPodmanOverride("", EXEC)).not.toBeNull();
  });

  // Failure: a malformed override is accepted and the app runs its default podman.
  it("refuses a value that is not a JSON array, or is an empty one", () => {
    expect(checkPodmanOverride("not json", EXEC)).not.toBeNull();
    expect(checkPodmanOverride("{}", EXEC)).not.toBeNull();
    expect(checkPodmanOverride("[]", EXEC)).not.toBeNull();
  });

  // Failure: the override starts with podman itself, so the fake is bypassed.
  it("refuses an array whose first element is not the node binary", () => {
    expect(checkPodmanOverride(JSON.stringify(["podman", "machine", "list"]), EXEC)).not.toBeNull();
  });
});
