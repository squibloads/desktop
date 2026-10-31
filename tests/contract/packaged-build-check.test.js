import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKED_SWITCHES, controlRunDone, fuseMismatches, judge, packagedApp, packagedRunDone } from "../helpers/packaged-build.mjs";

const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { FuseState } = require("@electron/fuses/dist/constants");

// The fuses entry forge.config.js flips, as tests/contract/fuses.test.js pins it.
const CONFIG = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

// A fuse wire as @electron/fuses reads it from a binary: Electron's defaults, with the given fuses set.
function wire(overrides = {}) {
  const states = {
    [FuseV1Options.RunAsNode]: FuseState.ENABLE,
    [FuseV1Options.EnableCookieEncryption]: FuseState.DISABLE,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.ENABLE,
    [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.ENABLE,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.DISABLE,
    [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.DISABLE,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FuseState.DISABLE,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.ENABLE,
    ...overrides,
  };
  return { version: FuseVersion.V1, ...states };
}

// The wire of a build the plugin flipped as CONFIG says.
const FLIPPED = wire({
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
});

describe("packagedApp", () => {
  let out;
  afterEach(() => {
    if (out) rmSync(out, { recursive: true, force: true });
    out = undefined;
  });

  // Makes out/ with the given files, each path relative to it.
  function makeOut(...files) {
    out = mkdtempSync(join(tmpdir(), "packaged-build-"));
    for (const file of files) {
      mkdirSync(join(out, file, ".."), { recursive: true });
      writeFileSync(join(out, file), "");
    }
    return out;
  }

  // Failure: the check starts or reads the wrong file on a platform, so it fails every release, or checks a binary
  // the release does not ship.
  it("finds the Windows exe", () => {
    makeOut("Turnstone-win32-x64/turnstone-desktop.exe", "make/squirrel.windows/x64/RELEASES");
    expect(packagedApp(out, { platform: "win32", arch: "x64", executableName: "turnstone-desktop" })).toEqual({
      launch: join(out, "Turnstone-win32-x64", "turnstone-desktop.exe"),
      fuses: join(out, "Turnstone-win32-x64", "turnstone-desktop.exe"),
    });
  });

  it("finds the Linux binary", () => {
    makeOut("Turnstone-linux-x64/turnstone-desktop");
    expect(packagedApp(out, { platform: "linux", arch: "x64", executableName: "turnstone-desktop" })).toEqual({
      launch: join(out, "Turnstone-linux-x64", "turnstone-desktop"),
      fuses: join(out, "Turnstone-linux-x64", "turnstone-desktop"),
    });
  });

  // Failure: on macOS the fuses are read from the launcher stub instead of the Electron Framework, which holds them.
  it("finds the macOS bundle, launching its executable and reading its fuses through the bundle", () => {
    makeOut("Turnstone-darwin-arm64/Turnstone.app/Contents/MacOS/turnstone-desktop");
    const app = join(out, "Turnstone-darwin-arm64", "Turnstone.app");
    expect(packagedApp(out, { platform: "darwin", arch: "arm64", executableName: "turnstone-desktop" })).toEqual({
      launch: join(app, "Contents", "MacOS", "turnstone-desktop"),
      fuses: app,
    });
  });

  // Failure: a stale build for another architecture or platform is checked instead of the one just made.
  it("takes only the folder for this platform and architecture", () => {
    makeOut("Turnstone-win32-arm64/turnstone-desktop.exe", "Turnstone-win32-x64/turnstone-desktop.exe", "Turnstone-linux-x64/turnstone-desktop");
    expect(packagedApp(out, { platform: "win32", arch: "x64", executableName: "turnstone-desktop" }).launch).toBe(
      join(out, "Turnstone-win32-x64", "turnstone-desktop.exe"),
    );
  });

  // Failure: with no build, or two, the check picks one at random or passes having checked nothing.
  it("refuses when there is no build folder, or more than one", () => {
    makeOut("make/zip/x.zip");
    expect(() => packagedApp(out, { platform: "linux", arch: "x64", executableName: "turnstone-desktop" })).toThrow(/no packaged build/);
    rmSync(out, { recursive: true, force: true });
    makeOut("Turnstone-linux-x64/turnstone-desktop", "Other-linux-x64/turnstone-desktop");
    expect(() => packagedApp(out, { platform: "linux", arch: "x64", executableName: "turnstone-desktop" })).toThrow(/2 packaged builds/);
  });

  // Failure: a renamed executable makes the check launch nothing and report a clean result.
  it("refuses when the executable is missing", () => {
    makeOut("Turnstone-win32-x64/other.exe");
    expect(() => packagedApp(out, { platform: "win32", arch: "x64", executableName: "turnstone-desktop" })).toThrow(/turnstone-desktop\.exe/);
  });

  // Failure: a file whose name ends like a build folder counts as a second build, so a good release fails.
  it("counts only folders as builds", () => {
    makeOut("Turnstone-linux-x64/turnstone-desktop", "notes-linux-x64");
    expect(packagedApp(out, { platform: "linux", arch: "x64", executableName: "turnstone-desktop" }).launch).toBe(
      join(out, "Turnstone-linux-x64", "turnstone-desktop"),
    );
  });

  // Failure: on macOS, a folder with no bundle, or two, is checked at random or not at all.
  it("refuses a macOS folder without exactly one bundle", () => {
    makeOut("Turnstone-darwin-arm64/readme.txt");
    expect(() => packagedApp(out, { platform: "darwin", arch: "arm64", executableName: "turnstone-desktop" })).toThrow(/one \.app.*found 0/);
    rmSync(out, { recursive: true, force: true });
    makeOut("Turnstone-darwin-arm64/A.app/Contents/MacOS/turnstone-desktop", "Turnstone-darwin-arm64/B.app/Contents/MacOS/turnstone-desktop");
    expect(() => packagedApp(out, { platform: "darwin", arch: "arm64", executableName: "turnstone-desktop" })).toThrow(/one \.app.*found 2/);
  });

  // Failure: a macOS bundle whose executable has another name is launched as nothing, and reports a clean result.
  it("refuses a macOS bundle without the executable", () => {
    makeOut("Turnstone-darwin-arm64/Turnstone.app/Contents/MacOS/Turnstone");
    expect(() => packagedApp(out, { platform: "darwin", arch: "arm64", executableName: "turnstone-desktop" })).toThrow(/no turnstone-desktop/);
  });
});

describe("fuseMismatches", () => {
  // Failure: a build the plugin flipped is reported as wrong, so every release fails.
  it("finds none when the binary matches the config", () => {
    expect(fuseMismatches(FLIPPED, CONFIG)).toEqual([]);
  });

  // Failure: a release ships with Electron's defaults, because the plugin did not run, and the check does not notice.
  it("names every fuse a build left at its default", () => {
    expect(fuseMismatches(wire(), CONFIG)).toEqual([
      "RunAsNode: expected off, found on",
      "EnableNodeOptionsEnvironmentVariable: expected off, found on",
      "EnableNodeCliInspectArguments: expected off, found on",
      "EnableEmbeddedAsarIntegrityValidation: expected on, found off",
      "OnlyLoadAppFromAsar: expected on, found off",
    ]);
  });

  // Failure: one fuse flipped back is missed among the others.
  it("names a single fuse that differs", () => {
    expect(fuseMismatches({ ...FLIPPED, [FuseV1Options.RunAsNode]: FuseState.ENABLE }, CONFIG)).toEqual([
      "RunAsNode: expected off, found on",
    ]);
  });

  // Failure: a fuse Electron removed, or a wire too short to hold it, reads as matching.
  it("counts a removed or missing fuse as a mismatch", () => {
    expect(fuseMismatches({ ...FLIPPED, [FuseV1Options.RunAsNode]: FuseState.REMOVED }, CONFIG)).toEqual([
      "RunAsNode: expected off, found removed",
    ]);
    const short = { ...FLIPPED };
    delete short[FuseV1Options.OnlyLoadAppFromAsar];
    expect(fuseMismatches(short, CONFIG)).toEqual(["OnlyLoadAppFromAsar: expected on, found missing"]);
  });

  // Failure: a byte that is no known state reads as matching.
  it("counts an unknown state as a mismatch", () => {
    expect(fuseMismatches({ ...FLIPPED, [FuseV1Options.RunAsNode]: 0 }, CONFIG)).toEqual(["RunAsNode: expected off, found state 0"]);
  });

  // Failure: a wire of another version is read with V1's layout.
  it("refuses a wire of another version", () => {
    expect(fuseMismatches({ ...FLIPPED, version: "2" }, CONFIG)).toEqual(["fuse wire version: expected 1, found 2"]);
  });

  // Failure: the fuses the config does not set are compared, so Electron's own defaults fail the check.
  it("ignores the fuses the config does not set", () => {
    expect(fuseMismatches({ ...FLIPPED, [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE }, CONFIG)).toEqual([]);
  });
});

describe("judge", () => {
  // What a packaged build that drops the switches reports, and what an unpackaged control that keeps them reports.
  const GUARDED = {
    running: true,
    connections: 2,
    devtoolsAnswered: false,
    netLogWritten: false,
    keyLogWritten: false,
    requestsReached: 0,
    ignored: [...CHECKED_SWITCHES],
  };
  const CONTROL = { running: true, connections: 1, devtoolsAnswered: true, netLogWritten: true, keyLogWritten: true, requestsReached: 1, ignored: [] };

  // Failure: a good build fails the release.
  it("passes a packaged build that drops every switch, beside a control that keeps them", () => {
    expect(judge({ packaged: GUARDED, control: CONTROL })).toEqual([]);
  });

  // Failure: a release keeps a switch and the check passes it.
  it.each([
    ["DevTools answered", { devtoolsAnswered: true }, "packaged build: DevTools answered on --remote-debugging-port"],
    ["the net log was written", { netLogWritten: true }, "packaged build: --log-net-log wrote its file"],
    ["the key log was written", { keyLogWritten: true }, "packaged build: --ssl-key-log-file wrote its file"],
    ["one request passed the certificate check", { requestsReached: 1 }, "packaged build: 1 request reached the self-signed server under --ignore-certificate-errors"],
    ["requests passed the certificate check", { requestsReached: 2 }, "packaged build: 2 requests reached the self-signed server under --ignore-certificate-errors"],
  ])("fails a packaged build when %s", (_name, change, failure) => {
    expect(judge({ packaged: { ...GUARDED, ...change }, control: CONTROL })).toEqual([failure]);
  });

  // Failure: a build that crashed at start drops nothing because it ran nothing, and passes.
  it("fails a packaged build that did not keep running", () => {
    expect(judge({ packaged: { ...GUARDED, running: false }, control: CONTROL })).toEqual([
      "packaged build: exited before the end of the run",
    ]);
  });

  // Failure: a packaged build whose main process threw after the drop loop sits behind Electron's error dialog: it
  // still runs and logs every switch as ignored, but it never opens a connection, so the certificate and key-log
  // probes saw nothing and it passes.
  it("fails a packaged build that never connected to the server", () => {
    expect(judge({ packaged: { ...GUARDED, connections: 0 }, control: CONTROL })).toEqual([
      "packaged build: never connected to the self-signed server, so the certificate and key-log probes saw nothing",
    ]);
  });

  // Failure: the guard drops the switches without saying so, or a switch is dropped by something else.
  it("fails a packaged build that did not log each switch it ignored", () => {
    expect(judge({ packaged: { ...GUARDED, ignored: ["remote-debugging-port"] }, control: CONTROL })).toEqual([
      "packaged build: did not log ignoring --log-net-log, --ssl-key-log-file, --ignore-certificate-errors",
    ]);
  });

  // Failure: the probes are blind on this runner (no TLS, no port, no file written even without the guard), so a
  // build that keeps the switches would pass too.
  it.each([
    ["DevTools never answered", { devtoolsAnswered: false }, "control: DevTools never answered, so the port probe sees nothing"],
    ["no net log was written", { netLogWritten: false }, "control: --log-net-log wrote nothing, so the file probe sees nothing"],
    ["no key log was written", { keyLogWritten: false }, "control: --ssl-key-log-file wrote nothing, so no TLS handshake took place"],
    ["no request reached the server", { requestsReached: 0 }, "control: no request reached the self-signed server, so the certificate probe sees nothing"],
    ["it did not keep running", { running: false }, "control: exited before the end of the run"],
  ])("fails when the control shows %s", (_name, change, failure) => {
    expect(judge({ packaged: GUARDED, control: { ...CONTROL, ...change } })).toEqual([failure]);
  });

  // Failure: the packaged run is stopped before it has had the chance to show a switch's effect, or runs until the cap
  // when it had long reached the server.
  it("ends the packaged run once the app has connected twice", () => {
    expect(packagedRunDone({ ...GUARDED, connections: 1 })).toBe(false);
    expect(packagedRunDone({ ...GUARDED, connections: 2 })).toBe(true);
    expect(packagedRunDone({ ...GUARDED, connections: 5 })).toBe(true);
  });

  // Failure: the control is stopped before every effect shows, so a slow runner fails a good build; or it runs on to
  // the cap after all four have shown.
  it("ends the control run once it has shown every effect", () => {
    expect(controlRunDone(CONTROL)).toBe(true);
    for (const missing of [{ devtoolsAnswered: false }, { netLogWritten: false }, { keyLogWritten: false }, { requestsReached: 0 }]) {
      expect(controlRunDone({ ...CONTROL, ...missing })).toBe(false);
    }
  });

  // Failure: the probed switches drift from the ones the guard drops.
  it("probes switches that the guard drops", async () => {
    const { switchesToDrop } = require("../../src/main/debug-switches.js");
    const commandLine = { hasSwitch: (name) => CHECKED_SWITCHES.includes(name) };
    expect(switchesToDrop(commandLine, true)).toEqual(CHECKED_SWITCHES);
  });
});
