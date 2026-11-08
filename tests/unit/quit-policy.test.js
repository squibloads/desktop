import { describe, it, expect } from "vitest";

const { shouldStopPodOnQuit, windowCloseAction } = require("../../src/main/quit-policy.js");

// A runtime this session manages: the pod is running and was inspected.
const MANAGED = { active: true };

describe("shouldStopPodOnQuit", () => {
  // Failure: quitting with stop selected leaves the local pod running in the background.
  it("stops the pod when quit behaviour is stop and this session manages it", () => {
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => "stop", runtime: MANAGED, quitting: false })).toEqual({
      stop: true,
    });
  });

  // Failure: the user chose to keep the pod and it is stopped anyway.
  it("keeps the pod when quit behaviour is keep", () => {
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => "keep", runtime: MANAGED, quitting: false })).toEqual({
      stop: false,
    });
  });

  // Failure: a session that never touched a pod sends a stop to a pod it does not own.
  it("does not stop when this session has no active pod", () => {
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => "stop", runtime: { active: false }, quitting: false })).toEqual({
      stop: false,
    });
  });

  // Failure: quitting in a mode with no local runtime at all throws during quit and the app will not close.
  it("does not stop when there is no runtime object", () => {
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => "stop", runtime: null, quitting: false })).toEqual({
      stop: false,
    });
  });

  // Failure: a second quit request starts a second stop that races the first.
  it("does not stop again once a quit is already in progress", () => {
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => "stop", runtime: MANAGED, quitting: true })).toEqual({
      stop: false,
    });
  });

  // Failure: a stored value that is not exactly "stop" (for example a boolean) stops the pod.
  it("stops only on the exact string stop", () => {
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => true, runtime: MANAGED, quitting: false })).toEqual({
      stop: false,
    });
  });

  // Failure: an unreadable quit setting traps the user in the app because quit throws.
  it("returns the read error and does not stop when the quit behaviour cannot be read", () => {
    const readError = new Error("invalid quitBehavior in settings store: maybe");
    const result = shouldStopPodOnQuit({
      getQuitBehavior: () => {
        throw readError;
      },
      runtime: MANAGED,
      quitting: false,
    });
    expect(result.stop).toBe(false);
    expect(result.error).toBe(readError);
  });

  // Failure: an unreadable setting during an in-progress quit is never reported, so the bad value stays hidden.
  it("reports an unreadable quit behaviour even when a quit is already in progress", () => {
    const readError = new Error("invalid quitBehavior in settings store: x");
    const result = shouldStopPodOnQuit({
      getQuitBehavior: () => {
        throw readError;
      },
      runtime: MANAGED,
      quitting: true,
    });
    expect(result).toEqual({ stop: false, error: readError });
  });

  // Failure: a runtime whose status cannot be read stops quit, leaving the app open with no way out.
  it("returns the error and does not stop when the runtime status cannot be read", () => {
    const readError = new Error("runtime status unavailable");
    const runtime = {
      get active() {
        throw readError;
      },
    };
    const result = shouldStopPodOnQuit({ getQuitBehavior: () => "stop", runtime, quitting: false });
    expect(result).toEqual({ stop: false, error: readError });
  });

  // Failure: quit crashes before settings load (quit during startup) instead of exiting quietly.
  it("does not stop and reports no error when settings are not loaded yet", () => {
    const result = shouldStopPodOnQuit({ getQuitBehavior: () => undefined, runtime: MANAGED, quitting: false });
    expect(result).toEqual({ stop: false });
  });

  // Failure: a user who chose keep still has the runtime inspected during quit, where a throw would block the exit.
  it("does not read the runtime when the quit behaviour is keep", () => {
    const runtime = {
      get active() {
        throw new Error("should not be read");
      },
    };
    expect(shouldStopPodOnQuit({ getQuitBehavior: () => "keep", runtime, quitting: false })).toEqual({ stop: false });
  });
});

describe("windowCloseAction", () => {
  const close = (overrides) =>
    windowCloseAction({ getCloseBehavior: () => "tray", allowClose: false, platform: "win32", ...overrides });

  // Failure: closing the window quits the app and stops the pod, so the next launch starts it again from nothing.
  it("hides the window by default", () => {
    expect(close()).toEqual({ action: "hide" });
  });

  // Failure: a user who chose to quit on close is left with an app still running in the tray.
  it("closes the window when the user chose to quit", () => {
    expect(close({ getCloseBehavior: () => "quit" })).toEqual({ action: "close" });
  });

  // Failure: a quit from the tray, a Windows shutdown or a mode rebuild is cancelled by a hide, so the app cannot quit,
  // blocks the shutdown, or ends up with two windows.
  it("closes the window whenever the close is allowed, whatever the setting", () => {
    expect(close({ allowClose: true })).toEqual({ action: "close" });
  });

  // Failure: macOS, which already keeps the app running after its window closes, is left with a hidden window the Dock
  // icon does not bring back.
  it("leaves macOS to close the window as before", () => {
    expect(close({ platform: "darwin" })).toEqual({ action: "close" });
  });

  // Failure: a stored value that is not exactly "quit" (for example a boolean) quits the app on close.
  it("closes only on the exact string quit", () => {
    expect(close({ getCloseBehavior: () => true })).toEqual({ action: "hide" });
    expect(close({ getCloseBehavior: () => "QUIT" })).toEqual({ action: "hide" });
  });

  // Failure: an unreadable setting throws inside the close handler, and the window neither hides nor closes.
  it("hides, the default, and returns the read error when the setting cannot be read", () => {
    const readError = new Error("invalid closeBehavior in settings store: maybe");
    expect(
      close({
        getCloseBehavior: () => {
          throw readError;
        },
      }),
    ).toEqual({ action: "hide", error: readError });
  });

  // Failure: a close that is allowed still reads the setting, where a throw would block a quit or a shutdown.
  it("does not read the setting when the close is allowed", () => {
    const getCloseBehavior = () => {
      throw new Error("should not be read");
    };
    expect(close({ allowClose: true, getCloseBehavior })).toEqual({ action: "close" });
  });
});
