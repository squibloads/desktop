import { describe, it, expect } from "vitest";

const { clampSettingsHeight, isFromWindow, isValidHeight } = require("../../src/main/settings-window.js");

// A 1080-pixel work area leaves a maximum content height of 960 (1080 - 120).
const WORK_AREA = 1080;

describe("clampSettingsHeight", () => {
  // Failure: the settings dialog sizes to its content and the sizes it asks for are kept as-is.
  it("keeps a height inside the bounds", () => {
    expect(clampSettingsHeight(520, WORK_AREA)).toBe(520);
  });

  // Failure: a short settings form shrinks below the minimum and the controls are cut off.
  it("raises a height below 300 to 300", () => {
    expect(clampSettingsHeight(120, WORK_AREA)).toBe(300);
  });

  // Failure: a tall settings form grows past the screen and the buttons cannot be reached.
  it("caps a height at the work area less 120 pixels", () => {
    expect(clampSettingsHeight(2000, WORK_AREA)).toBe(960);
  });

  // Failure: on a small screen the cap drops under the minimum and the dialog is clipped.
  it("never caps below 300 on a small work area", () => {
    expect(clampSettingsHeight(2000, 300)).toBe(300);
  });

  // Failure: a fractional height from the layout code leaves a sub-pixel gap at the bottom of the dialog.
  it("rounds a fractional height to the nearest integer", () => {
    expect(clampSettingsHeight(520.4, WORK_AREA)).toBe(520);
  });

  // Failure: a half-pixel height rounds down and the content is one pixel short.
  it("rounds a half pixel up", () => {
    expect(clampSettingsHeight(520.5, WORK_AREA)).toBe(521);
  });

  // Failure: a non-numeric height from the page sizes the window to NaN and it collapses.
  it.each([NaN, Infinity, -Infinity, "520", null, undefined])(
    "returns null for a non-finite or non-numeric height (%s)",
    (height) => {
      expect(clampSettingsHeight(height, WORK_AREA)).toBeNull();
    },
  );
});

describe("isFromWindow", () => {
  // Failure: the settings window's own resize request is ignored and the dialog never fits its content.
  it("accepts an event sent by the given window contents", () => {
    const contents = { isDestroyed: () => false };
    expect(isFromWindow({ sender: contents }, contents)).toBe(true);
  });

  // Failure: a page in another window (for example the main shell) can resize the settings dialog.
  it("rejects an event sent by different contents", () => {
    const contents = { isDestroyed: () => false };
    const other = { isDestroyed: () => false };
    expect(isFromWindow({ sender: other }, contents)).toBe(false);
  });

  // Failure: a resize from a window that was just closed is applied to a destroyed window and throws.
  it("rejects an event when the window contents are destroyed", () => {
    const contents = { isDestroyed: () => true };
    expect(isFromWindow({ sender: contents }, contents)).toBe(false);
  });

  // Failure: a missing window matches an event with no sender and a resize lands on nothing.
  it("rejects when the window contents are missing, even if the sender is missing too", () => {
    expect(isFromWindow({ sender: undefined }, undefined)).toBe(false);
  });

  // Failure: an event with no sender field is treated as coming from the settings window.
  it("rejects an event with no sender when the window contents exist", () => {
    const contents = { isDestroyed: () => false };
    expect(isFromWindow({}, contents)).toBe(false);
  });

  // Failure: a missing event from a dropped IPC message crashes the resize handler.
  it("rejects a missing event without throwing", () => {
    const contents = { isDestroyed: () => false };
    expect(isFromWindow(undefined, contents)).toBe(false);
  });
});

describe("isValidHeight", () => {
  // Failure: a non-numeric height from the dialog reaches the display lookup and resizes the window to NaN.
  it.each([
    [520, true],
    [0, true],
    [-5, true],
    [NaN, false],
    [Infinity, false],
    ["520", false],
    [null, false],
    [undefined, false],
  ])("isValidHeight(%j) is %s", (height, expected) => {
    expect(isValidHeight(height)).toBe(expected);
  });
});
