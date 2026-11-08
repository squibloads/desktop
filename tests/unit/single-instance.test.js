import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

const { claimSingleInstance, bringToFront } = require("../../src/main/single-instance.js");

function fakeApp(granted) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = vi.fn(() => granted);
  return app;
}

function fakeWindow({ minimized = false, visible = true, destroyed = false } = {}) {
  const state = { minimized, visible };
  return {
    state,
    isDestroyed: () => destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    restore: vi.fn(() => {
      state.minimized = false;
    }),
    show: vi.fn(() => {
      state.visible = true;
    }),
    focus: vi.fn(),
  };
}

describe("claimSingleInstance", () => {
  // Failure: the first copy never hears about a second launch, so the user sees nothing happen.
  it("takes the lock and runs onSecondLaunch on each later launch", () => {
    const app = fakeApp(true);
    const onSecondLaunch = vi.fn();

    expect(claimSingleInstance(app, onSecondLaunch)).toBe(true);
    app.emit("second-instance");
    app.emit("second-instance");
    expect(onSecondLaunch).toHaveBeenCalledTimes(2);
  });

  // Failure: a copy that lost the lock still answers launches, so two copies react to every double-click.
  it("returns false and listens for nothing when another copy holds the lock", () => {
    const app = fakeApp(false);
    const onSecondLaunch = vi.fn();

    expect(claimSingleInstance(app, onSecondLaunch)).toBe(false);
    expect(app.listenerCount("second-instance")).toBe(0);
  });

  // Failure: a throw while bringing the window forward escapes into Electron's event loop, and a double-click crashes
  // the copy the user already has open.
  it("logs a handler that throws instead of letting it escape", () => {
    const app = fakeApp(true);
    const failure = new Error("window gone");
    const error = vi.fn();
    claimSingleInstance(
      app,
      () => {
        throw failure;
      },
      { error },
    );

    expect(() => app.emit("second-instance")).not.toThrow();
    expect(error).toHaveBeenCalledWith("second launch: could not bring the window forward:", failure);
  });
});

describe("bringToFront", () => {
  // Failure: a minimized window gets focus but stays on the taskbar, so the second launch looks like it did nothing.
  it("restores a minimized window and focuses it", () => {
    const win = fakeWindow({ minimized: true });

    expect(bringToFront(win)).toBe(true);
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.state.minimized).toBe(false);
    expect(win.focus).toHaveBeenCalledOnce();
  });

  // Failure: a window hidden to the tray stays hidden, so the second launch looks like it did nothing.
  it("shows a hidden window and focuses it", () => {
    const win = fakeWindow({ visible: false });

    expect(bringToFront(win)).toBe(true);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.state.visible).toBe(true);
    expect(win.focus).toHaveBeenCalledOnce();
  });

  // Failure: an open, visible window is restored or re-shown, which on some desktops moves or resizes it.
  it("only focuses a window that is already open and visible", () => {
    const win = fakeWindow();

    expect(bringToFront(win)).toBe(true);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  // Failure: a launch during startup, before the window exists, or after it closed, throws in the first copy.
  it("returns false for a missing or destroyed window", () => {
    expect(bringToFront(null)).toBe(false);
    const gone = fakeWindow({ destroyed: true });
    expect(bringToFront(gone)).toBe(false);
    expect(gone.focus).not.toHaveBeenCalled();
  });
});
