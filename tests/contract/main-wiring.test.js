import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// main.js is not run by the tests, so these pin the call shapes that feed the
// pure modules. A wiring slip (swapped arguments, a hard-coded flag, a dropped
// sender check) would pass every unit test of the modules themselves.
const main = readFileSync(join(__dirname, "..", "..", "src", "main", "main.js"), "utf8");

const shapes = [
  // Failure: swapped width and height put the page in the wrong place.
  ["content bounds", "contentBounds(width, height, TAB_BAR_HEIGHT)"],
  // Failure: a wrong tab bar size shifts or clips the whole window.
  ["tab bar bounds", "tabBarBounds(width, TAB_BAR_HEIGHT)"],
  // Failure: a fixed answer lets any window trigger the local start.
  ["retry sender check", "senderIsConsole: hasConsoleView && isFromWindow(event, consoleView.webContents)"],
  // Failure: ignoring the configured URL lets the page navigate anywhere.
  ["navigation setting", "if (!isNavigationAllowed(allowedUrl, url)) {"],
  ["allowed url source", "allowedUrl = settings[settingKey];"],
  // Failure: a fixed flag lays out a view that does not exist.
  ["layout single view", "isSingleView: settings.isSingleView,"],
  ["layout server view", "hasServerView: Boolean(serverView),"],
  ["layout console view", "hasConsoleView: Boolean(consoleView),"],
  ["layout server flag", "hasServer: settings.hasServer,"],
  ["layout active tab", "    activeTab,"],
  // Failure: switching on the requested tab instead of the planned one.
  ["tab switch plan", 'if (plan.tab === "server")'],
];

describe("main.js wiring", () => {
  it.each(shapes)("keeps the %s call shape", (_name, text) => {
    expect(main.includes(text)).toBe(true);
  });

  // Failure: the startup check is not imported or the dialog is not required, so the call throws and the app never reaches its window.
  it("imports firstConfigError from runtime-config.js and dialog from electron", () => {
    expect(main).toMatch(/const \{ firstConfigError \} = require\("\.\/runtime-config\.js"\);/);
    expect(main).toMatch(/^\s*dialog,\r?$/m);
  });

  // Failure: a bad override reaches SettingsStore or the windows before it is seen, so the error shows up later as a broken Local mode instead of a startup error.
  it("validates both overrides first in whenReady, before SettingsStore.create, and exits when they are bad", () => {
    const ready = main.indexOf("app.whenReady().then(async () => {");
    const check = main.indexOf("const configError = firstConfigError();");
    const exit = main.indexOf("app.exit(1);", check);
    const create = main.indexOf("settings = await SettingsStore.create();");

    expect(ready).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(ready);
    expect(exit).toBeGreaterThan(check);
    expect(create).toBeGreaterThan(exit);
  });

  // Failure: the LocalRuntime is built outside the try, so a construction error skips the UNEXPECTED error page and the console view stays blank.
  it("builds the LocalRuntime inside the try in startLocalRuntime", () => {
    const fn = main.indexOf("async function startLocalRuntime()");
    const tryAt = main.indexOf("try {", fn);
    const build = main.indexOf("if (!localRuntime) localRuntime = new LocalRuntime(", fn);
    const catchAt = main.indexOf("} catch (err) {", fn);

    expect(fn).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(tryAt);
    expect(build).toBeLessThan(catchAt);
  });

  // Failure: the open handler runs when the rule says no, opening links the rule rejected.
  it("opens external links only when the rule allows them, in both handlers", () => {
    const hits = main.match(/if \(windowOpenAction\(url\)\.open\) \{/g) || [];
    expect(hits.length).toBe(2);
  });

  // Failure: a stopped notification manager stays in its variable, so the save handler restarts it and reconnects to the old server.
  it("clears the notification manager before the window is rebuilt builds a new one", () => {
    const fn = main.indexOf("function rebuildWindow() {");
    const clear = main.indexOf("notifications = null;", fn);
    const build = main.indexOf("notifications = new NotificationManager(settings);", fn);

    expect(fn).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(fn);
    expect(build).toBeGreaterThan(clear);
  });
});
