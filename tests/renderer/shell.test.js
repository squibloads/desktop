import { describe, it, expect, vi, afterEach } from "vitest";
import { loadPage, createFakeBridge, closeAllPages } from "../helpers/load-page.js";

afterEach(() => {
  closeAllPages();
});

// Opens the title bar with the given saved settings. The mode-aware code runs
// in the getSettings promise callback; awaiting the promise the test created
// runs that callback first, since it was attached before this await.
async function openShell({ mode = "both", activeTab = "server", platform = "win32" } = {}) {
  const bridge = createFakeBridge({
    platform,
    settings: {
      mode,
      serverUrl: "http://server.example.test:8080",
      consoleUrl: "http://console.example.test:8090",
      quitBehavior: "stop",
      activeTab,
    },
  });
  const page = loadPage("shell", { api: bridge.api, hub: bridge.hub });
  await bridge.api.getSettings.mock.results[0].value;
  return page;
}

function hasHidden(el) {
  return el.classList.contains("hidden");
}

describe("platform setup", () => {
  // Failure: macOS shows custom minimize, maximize and close buttons beside its native traffic lights.
  it("on macOS, reserves room for the traffic lights and hides the custom controls", async () => {
    const page = await openShell({ platform: "darwin" });

    expect(page.document.getElementById("drag-spacer").style.width).toBe("72px");
    expect(hasHidden(page.document.getElementById("window-controls"))).toBe(true);
  });

  // Failure: Windows and Linux lose their window controls, so the frameless window cannot be minimised or closed.
  it("on Windows and Linux, shows the custom controls and leaves the drag spacer alone", async () => {
    const page = await openShell({ platform: "win32" });

    expect(page.document.getElementById("drag-spacer").style.width).toBe("");
    expect(hasHidden(page.document.getElementById("window-controls"))).toBe(false);
  });
});

describe("health dots", () => {
  // Failure: a dot shows the wrong colour for a status, or its label does not say what the status is, for screen readers and tooltips.
  it.each([
    ["ok", ["health-dot", "connected"], "connected"],
    ["degraded", ["health-dot", "degraded"], "degraded"],
    ["disconnected", ["health-dot", "disconnected"], "disconnected"],
    ["error", ["health-dot", "error"], "error"],
    ["unknown", ["health-dot"], "unknown"],
  ])("status %s gives the dot classes %j and label %s", async (status, classes, label) => {
    const page = await openShell();

    page.hub.emitHealth({ server: status, console: status });

    const serverDot = page.document.getElementById("server-health");
    const consoleDot = page.document.getElementById("console-health");
    expect([...serverDot.classList]).toEqual(classes);
    expect([...consoleDot.classList]).toEqual(classes);
    expect(serverDot.getAttribute("aria-label")).toBe(`Server: ${label}`);
    expect(consoleDot.getAttribute("aria-label")).toBe(`Console: ${label}`);
  });

  // Failure: a disabled service gets a state colour, so a service that is not in use looks broken.
  it("gives a disabled status no state class", async () => {
    const page = await openShell();

    page.hub.emitHealth({ server: "disabled", console: "disabled" });

    expect([...page.document.getElementById("server-health").classList]).toEqual(["health-dot"]);
    expect([...page.document.getElementById("console-health").classList]).toEqual(["health-dot"]);
  });

  // Failure: a dot keeps the colour of the previous status after the status changes.
  it("replaces the previous state class when the status changes", async () => {
    const page = await openShell();

    page.hub.emitHealth({ server: "ok", console: "ok" });
    page.hub.emitHealth({ server: "error", console: "degraded" });

    expect([...page.document.getElementById("server-health").classList]).toEqual(["health-dot", "error"]);
    expect([...page.document.getElementById("console-health").classList]).toEqual(["health-dot", "degraded"]);
  });

  // Failure: Local mode hides the SRV dot, but the README documents it as shown and grey, so the title bar no longer matches the user guide.
  // Deliberate today: shell.js hides a dot only in server and console modes.
  it("shows the server indicator in local mode, as the README documents", async () => {
    const page = await openShell({ mode: "local" });

    expect(hasHidden(page.document.getElementById("server-health-group"))).toBe(false);
  });
});

describe("visible tabs and health groups per mode", () => {
  // Failure: a single-view mode shows the tab strip, or a mode that has tabs hides it, so the user sees tabs that do nothing.
  // Failure: a health group for a service the mode does not use stays on the title bar.
  it.each([
    // mode, tabs hidden, server group hidden, console group hidden
    ["server", true, false, true],
    ["console", true, true, false],
    ["both", false, false, false],
  ])("mode %s: tabs hidden %s, server group hidden %s, console group hidden %s", async (mode, tabs, serverGroup, consoleGroup) => {
    const page = await openShell({ mode });
    const doc = page.document;

    expect(hasHidden(doc.getElementById("tabs"))).toBe(tabs);
    expect(hasHidden(doc.getElementById("server-health-group"))).toBe(serverGroup);
    expect(hasHidden(doc.getElementById("console-health-group"))).toBe(consoleGroup);
  });

  // Failure: local mode shows the tab strip over a single view, which has no second tab to switch to.
  it("hides the tab strip in local mode", async () => {
    const page = await openShell({ mode: "local" });

    expect(hasHidden(page.document.getElementById("tabs"))).toBe(true);
  });
});

describe("active tab", () => {
  // Failure: the highlight does not match the active tab, so the user cannot tell which view is showing.
  it("highlights the saved tab, with its ARIA state and focus stop, and clears the others", async () => {
    const page = await openShell({ mode: "both", activeTab: "console" });
    const server = page.document.querySelector('.tab[data-tab="server"]');
    const console = page.document.querySelector('.tab[data-tab="console"]');

    expect(console.classList.contains("active")).toBe(true);
    expect(console.getAttribute("aria-selected")).toBe("true");
    expect(console.tabIndex).toBe(0);
    expect(server.classList.contains("active")).toBe(false);
    expect(server.getAttribute("aria-selected")).toBe("false");
    expect(server.tabIndex).toBe(-1);
  });

  // Failure: restoring the saved tab writes it back to settings, so every launch rewrites the store with no user action.
  it("restores the saved tab without telling the main process", async () => {
    const page = await openShell({ mode: "both", activeTab: "console" });

    expect(page.api.switchTab).not.toHaveBeenCalled();
  });
});

describe("tab switching", () => {
  // Failure: clicking a tab shows the wrong view, or the main process is told a different tab from the one clicked.
  it("clicking a tab highlights it and calls switchTab with that tab", async () => {
    const page = await openShell({ mode: "both", activeTab: "server" });
    const console = page.document.querySelector('.tab[data-tab="console"]');

    console.click();

    expect(page.api.switchTab.mock.calls).toEqual([["console"]]);
    expect(console.classList.contains("active")).toBe(true);
    expect(page.document.querySelector('.tab[data-tab="server"]').classList.contains("active")).toBe(false);
  });

  // Failure: arrow keys skip a tab or switch the wrong one, so keyboard users cannot reach the Console tab.
  it("ArrowRight from the Server tab switches to Console and tells the main process", async () => {
    const page = await openShell({ mode: "both", activeTab: "server" });
    const server = page.document.querySelector('.tab[data-tab="server"]');

    server.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(page.api.switchTab.mock.calls).toEqual([["console"]]);
    expect(page.document.querySelector('.tab[data-tab="console"]').classList.contains("active")).toBe(true);
  });
});

describe("window controls", () => {
  // Failure: a window control calls the wrong main-process action, so Maximize minimises the window.
  it.each([
    ["btn-minimize", "windowMinimize"],
    ["btn-maximize", "windowMaximize"],
    ["btn-close", "windowClose"],
  ])("%s calls %s and no other control action", async (buttonId, action) => {
    const page = await openShell({ platform: "win32" });

    page.document.getElementById(buttonId).click();

    const called = ["windowMinimize", "windowMaximize", "windowClose"].filter(
      (name) => page.api[name].mock.calls.length > 0,
    );
    expect(called).toEqual([action]);
    expect(page.api[action]).toHaveBeenCalledTimes(1);
  });

  // Failure: macOS gets a second close button that competes with the native traffic lights.
  it("on macOS, the custom controls do nothing", async () => {
    const page = await openShell({ platform: "darwin" });

    page.document.getElementById("btn-close").click();

    expect(page.api.windowClose).not.toHaveBeenCalled();
  });
});
