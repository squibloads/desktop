import { describe, it, expect, vi } from "vitest";

const { buildMenuTemplate } = require("../../src/main/menu-template.js");

const APP_NAME = "Turnstone Desktop";

function makeActions() {
  return {
    mode: "both",
    openSettings: vi.fn(),
    switchTab: vi.fn(),
    reloadActiveView: vi.fn(),
    toggleDevTools: vi.fn(),
  };
}

function build({ isMac, mode = "both", actions = makeActions() } = {}) {
  const template = buildMenuTemplate({ isMac, mode, appName: APP_NAME, actions });
  return { template, actions };
}

function topLevelLabels(template) {
  return template.map((item) => item.label);
}

function submenuOf(template, label) {
  return template.find((item) => item.label === label).submenu;
}

describe("buildMenuTemplate top level", () => {
  // Failure: the macOS app menu is missing, so Quit and Hide disappear from the menu bar.
  it("has an app-name menu first on macOS, and no app-name menu elsewhere", () => {
    expect(topLevelLabels(build({ isMac: true }).template)).toEqual([APP_NAME, "File", "View", "Window"]);
    expect(topLevelLabels(build({ isMac: false }).template)).toEqual(["File", "View", "Window"]);
  });

  // Failure: the app-name menu shows a hard-coded name instead of the running app's name.
  it("uses the supplied appName for the macOS app menu label", () => {
    const template = buildMenuTemplate({
      isMac: true,
      mode: "both",
      appName: "Other App",
      actions: makeActions(),
    });

    expect(topLevelLabels(template)[0]).toEqual("Other App");
  });
});

describe("buildMenuTemplate Settings placement", () => {
  // Failure: on macOS Settings is in File as well as the app menu, or missing from the app menu.
  it("puts Settings in the macOS app menu with CmdOrCtrl+, and not in File", () => {
    const { template, actions } = build({ isMac: true });

    const appMenu = template[0].submenu;
    const settings = appMenu.find((item) => item.label === "Settings…");
    expect(settings.accelerator).toEqual("CmdOrCtrl+,");
    expect(settings.click).toBe(actions.openSettings);
    expect(submenuOf(template, "File")).toEqual([{ role: "close" }]);
  });

  // Failure: on Windows and Linux Settings is missing from File, so the shortcut has no menu entry.
  it("puts Settings at the top of File, followed by a separator and Quit, on non-mac", () => {
    const { template, actions } = build({ isMac: false });

    const file = submenuOf(template, "File");
    expect(file[0].label).toEqual("Settings…");
    expect(file[0].accelerator).toEqual("CmdOrCtrl+,");
    expect(file[0].click).toBe(actions.openSettings);
    expect(file[1]).toEqual({ type: "separator" });
    expect(file[2]).toEqual({ role: "quit" });
    expect(file.length).toEqual(3);
  });
});

describe("buildMenuTemplate Server and Console tab items", () => {
  // Failure: the Server and Console tab items appear in a single-view mode where there is no tab to switch to.
  it.each(["server", "console"])("omits the tab items when mode is %s", (mode) => {
    const { template } = build({ isMac: false, mode });

    const view = submenuOf(template, "View");
    expect(view[0].label).toEqual("Reload");
    expect(view.some((item) => item.label === "Server")).toEqual(false);
    expect(view.some((item) => item.label === "Console")).toEqual(false);
  });

  // Failure: in both mode the tab items are missing, so the user cannot switch views from the keyboard.
  it("shows Server (CmdOrCtrl+1) and Console (CmdOrCtrl+2) at the top of View in both mode", () => {
    const { template, actions } = build({ isMac: false, mode: "both" });

    const view = submenuOf(template, "View");
    expect(view[0].label).toEqual("Server");
    expect(view[0].accelerator).toEqual("CmdOrCtrl+1");
    expect(view[1].label).toEqual("Console");
    expect(view[1].accelerator).toEqual("CmdOrCtrl+2");
    expect(view[2]).toEqual({ type: "separator" });
    expect(view[3].label).toEqual("Reload");

    view[0].click();
    view[1].click();
    expect(actions.switchTab.mock.calls).toEqual([["server"], ["console"]]);
  });
});

describe("buildMenuTemplate View actions", () => {
  // Failure: the Reload shortcut does nothing, or reloads the wrong view.
  it("wires Reload to reloadActiveView with CmdOrCtrl+R", () => {
    const { template, actions } = build({ isMac: false, mode: "server" });

    const reload = submenuOf(template, "View").find((item) => item.label === "Reload");
    expect(reload.accelerator).toEqual("CmdOrCtrl+R");
    reload.click();

    expect(actions.reloadActiveView.mock.calls).toEqual([[]]);
  });

  // Failure: the DevTools shortcut toggles nothing, so the renderer cannot be inspected.
  it("wires Toggle Developer Tools to toggleDevTools with CmdOrCtrl+Shift+I", () => {
    const { template, actions } = build({ isMac: false, mode: "server" });

    const devtools = submenuOf(template, "View").find(
      (item) => item.label === "Toggle Developer Tools",
    );
    expect(devtools.accelerator).toEqual("CmdOrCtrl+Shift+I");
    devtools.click();

    expect(actions.toggleDevTools.mock.calls).toEqual([[]]);
  });
});

describe("buildMenuTemplate Window submenu", () => {
  // Failure: the non-mac Window menu offers Bring All to Front, which only macOS has, or lacks Close.
  it("has Minimize and Close on non-mac", () => {
    const { template } = build({ isMac: false });

    expect(submenuOf(template, "Window")).toEqual([{ role: "minimize" }, { role: "close" }]);
  });

  // Failure: the macOS Window menu lacks Front, so the app window cannot be brought forward.
  it("has Minimize, a separator and Bring All to Front on macOS", () => {
    const { template } = build({ isMac: true });

    expect(submenuOf(template, "Window")).toEqual([
      { role: "minimize" },
      { type: "separator" },
      { role: "front" },
    ]);
  });
});

// One label, role or separator marker per item, so a changed role or a stray separator shows.
function shape(items) {
  return items.map((item) => item.role ?? (item.type === "separator" ? "-" : item.label));
}

describe("buildMenuTemplate full item order", () => {
  // Failure: a role is swapped (zoomOut becomes zoomIn, quit becomes close) or a separator moves, and the menu behaves differently on one platform.
  it("lays out the macOS app menu in order", () => {
    const mac = build({ isMac: true }).template;
    expect(shape(submenuOf(mac, APP_NAME))).toEqual(["about", "-", "Settings…", "-", "hide", "hideOthers", "unhide", "-", "quit"]);
  });

  // Failure: File differs from the platform convention (close vs quit, Settings placement).
  it("lays out File per platform", () => {
    expect(shape(submenuOf(build({ isMac: true }).template, "File"))).toEqual(["close"]);
    expect(shape(submenuOf(build({ isMac: false }).template, "File"))).toEqual(["Settings…", "-", "quit"]);
  });

  // Failure: View loses or reorders zoom and fullscreen entries.
  it("lays out View in order, with tabs only in both mode", () => {
    const tail = ["Reload", "Toggle Developer Tools", "-", "zoomIn", "zoomOut", "resetZoom", "-", "togglefullscreen"];
    expect(shape(submenuOf(build({ isMac: false, mode: "both" }).template, "View"))).toEqual(["Server", "Console", "-", ...tail]);
    expect(shape(submenuOf(build({ isMac: false, mode: "server" }).template, "View"))).toEqual(tail);
  });

  // Failure: the Window menu differs from the platform convention (front vs close).
  it("lays out Window per platform", () => {
    expect(shape(submenuOf(build({ isMac: true }).template, "Window"))).toEqual(["minimize", "-", "front"]);
    expect(shape(submenuOf(build({ isMac: false }).template, "Window"))).toEqual(["minimize", "close"]);
  });
});
