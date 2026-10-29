import { describe, it, expect } from "vitest";

const { contentBounds, tabBarBounds, planLayout, planTabSwitch } = require("../../src/main/layout.js");

describe("contentBounds", () => {
  // Failure: the page sits under the tab bar and its top row of controls is hidden.
  it("places content directly under a 36 pixel tab bar", () => {
    expect(contentBounds(1200, 800, 36)).toEqual({ x: 0, y: 36, width: 1200, height: 764 });
  });

  // Failure: a window resized to a different size leaves the page at its old size until the next resize.
  it("uses the given width unchanged", () => {
    expect(contentBounds(640, 480, 36)).toEqual({ x: 0, y: 36, width: 640, height: 444 });
  });

  // Failure: a window shorter than the tab bar gets content bounds different from the previous layout code.
  // The height is passed through as negative, as before; it is not clamped here.
  it("keeps a negative height when the window is shorter than the tab bar", () => {
    expect(contentBounds(800, 20, 36)).toEqual({ x: 0, y: 36, width: 800, height: -16 });
  });
});

describe("tabBarBounds", () => {
  // Failure: the tab bar is drawn below the page or at a different width from the window.
  it("places the tab bar at the top across the full width", () => {
    expect(tabBarBounds(1200, 36)).toEqual({ x: 0, y: 0, width: 1200, height: 36 });
  });
});

describe("planLayout", () => {
  // Failure: the single-view window lays out the server view when the server is not configured.
  // Columns: isSingleView, hasServer, activeTab, hasServerView, hasConsoleView, expected view.
  it.each([
    [true, true, "server", true, true, "server"],
    [true, true, "console", true, true, "server"],
    [true, true, "server", true, false, "server"],
    [true, true, "server", false, true, null],
    [true, false, "server", true, true, "console"],
    [true, false, "server", false, true, "console"],
    [true, false, "server", true, false, null],
    [true, false, "server", false, false, null],
  ])(
    "single view isSingleView=%s hasServer=%s activeTab=%s hasServerView=%s hasConsoleView=%s -> %s",
    (isSingleView, hasServer, activeTab, hasServerView, hasConsoleView, expected) => {
      const plan = planLayout({ isSingleView, hasServer, activeTab, hasServerView, hasConsoleView });
      expect(plan).toBe(expected);
    },
  );

  // Failure: in tab mode the server page is resized while the console tab is the one on screen.
  // Columns: isSingleView, hasServer, activeTab, hasServerView, hasConsoleView, expected view.
  it.each([
    [false, true, "server", true, true, "server"],
    [false, true, "server", false, true, "console"],
    [false, true, "server", false, false, null],
    [false, true, "console", true, true, "console"],
    [false, true, "console", true, false, null],
    [false, true, "console", false, true, "console"],
    [false, true, "console", false, false, null],
    [false, false, "console", true, true, "console"],
    [false, false, "server", true, true, "server"],
    [false, false, "server", false, true, "console"],
  ])(
    "tab mode isSingleView=%s hasServer=%s activeTab=%s hasServerView=%s hasConsoleView=%s -> %s",
    (isSingleView, hasServer, activeTab, hasServerView, hasConsoleView, expected) => {
      const plan = planLayout({ isSingleView, hasServer, activeTab, hasServerView, hasConsoleView });
      expect(plan).toBe(expected);
    },
  );

  // Failure: an unexpected active tab value leaves the visible page at its old size.
  it("treats an unrecognised active tab as the console tab", () => {
    expect(
      planLayout({ isSingleView: false, hasServer: true, activeTab: "__proto__", hasServerView: true, hasConsoleView: true }),
    ).toBe("console");
  });
});

describe("planTabSwitch", () => {
  // Failure: a tab click in a single-view window swaps the views and leaves a blank window.
  it("does not switch in single view", () => {
    expect(planTabSwitch({ isSingleView: true, activeTab: "server", tab: "console" })).toEqual({ switch: false });
  });

  // Failure: clicking the tab already on screen removes and re-adds its view and resets the layout.
  it("does not switch to the tab already active", () => {
    expect(planTabSwitch({ isSingleView: false, activeTab: "server", tab: "server" })).toEqual({ switch: false });
  });

  // Failure: clicking Console in tab mode does not bring the console page to the front.
  it("switches from server to console", () => {
    expect(planTabSwitch({ isSingleView: false, activeTab: "server", tab: "console" })).toEqual({
      switch: true,
      tab: "console",
    });
  });

  // Failure: clicking Server in tab mode does not bring the server page back.
  it("switches from console to server", () => {
    expect(planTabSwitch({ isSingleView: false, activeTab: "console", tab: "server" })).toEqual({
      switch: true,
      tab: "server",
    });
  });

  // Failure: a message from the page naming a tab that does not exist swaps the views to nothing.
  it("does not switch to an unknown tab name", () => {
    expect(planTabSwitch({ isSingleView: false, activeTab: "server", tab: "settings" })).toEqual({ switch: false });
  });

  // Failure: a tab name with a different case is accepted and the view is swapped to an unexpected page.
  it("does not switch on a differently-cased tab name", () => {
    expect(planTabSwitch({ isSingleView: false, activeTab: "server", tab: "Console" })).toEqual({ switch: false });
  });

  // Failure: a non-string tab from the page (for example undefined from a bad call) swaps the views.
  it.each([undefined, null, 0, ["console"], "__proto__", "constructor", "toString"])(
    "does not switch for the non-tab value %j",
    (tab) => {
      expect(planTabSwitch({ isSingleView: false, activeTab: "server", tab })).toEqual({ switch: false });
    },
  );
});
