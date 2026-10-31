import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { installEventPlan, runInstallEvent } = require("../../src/main/install-events.js");

// Where Squirrel installs the app for a user, one folder per version, with Update.exe in the folder above.
const ROOT = "C:\\Users\\Pat Doe\\AppData\\Local\\turnstone-desktop";
const EXE = `${ROOT}\\app-0.1.1\\turnstone-desktop.exe`;
const UPDATE = `${ROOT}\\Update.exe`;
const PACKAGED_WINDOWS = { platform: "win32", packaged: true };

// The command line Squirrel starts the app with: the exe, then the event and the version.
const argv = (...args) => [EXE, ...args];

// Runs fn with process.platform reading as the given platform, as main.js's call sees it.
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("installEventPlan", () => {
  // Failure: install or update opens the full app instead of giving it a Start menu and desktop shortcut, so the app
  // has none: Squirrel makes no shortcuts for an exe that says it handles its own events.
  it.each([["--squirrel-install"], ["--squirrel-updated"]])("asks Update.exe for the shortcuts on %s", (event) => {
    expect(installEventPlan(argv(event, "0.1.1"), EXE, PACKAGED_WINDOWS)).toEqual({
      event,
      update: { command: UPDATE, args: ["--createShortcut=turnstone-desktop.exe"] },
    });
  });

  // Failure: uninstall opens the full app and leaves its shortcuts behind, pointing at a removed app.
  it("asks Update.exe to remove the shortcuts on --squirrel-uninstall", () => {
    expect(installEventPlan(argv("--squirrel-uninstall", "0.1.1"), EXE, PACKAGED_WINDOWS)).toEqual({
      event: "--squirrel-uninstall",
      update: { command: UPDATE, args: ["--removeShortcut=turnstone-desktop.exe"] },
    });
  });

  // Failure: an older version an update is about to delete opens in full while the new one runs, or removes the new
  // one's shortcuts.
  it("only exits on --squirrel-obsolete", () => {
    expect(installEventPlan(argv("--squirrel-obsolete", "0.1.0"), EXE, PACKAGED_WINDOWS)).toEqual({
      event: "--squirrel-obsolete",
      update: null,
    });
  });

  // Failure: the first launch after install, or an ordinary one, exits instead of starting the app.
  it.each([
    ["no arguments", argv()],
    ["the first run after install", argv("--squirrel-firstrun")],
    ["another switch", argv("--lang=en")],
    ["a near miss", argv("--squirrel-installer")],
    ["another case", argv("--SQUIRREL-INSTALL", "0.1.1")],
    ["an event after another argument", argv("--lang=en", "--squirrel-install", "0.1.1")],
    ["a name every object has", argv("constructor")],
    ["the prototype key", argv("__proto__")],
  ])("starts normally with %s", (_name, args) => {
    expect(installEventPlan(args, EXE, PACKAGED_WINDOWS)).toBeNull();
  });

  // Failure: a Mac or Linux build, which Squirrel never starts, exits on an argument it was given by hand.
  it.each([["darwin"], ["linux"]])("starts normally on %s", (platform) => {
    expect(installEventPlan(argv("--squirrel-install", "0.1.1"), EXE, { platform, packaged: true })).toBeNull();
  });

  // Failure: an unpackaged run, which has no Update.exe beside it, exits on an argument it was given by hand.
  it("starts normally when unpackaged", () => {
    expect(installEventPlan(argv("--squirrel-install", "0.1.1"), EXE, { platform: "win32", packaged: false })).toBeNull();
  });

  // Failure: the unit tier, which runs from the checkout, counts as packaged.
  it("treats this checkout as unpackaged when the caller does not say", () => {
    expect(withPlatform("win32", () => installEventPlan(argv("--squirrel-install", "0.1.1"), EXE))).toBeNull();
  });

  // Failure: the plan never asks which platform it runs on, or assumes one, so main.js, which does not say, answers no
  // event on Windows or answers them elsewhere.
  it("reads the platform from process.platform when the caller does not say", () => {
    const args = argv("--squirrel-install", "0.1.1");
    expect(withPlatform("win32", () => installEventPlan(args, EXE, { packaged: true }))).toEqual({
      event: "--squirrel-install",
      update: { command: UPDATE, args: ["--createShortcut=turnstone-desktop.exe"] },
    });
    expect(withPlatform("linux", () => installEventPlan(args, EXE, { packaged: true }))).toBeNull();
    expect(withPlatform("darwin", () => installEventPlan(args, EXE, { packaged: true }))).toBeNull();
  });

  describe("for a copy of the module inside app.asar", () => {
    let root;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    // Failure: the plan never asks whether the app is packaged, so main.js, which passes no options, opens the full app
    // on every install event of a release.
    it("plans for the event when called as main.js calls it", () => {
      root = mkdtempSync(join(tmpdir(), "install-events-"));
      const dir = join(root, "resources", "app.asar", "src", "main");
      mkdirSync(dir, { recursive: true });
      for (const file of ["install-events.js", "runtime-config.js"]) {
        copyFileSync(require.resolve(`../../src/main/${file}`), join(dir, file));
      }
      const packaged = createRequire(join(dir, "index.js"))("./install-events.js");

      expect(withPlatform("win32", () => packaged.installEventPlan(argv("--squirrel-install", "0.1.1"), EXE))).toEqual({
        event: "--squirrel-install",
        update: { command: UPDATE, args: ["--createShortcut=turnstone-desktop.exe"] },
      });
    });
  });
});

describe("runInstallEvent", () => {
  // A stand-in for child_process.spawn: records each call and returns a child that emits when the test says.
  function fakeSpawn() {
    const calls = [];
    const spawn = vi.fn((command, args, options) => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      calls.push({ command, args, options, child });
      return child;
    });
    return { spawn, calls };
  }

  const PLAN = { event: "--squirrel-install", update: { command: UPDATE, args: ["--createShortcut=turnstone-desktop.exe"] } };
  let error;
  beforeEach(() => {
    vi.useFakeTimers();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    error.mockRestore();
  });

  // Failure: Update.exe opens a console window over the installer, or is handed pipes nobody reads.
  it("starts Update.exe with no console and no pipes of its own", () => {
    const { spawn, calls } = fakeSpawn();
    runInstallEvent(PLAN, { spawn, exit: vi.fn() });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(UPDATE);
    expect(calls[0].args).toEqual(["--createShortcut=turnstone-desktop.exe"]);
    expect(calls[0].options).toEqual({ stdio: "ignore", windowsHide: true });
  });

  // Failure: the app exits while Update.exe is still working, so an uninstall deletes the install folder under
  // --removeShortcut, and the shortcuts stay.
  it("exits once Update.exe has exited, and not when it starts", () => {
    const { spawn, calls } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent(PLAN, { spawn, exit });

    calls[0].child.emit("spawn");
    expect(exit).not.toHaveBeenCalled();
    calls[0].child.emit("exit", 0, null);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  // Failure: an Update.exe that fails leaves the app running, or its failure goes unlogged.
  it("exits and logs when Update.exe exits with an error", () => {
    const { spawn, calls } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent(PLAN, { spawn, exit });

    calls[0].child.emit("exit", 3, null);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("exited with 3"));
  });

  // Failure: a hung Update.exe holds the installer past Squirrel's own limit, 10 seconds for an uninstall, or forever:
  // Squirrel also waits for the console handles the app passed on to it.
  it("stops Update.exe and exits when it runs for 8 seconds", () => {
    const { spawn, calls } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent(PLAN, { spawn, exit });

    vi.advanceTimersByTime(7999);
    expect(calls[0].child.kill).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(calls[0].child.kill).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("still running"));

    calls[0].child.emit("exit", null, "SIGTERM");
    expect(exit).toHaveBeenCalledOnce();
  });

  // Failure: a kill that throws escapes the timer as an uncaught error, which Electron shows as a dialog over the
  // installer, and the app never exits.
  it("exits when stopping Update.exe throws", () => {
    const { spawn, calls } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent(PLAN, { spawn, exit });
    calls[0].child.kill.mockImplementation(() => {
      throw new Error("kill EPERM");
    });

    expect(() => vi.advanceTimersByTime(8000)).not.toThrow();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("kill EPERM"));
  });

  // Failure: the limit fires after Update.exe has already exited, killing nothing but logging a hang that never was.
  it("stops the limit once Update.exe has exited", () => {
    const { spawn, calls } = fakeSpawn();
    runInstallEvent(PLAN, { spawn, exit: vi.fn() });

    calls[0].child.emit("exit", 0, null);
    vi.advanceTimersByTime(10000);
    expect(calls[0].child.kill).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  // Failure: a missing Update.exe, as in a copy run from the zip, leaves the app running with no window, or crashes it.
  it("exits when Update.exe cannot start", () => {
    const { spawn, calls } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent(PLAN, { spawn, exit });

    calls[0].child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("spawn ENOENT"));
    vi.advanceTimersByTime(10000);
    expect(exit).toHaveBeenCalledOnce();
  });

  // Failure: a spawn that throws instead of emitting leaves the app running with no window.
  it("exits when spawn throws", () => {
    const exit = vi.fn();
    runInstallEvent(PLAN, {
      spawn: () => {
        throw new Error("spawn EINVAL");
      },
      exit,
    });

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("spawn EINVAL"));
  });

  // Failure: a child that reports both an error and an exit exits twice.
  it("exits once when the child reports both", () => {
    const { spawn, calls } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent(PLAN, { spawn, exit });

    calls[0].child.emit("error", new Error("kill failed"));
    calls[0].child.emit("exit", 1, null);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  // Failure: the older version starts Update.exe, or never exits.
  it("exits at once, starting nothing, when the plan has no Update.exe call", () => {
    const { spawn } = fakeSpawn();
    const exit = vi.fn();
    runInstallEvent({ event: "--squirrel-obsolete", update: null }, { spawn, exit });

    expect(spawn).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
