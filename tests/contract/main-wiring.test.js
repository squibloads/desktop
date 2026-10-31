import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

// main.js is not run by the tests, so these pin the call shapes that feed the
// pure modules. A wiring slip (swapped arguments, a hard-coded flag, a dropped
// sender check) would pass every unit test of the modules themselves.
const main = readFileSync(join(__dirname, "..", "..", "src", "main", "main.js"), "utf8");

// The modules main.js may load before it drops the switches: electron, for app.commandLine, and the rule itself, which
// loads only the pure runtime-config.js. Any other module could throw first and leave the switches in.
const LOADED_BEFORE_THE_DROP = ["electron", "./debug-switches.js"];

// Whether a declaration only binds what one of LOADED_BEFORE_THE_DROP exports, as `const { a } = require("...")`.
function isEarlyRequire(statement) {
  return (
    statement.type === "VariableDeclaration" &&
    statement.declarations.every(
      ({ init }) =>
        init?.type === "CallExpression" &&
        init.callee.type === "Identifier" &&
        init.callee.name === "require" &&
        LOADED_BEFORE_THE_DROP.includes(init.arguments[0]?.value),
    )
  );
}

// Where main.js drops the switches: whether the `for (const name of switchesToDrop(app.commandLine))` loop is a
// statement of the program itself, whether only the early requires come before it, and whether its body calls
// app.commandLine.removeSwitch(name).
function dropLoopPlacement(source) {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const isDropLoop = (node) =>
    node?.type === "ForOfStatement" &&
    source.slice(node.right.start, node.right.end) === "switchesToDrop(app.commandLine)";
  const index = program.body.findIndex(isDropLoop);
  const loop = program.body[index];
  return {
    topLevel: index >= 0,
    onlyRequiresBefore: index >= 0 && program.body.slice(0, index).every(isEarlyRequire),
    removesEachSwitch:
      index >= 0 && source.slice(loop.body.start, loop.body.end).includes("app.commandLine.removeSwitch(name);"),
  };
}

// How main.js answers a Squirrel install event: whether the plan is read at the top level, from the real command line
// and exe, before whenReady is registered; whether the guard is the first statement of the whenReady callback; whether
// its body is exactly the run, with app.exit as its exit, then a bare return; and whether that callback is the only
// thing the file runs on ready, since another ready handler would start the app beside the guard.
function installEventGuard(source) {
  const program = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const text = (node) => source.slice(node.start, node.end);
  const planAt = program.body.findIndex(
    (node) => text(node) === "const installEvent = installEventPlan(process.argv, process.execPath);",
  );
  const readyAt = program.body.findIndex(
    (node) => node.type === "ExpressionStatement" && text(node).startsWith("app.whenReady().then("),
  );
  const callback = readyAt >= 0 ? program.body[readyAt].expression.arguments[0] : null;
  const first = callback?.body?.body?.[0];
  const isGuard = first?.type === "IfStatement" && first.test.type === "Identifier" && first.test.name === "installEvent";
  const guarded = isGuard && first.consequent.type === "BlockStatement" ? first.consequent.body : [];
  return {
    planReadFirst: planAt >= 0 && planAt < readyAt,
    firstInReady: isGuard,
    runsThePlan:
      guarded.length > 0 && text(guarded[0]) === "runInstallEvent(installEvent, { spawn, exit: (code) => app.exit(code) });",
    returns: guarded.length === 2 && guarded[1].type === "ReturnStatement" && guarded[1].argument === null,
    onlyReadyHandler:
      (source.match(/\bwhenReady\(/g) || []).length === 1 &&
      !/\.(?:on|once|addListener|prependListener|prependOnceListener)\(\s*["'`]ready["'`]/.test(source),
  };
}

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
  // Failure: the manager's status goes nowhere, so a server that refuses notifications is silent again.
  ["notification status is reported", "new NotificationManager(s, { onStatus: showNotificationStatus })"],
  ["notification status reaches the tray", "if (tray) tray.updateNotifications(status);"],
  ["notification status is logged", "if (label) console.log(label);"],
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

/**
 * One handler's text, from its registration to the end of its block. A check outside that block does
 * not count for the handler, so a check placed in another handler cannot satisfy the pin.
 */
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

  // Failure: a packaged build keeps the switches debug-switches.js drops, because main.js drops them inside a callback,
  // a condition or a function, or after another module that could throw first: Electron starts its DevTools server and
  // network service once main.js's top level has run, even after an error there.
  it("drops the switches in a top-level loop, right after loading electron and the rule", () => {
    expect(main).toMatch(/const \{ switchesToDrop \} = require\("\.\/debug-switches\.js"\);/);
    expect(dropLoopPlacement(main)).toEqual({ topLevel: true, onlyRequiresBefore: true, removesEachSwitch: true });
  });

  // Failure: the placement check above passes a loop that never runs at the top level, so it proves nothing.
  it("finds the loop only where it runs at the top level, first", () => {
    const loop = "for (const name of switchesToDrop(app.commandLine)) {\n  app.commandLine.removeSwitch(name);\n}";
    const requires = 'const { app } = require("electron");\nconst { switchesToDrop } = require("./debug-switches.js");\n';

    expect(dropLoopPlacement(`${requires}${loop}`)).toEqual({ topLevel: true, onlyRequiresBefore: true, removesEachSwitch: true });
    expect(dropLoopPlacement(`${requires}app.on("will-finish-launching", () => {\n${loop}\n});`).topLevel).toBe(false);
    expect(dropLoopPlacement(`${requires}if (process.env.NEVER) {\n${loop}\n}`).topLevel).toBe(false);
    expect(dropLoopPlacement(`${requires}function later() {\n${loop}\n}`).topLevel).toBe(false);
    expect(dropLoopPlacement(`${requires}setUp();\n${loop}`).onlyRequiresBefore).toBe(false);
    expect(dropLoopPlacement(`${requires}const { HealthPoller } = require("./health.js");\n${loop}`).onlyRequiresBefore).toBe(false);
    const noRemove = "for (const name of switchesToDrop(app.commandLine)) {\n  console.warn(name);\n}";
    expect(dropLoopPlacement(`${requires}${noRemove}`).removesEachSwitch).toBe(false);
  });

  // Failure: a Squirrel install, update or uninstall opens the full app, starting Local mode or connecting to the
  // server, and gives it no shortcut, because main.js never reads the event, reads it after the window is built, or
  // makes the shortcut call and goes on starting.
  it("answers a Squirrel install event first in whenReady, and starts nothing else", () => {
    expect(main).toMatch(/const \{ installEventPlan, runInstallEvent \} = require\("\.\/install-events\.js"\);/);
    expect(main).toMatch(/const \{ spawn \} = require\("node:child_process"\);/);
    expect(installEventGuard(main)).toEqual({
      planReadFirst: true,
      firstInReady: true,
      runsThePlan: true,
      returns: true,
      onlyReadyHandler: true,
    });
  });

  // Failure: the guard check above passes a guard that is not first, does not return, or runs a plan of its own.
  it("finds the install-event guard only where it runs first and returns", () => {
    const plan = "const installEvent = installEventPlan(process.argv, process.execPath);\n";
    const run = "    runInstallEvent(installEvent, { spawn, exit: (code) => app.exit(code) });\n";
    const ready = (body) => `app.whenReady().then(async () => {\n${body}  createMainWindow();\n});\n`;
    const guard = `  if (installEvent) {\n${run}    return;\n  }\n`;
    const all = { planReadFirst: true, firstInReady: true, runsThePlan: true, returns: true, onlyReadyHandler: true };

    expect(installEventGuard(`${plan}${ready(guard)}`)).toEqual(all);
    expect(installEventGuard(`${ready(guard)}${plan}`).planReadFirst).toBe(false);
    expect(installEventGuard(`${plan.replace("process.argv", "[]")}${ready(guard)}`).planReadFirst).toBe(false);
    expect(installEventGuard(`function later() {\n${plan}}\n${ready(guard)}`).planReadFirst).toBe(false);
    expect(installEventGuard(`${plan}${ready(`  installPermissionPolicy();\n${guard}`)}`).firstInReady).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard.replace("    return;\n", ""))}`).returns).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard.replace("app.exit(code)", "app.quit()"))}`).runsThePlan).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard.replace("(installEvent,", "({ update: null },"))}`).runsThePlan).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard.replace("return;", "return startLocalRuntime();"))}`).returns).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard.replace("    return;\n", "    createMainWindow();\n    return;\n"))}`).returns).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard)}app.on("ready", () => {\n  createMainWindow();\n});\n`).onlyReadyHandler).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard)}app.once('ready', start);\n`).onlyReadyHandler).toBe(false);
    expect(installEventGuard(`${plan}${ready(guard)}app.whenReady().then(start);\n`).onlyReadyHandler).toBe(false);
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
