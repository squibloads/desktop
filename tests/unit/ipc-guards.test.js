import { describe, it, expect } from "vitest";

const { canRetryLocal } = require("../../src/main/ipc-guards.js");

// Only one combination of the four inputs may retry: a live console view,
// sent by that console, with no start already in flight. Every other row is
// refused.
describe("canRetryLocal", () => {
  // Failure: the retry button on the local error page does nothing even though no start is running.
  // Columns: senderIsConsole, hasConsoleView, consoleDestroyed, starting, expected.
  it.each([
    [true, true, false, false, true],
    [true, true, false, true, false],
    [true, true, true, false, false],
    [true, true, true, true, false],
    [true, false, false, false, false],
    [true, false, false, true, false],
    [true, false, true, false, false],
    [true, false, true, true, false],
    [false, true, false, false, false],
    [false, true, false, true, false],
    [false, true, true, false, false],
    [false, true, true, true, false],
    [false, false, false, false, false],
    [false, false, false, true, false],
    [false, false, true, false, false],
    [false, false, true, true, false],
  ])(
    "senderIsConsole=%s hasConsoleView=%s consoleDestroyed=%s starting=%s -> %s",
    (senderIsConsole, hasConsoleView, consoleDestroyed, starting, expected) => {
      expect(canRetryLocal({ senderIsConsole, hasConsoleView, consoleDestroyed, starting })).toBe(expected);
    },
  );

  // Failure: a retry from the first launch is blocked because the runtime has not been created yet, so the local start never begins.
  it("allows a retry when no start has ever run and the runtime is missing", () => {
    expect(
      canRetryLocal({ senderIsConsole: true, hasConsoleView: true, consoleDestroyed: false, starting: undefined }),
    ).toBe(true);
  });

  // Failure: a page in the server view can start the local runtime by sending the retry message.
  it("refuses a retry sent from the server page", () => {
    expect(
      canRetryLocal({ senderIsConsole: false, hasConsoleView: true, consoleDestroyed: false, starting: false }),
    ).toBe(false);
  });

  // Failure: a second start begins while the first is still in flight, so the loading stages are reset mid-run.
  it("refuses a retry while a start is in flight", () => {
    expect(
      canRetryLocal({ senderIsConsole: true, hasConsoleView: true, consoleDestroyed: false, starting: true }),
    ).toBe(false);
  });
});
