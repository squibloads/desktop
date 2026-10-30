import { describe, it, expect, vi } from "vitest";

const { statusLabel, trayIconName, buildTrayMenuTemplate } = require("../../src/main/tray-status.js");

// Failure: a refused server reads as switched off, so the tray stays green while the server is refused.
describe("refused status in the tray", () => {
  it("labels it, keeps it in the icon decision, and lists it in the menu", () => {
    expect(statusLabel("refused")).toBe("Address refused");
    expect(trayIconName("refused", "ok")).toBe("yellow");
    expect(trayIconName("refused", "disabled")).toBe("red");
    const labels = buildTrayMenuTemplate("refused", "disabled", makeActions())
      .map((item) => item.label)
      .filter(Boolean);
    expect(labels).toContain("Server: Address refused");
  });
});

function makeActions() {
  return {
    showWindow: vi.fn(),
    openSettings: vi.fn(),
    quit: vi.fn(),
  };
}

describe("statusLabel", () => {
  // Failure: the tray menu shows a raw status word, or the wrong word, for a known state.
  it.each([
    ["ok", "Connected"],
    ["degraded", "Degraded"],
    ["error", "Error"],
    ["disconnected", "Disconnected"],
  ])("maps %s to %s", (status, label) => {
    expect(statusLabel(status)).toEqual(label);
  });

  // Failure: an unrecognised or not-yet-reported status shows blank or crashes the menu build.
  it.each(["unknown", "", "bogus"])("maps unrecognised status %j to Unknown", (status) => {
    expect(statusLabel(status)).toEqual("Unknown");
  });
});

describe("trayIconName", () => {
  // Failure: the tray icon disagrees with the rule for the combination of server and console states.
  // Full truth table over server x console. "disabled" entries are excluded from the rule.
  it.each([
    // server, console, icon
    ["ok", "ok", "green"],
    ["ok", "degraded", "yellow"],
    ["ok", "error", "yellow"],
    ["ok", "disconnected", "yellow"],
    ["ok", "unknown", "yellow"],
    ["ok", "disabled", "green"],

    ["degraded", "ok", "yellow"],
    ["degraded", "degraded", "red"],
    ["degraded", "error", "red"],
    ["degraded", "disconnected", "red"],
    ["degraded", "unknown", "red"],
    ["degraded", "disabled", "red"],

    ["error", "ok", "yellow"],
    ["error", "degraded", "red"],
    ["error", "error", "red"],
    ["error", "disconnected", "red"],
    ["error", "unknown", "red"],
    ["error", "disabled", "red"],

    ["disconnected", "ok", "yellow"],
    ["disconnected", "degraded", "red"],
    ["disconnected", "error", "red"],
    ["disconnected", "disconnected", "red"],
    ["disconnected", "unknown", "red"],
    ["disconnected", "disabled", "red"],

    ["unknown", "ok", "yellow"],
    ["unknown", "degraded", "red"],
    ["unknown", "error", "red"],
    ["unknown", "disconnected", "red"],
    ["unknown", "unknown", "red"],
    ["unknown", "disabled", "red"],

    ["disabled", "ok", "green"],
    ["disabled", "degraded", "red"],
    ["disabled", "error", "red"],
    ["disabled", "disconnected", "red"],
    ["disabled", "unknown", "red"],
    ["disabled", "disabled", "red"],
  ])("server %s, console %s gives %s", (server, console_, icon) => {
    expect(trayIconName(server, console_)).toEqual(icon);
  });
});

describe("buildTrayMenuTemplate", () => {
  // Failure: with both surfaces up, the menu hides a status row or reorders the actions.
  it("lists both status rows, then Show Window, Settings and Quit with separators", () => {
    const actions = makeActions();

    expect(buildTrayMenuTemplate("ok", "ok", actions)).toEqual([
      { label: "Server: Connected", enabled: false },
      { label: "Console: Connected", enabled: false },
      { type: "separator" },
      { label: "Show Window", click: actions.showWindow },
      { label: "Settings…", click: actions.openSettings },
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]);
  });

  // Failure: a disabled server still shows a "Server: Unknown" row that the user cannot act on.
  it("omits the server row when the server is disabled", () => {
    const actions = makeActions();

    expect(buildTrayMenuTemplate("disabled", "error", actions)).toEqual([
      { label: "Console: Error", enabled: false },
      { type: "separator" },
      { label: "Show Window", click: actions.showWindow },
      { label: "Settings…", click: actions.openSettings },
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]);
  });

  // Failure: a disabled console still shows a status row for a surface that is not running.
  it("omits the console row when the console is disabled", () => {
    const actions = makeActions();

    expect(buildTrayMenuTemplate("degraded", "disabled", actions)).toEqual([
      { label: "Server: Degraded", enabled: false },
      { type: "separator" },
      { label: "Show Window", click: actions.showWindow },
      { label: "Settings…", click: actions.openSettings },
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]);
  });

  // Failure: with both surfaces disabled, the menu shows status rows for nothing.
  it("has no status rows when both surfaces are disabled", () => {
    const actions = makeActions();

    expect(buildTrayMenuTemplate("disabled", "disabled", actions)).toEqual([
      { type: "separator" },
      { label: "Show Window", click: actions.showWindow },
      { label: "Settings…", click: actions.openSettings },
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]);
  });

  // Failure: a status row is clickable, or a row's label reports the wrong state.
  it("disables every status row and labels it from the status", () => {
    const actions = makeActions();

    const items = buildTrayMenuTemplate("unknown", "disconnected", actions);

    expect(items[0]).toEqual({ label: "Server: Unknown", enabled: false });
    expect(items[1]).toEqual({ label: "Console: Disconnected", enabled: false });
  });

  // Failure: a menu item runs a wrapper or a stale function instead of the action the caller supplied.
  it("uses the supplied action functions as click handlers, by identity", () => {
    const actions = makeActions();

    const items = buildTrayMenuTemplate("ok", "ok", actions);
    const clickable = items.filter((item) => item.click !== undefined);

    expect(clickable.length).toEqual(3);
    expect(clickable[0].click).toBe(actions.showWindow);
    expect(clickable[1].click).toBe(actions.openSettings);
    expect(clickable[2].click).toBe(actions.quit);
  });
});
