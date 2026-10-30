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
  ["retry sender check", "senderIsConsole: hasConsoleView && isFromAppPage(event, [() => consoleView.webContents], APP_PAGE_ROOT)"],
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
  // Failure: the mode is written before the URLs, so a URL write that throws leaves a mode switch with no rebuild.
  ["save write order", "writeSavePlan(settings, plan.apply);"],
  // Failure: a URL change in the same mode leaves the connection on the old settings.
  ["notification restart", "if (plan.restartNotifications) notificationLifecycle.apply(reachable);"],
  // Failure: quitting leaves a notification connection open.
  ["notification stop on quit", "notificationLifecycle.stop();"],
  // Failure: with no handler, Electron approves every permission a page asks for.
  ["permission request policy", "session.defaultSession.setPermissionRequestHandler("],
  ["permission check policy", "session.defaultSession.setPermissionCheckHandler("],
  // Failure: the handler answers with a constant, so the decision in permissions.js is never used.
  ["permission request decision", "const decision = requestDecision("],
  ["permission request answer", "callback(decision);"],
  ["permission check answer", "return checkDecision("],
  // Failure: a stored address the rule refuses is loaded anyway, so a plain-http server is connected to.
  ["server view loads through the refusal guard", "loadConfigured(serverView, settings.serverUrl);"],
  ["console view loads through the refusal guard", "loadConfigured(consoleView, settings.consoleUrl);"],
  // Failure: the health poller reads the stored settings, so a refused server is polled over http.
  ["health poller reads reachable settings", "new HealthPoller(reachable,"],
  // Failure: the loader drops its check, so a refused stored address is loaded anyway.
  ["loader checks the address before loading", "if (isValidUrl(url)) {"],
  // Failure: the reload on the refusal page loads the stored address directly, so Ctrl+R goes to the refused address.
  ["recovery loads through the refusal guard", "loadConfigured(view, getUrl());"],
  // Failure: a main-frame request to another origin is not cancelled, so a redirect loads it in the view.
  ["session request guard is installed", "session.defaultSession.webRequest.onBeforeRequest("],
  ["request guard uses the view rule", "requestAllowed(details, viewIds, () => settings)"],
  // Failure: the server view is recorded with the console's id, so each view is checked against the other's address.
  ["server view id is the server's", "server: serverView ? serverView.webContents.id : null,"],
  ["console view id is the console's", "console: consoleView ? consoleView.webContents.id : null,"],
  ["request guard answers with the decision", "callback({ cancel: !allowed });"],
  // Failure: a cancelled redirect is shown as a connection error, so the user looks for an outage that is not there.
  ["cancelled redirect shows the redirect refusal", "redirectRefusals.matches(view.webContents.id, validatedURL)"],
  // Failure: the cancelled load is not remembered, so the view shows a connection error instead of the redirect refusal.
  ["cancelled redirect is remembered", "if (!allowed) redirectRefusals.refuse(details.webContentsId, details.url);"],
  // Failure: a refusal outlives the navigation that caused it, so a later outage of the same address reads as a refused redirect.
  ["refusals clear when a navigation starts", 'view.webContents.on("did-start-navigation"'],
  ["a new navigation clears an earlier refusal", "if (isMainFrame) redirectRefusals.navigationStarted(view.webContents.id);"],
  // Failure: a failure in a subframe with the refused address reads as a refused redirect.
  ["refusal match is limited to the main frame", "isMainFrame && redirectRefusals.matches("],
];

// Each bridge handler and the one sender check it must make, with the windows it allows. The check is
// read from the handler's own block, so a check placed in another handler does not satisfy it.
const SHELL_ONLY = "isFromAppPage(event, [() => shellView && shellView.webContents], APP_PAGE_ROOT)";
const SENDER_CHECKS = {
  "turnstone:get-settings": "isFromAppPage(event, [() => shellView && shellView.webContents, () => settingsWindow && settingsWindow.webContents], APP_PAGE_ROOT)",
  "turnstone:save-settings": "isFromAppPage(event, [() => settingsWindow && settingsWindow.webContents], APP_PAGE_ROOT)",
  "turnstone:switch-tab": SHELL_ONLY,
  "turnstone:retry-local": "isFromAppPage(event, [() => consoleView.webContents], APP_PAGE_ROOT)",
  "turnstone:settings-resize": "isFromAppPage(event, [() => settingsWindow.webContents], APP_PAGE_ROOT)",
  "turnstone:open-settings": "isFromAppPage(event, [() => serverView && serverView.webContents, () => consoleView && consoleView.webContents], APP_PAGE_ROOT)",
  "turnstone:window-minimize": SHELL_ONLY,
  "turnstone:window-maximize": SHELL_ONLY,
  "turnstone:window-close": SHELL_ONLY,
};

function handlerBlock(text, channel) {
  const start = text.search(new RegExp(`ipcMain\\.(?:handle|on)\\("${channel}"`));
  if (start < 0) return null;
  return text.slice(start, text.indexOf("\n});", start));
}

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

  // Failure: the old mode keeps alerting when the rebuild throws half way, because its notifications are applied after the window.
  it("applies the notification mode before the window is closed and rebuilt", () => {
    const fn = main.indexOf("function rebuildWindow() {");
    const apply = main.indexOf("notificationLifecycle.apply(reachable);", fn);
    const close = main.indexOf("mainWindow.close();", fn);

    expect(fn).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(fn);
    expect(close).toBeGreaterThan(apply);
  });

  // Failure: a launch or a mode rebuild that skips the apply leaves the mode's notifications unset, or runs them from a stale manager.
  it("applies notifications at launch and on every mode rebuild", () => {
    expect(main.split("notificationLifecycle.apply(reachable);").length - 1).toBe(3);
  });

  // Failure: the permission policy is not imported from electron, so the install call throws before any window is built.
  it("imports session from electron", () => {
    expect(main).toMatch(/^\s*session,\r?$/m);
  });

  // Failure: a page loads before the permission policy is installed, so it is granted whatever it asks for.
  it("installs the permission policy after the app is ready and before the first window is built", () => {
    const ready = main.indexOf("app.whenReady()");
    const install = main.indexOf("installPermissionPolicy();");
    const build = main.indexOf("createMainWindow();", ready);

    expect(install).toBeGreaterThan(ready);
    expect(build).toBeGreaterThan(install);
  });

  // Failure: a handler calls configuredOrigins() eagerly, so every request reads the settings file, even refused ones.
  it("passes configuredOrigins to both handlers as a getter, not a call", () => {
    expect(main.match(/^ {6}configuredOrigins,\r?$/gm) || []).toHaveLength(2);
  });

  // Failure: the install call is moved onto another line or behind a false guard, so the policy is never installed, or is installed after the settings read.
  it("calls the permission policy as its own statement, right before the settings read", () => {
    expect(main).toMatch(/\n {2}installPermissionPolicy\(\);\r?\n {2}installRequestGuard\(\);\r?\n {2}settings = await SettingsStore\.create\(\);/);
  });

  // Failure: the two branches of the loader are swapped, or the refusal loses its reason, so a refused address is loaded or the refusal is unexplained.
  it("loads a valid address in one branch and shows the refusal with its reason in the other", () => {
    expect(main).toMatch(/if \(isValidUrl\(url\)\) \{\r?\n\s+view\.webContents\.loadURL\(url\)\.catch\(\(\) => \{\}\);\r?\n\s+return;/);
    expect(main).toContain('query: errorPageQuery(url, "insecure")');
  });

  // Failure: a bridge handler missing from the table is never checked, so a new handler ships without a sender check.
  it("lists every bridge handler in the sender table", () => {
    const registered = [...main.matchAll(/ipcMain\.(?:handle|on)\("(turnstone:[a-z-]+)"/g)].map((match) => match[1]);
    expect(registered.sort()).toEqual(Object.keys(SENDER_CHECKS).sort());
  });

  // Failure: a bridge handler without its listed check runs for any page that holds the bridge, or checks the wrong windows.
  it.each(Object.entries(SENDER_CHECKS))("%s makes its listed sender check", (channel, check) => {
    expect(handlerBlock(main, channel), channel).toContain(check);
  });

  // Failure: the check is made but its result is ignored, so a refused call still runs. The retry handler reads the check into a flag instead.
  it.each(Object.entries(SENDER_CHECKS).filter(([channel]) => channel !== "turnstone:retry-local"))(
    "%s returns when its check fails",
    (channel, check) => {
      expect(handlerBlock(main, channel), channel).toContain(`if (!${check})`);
    },
  );

  // Failure: a details field is dropped or replaced by a constant in one handler, so the decision is made on facts that are not the request's.
  it("maps each Electron details field into the decision, in each handler", () => {
    const fields = [
      [/^ {8}permission,\r?$/gm, 2],
      [/^ {8}requestingOrigin,\r?$/gm, 1],
      [/^ {8}requestingUrl: details\.requestingUrl,\r?$/gm, 1],
      [/^ {8}topUrl: topUrlOf\(webContents\),\r?$/gm, 2],
      [/^ {8}isMainFrame: details\.isMainFrame,\r?$/gm, 2],
      [/^ {8}mediaTypes: details\.mediaTypes,\r?$/gm, 1],
      [/^ {8}mediaType: details\.mediaType,\r?$/gm, 1],
    ];
    for (const [pattern, expected] of fields) {
      expect((main.match(pattern) || []).length, String(pattern)).toBe(expected);
    }
  });
});
