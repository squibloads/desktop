import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

const { watchSleep } = require("../../src/main/power-events.js");

describe("watchSleep", () => {
  // Failure: a sleep or a wake reaches nothing, so the polls run on dead connections and lag the wake.
  it("runs onSuspend on suspend and onResume on resume, and logs each", () => {
    const power = new EventEmitter();
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const log = vi.fn();
    watchSleep(power, { onSuspend, onResume, log });

    power.emit("suspend");
    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onResume).not.toHaveBeenCalled();
    power.emit("resume");
    expect(onResume).toHaveBeenCalledOnce();
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "power: suspend, polls paused",
      "power: resume, polling now",
    ]);
  });

  // Failure: a handler that throws escapes into Electron's event loop, and the main process crashes on a wake.
  it("logs a handler that throws instead of letting it escape", () => {
    const power = new EventEmitter();
    const failure = new Error("poller gone");
    const error = vi.fn();
    watchSleep(power, {
      onSuspend: () => {
        throw failure;
      },
      onResume: () => {},
      log: () => {},
      error,
    });

    expect(() => power.emit("suspend")).not.toThrow();
    expect(error).toHaveBeenCalledWith("power: suspend handler failed:", failure);
  });
});
