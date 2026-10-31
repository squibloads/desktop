const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  screen,
  dialog,
  session,
} = require("electron");
const { switchesToDrop } = require("./debug-switches.js");

// A packaged build drops the launch switches that reach its signed-in views; see debug-switches.js. This runs first,
// before any other module loads: Electron reads them once this file's top level has run, even if something here throws.
// The line goes to the console that started the app, if any.
for (const name of switchesToDrop(app.commandLine)) {
  app.commandLine.removeSwitch(name);
  console.warn(`Ignored --${name}: a packaged build does not accept it.`);
}

const path = require("path");
const { SettingsStore } = require("./settings-store.js");
const { HealthPoller } = require("./health.js");
const { setupMenu } = require("./menu.js");
const { TurnStoneTray } = require("./tray.js");
const { notificationLabel } = require("./tray-status.js");
const { NotificationManager, createNotificationLifecycle } = require("./notifications.js");
const { LocalRuntime } = require("./local-runtime.js");
const { shouldShowErrorPage, errorPageQuery } = require("./load-failure.js");
const { planRecovery } = require("./recovery.js");
const { planSettingsSave, writeSavePlan, isValidUrl, reachableSettings } = require("./settings-save.js");
const { shouldStopPodOnQuit } = require("./quit-policy.js");
const { clampSettingsHeight, isValidHeight } = require("./settings-window.js");
const { isFromAppPage } = require("./ipc-senders.js");
const { pathToFileURL } = require("node:url");
const { isNavigationAllowed, windowOpenAction, requestAllowed } = require("./view-rules.js");
const { requestDecision, checkDecision, allowedOriginsFrom } = require("./permissions.js");
const { contentBounds, tabBarBounds, planLayout, planTabSwitch } = require("./layout.js");
const { canRetryLocal } = require("./ipc-guards.js");
const { firstConfigError } = require("./runtime-config.js");
const { createRedirectRefusals } = require("./redirect-refusals.js");
const { installEventPlan, runInstallEvent } = require("./install-events.js");
const { spawn } = require("node:child_process");

// Set when Squirrel started this run for an install, update or uninstall, which whenReady answers instead of starting
// the app; see install-events.js.
const installEvent = installEventPlan(process.argv, process.execPath);

let settings = null;
// What the health poller and the notification poll may read: a refused address reads as absent.
const reachable = reachableSettings(() => settings);
// Redirects the request guard cancelled, so a failed load can say so. See redirect-refusals.js.
const redirectRefusals = createRedirectRefusals();
let mainWindow = null;
let shellView = null;
let serverView = null;
let consoleView = null;
let settingsWindow = null;
let activeTab = "server";
let healthPoller = null;
let tray = null;
const notificationLifecycle = createNotificationLifecycle(
  (s) => new NotificationManager(s, { onStatus: showNotificationStatus }),
);
let localRuntime = null;
let quitting = false;

// ─── Window Creation ─────────────────────────────────────────────────────

/**
 * Builds the window and the views for the current mode. A configured address the rule refuses
 * is shown as the refusal page, never loaded (see loadConfigured).
 */
function createMainWindow() {
  const bounds = settings.windowBounds;
  const isMac = process.platform === "darwin";
  const singleView = settings.isSingleView;

  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 820,
    ...(bounds.x !== undefined && { x: bounds.x }),
    ...(bounds.y !== undefined && { y: bounds.y }),
    minWidth: 800,
    minHeight: 600,
    title: "Turnstone",
    // macOS: native traffic lights, hidden title bar
    // Win/Linux: fully frameless — custom window controls in shell
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    backgroundColor: "#0b0f19",
    show: false,
  });

  // --- Shell view (title bar chrome) — always present ---
  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(shellView);
  shellView.webContents.loadFile(
    path.join(__dirname, "../renderer/shell.html"),
  );

  const contentViewPrefs = {
    preload: path.join(__dirname, "../preload/preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };

  // --- Server view (if mode includes server) ---
  if (settings.hasServer) {
    serverView = new WebContentsView({ webPreferences: contentViewPrefs });
    loadConfigured(serverView, settings.serverUrl);
    setupViewSecurity(serverView, "serverUrl");
    setupFailHandler(serverView, () => settings.serverUrl);
  }

  // --- Console view (if mode includes console) ---
  if (settings.hasConsole) {
    consoleView = new WebContentsView({ webPreferences: contentViewPrefs });
    // Local mode shows the loading page until the pod and its node are up
    // (startLocalRuntime), so the view is never blank while starting.
    if (settings.isLocal) showLocalLoading(consoleView);
    else loadConfigured(consoleView, settings.consoleUrl);
    setupViewSecurity(consoleView, "consoleUrl");
    setupFailHandler(consoleView, () => settings.consoleUrl);
  }

  // Add the correct initial content view
  if (singleView) {
    const view = settings.hasServer ? serverView : consoleView;
    mainWindow.contentView.addChildView(view);
  } else {
    if (activeTab === "console" && consoleView) {
      mainWindow.contentView.addChildView(consoleView);
    } else {
      mainWindow.contentView.addChildView(serverView);
      activeTab = "server";
    }
  }

  // Layout views on resize
  mainWindow.on("resize", layoutViews);
  layoutViews();

  // Show once the shell has painted. Not "ready-to-show": that fires only when
  // the window's own webContents renders, and this window never loads a page
  // of its own (all content lives in child WebContentsViews), so it never came.
  shellView.webContents.once("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // Save window bounds (debounced)
  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        settings.windowBounds = mainWindow.getBounds();
      }
    }, 500);
  };
  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  const thisWindow = mainWindow;
  mainWindow.on("closed", () => {
    // rebuildWindow closes the old window and builds the new one in the same
    // tick; a late "closed" must not null the new window's views.
    if (mainWindow !== thisWindow) return;
    mainWindow = null;
    shellView = null;
    serverView = null;
    consoleView = null;
  });
}

/**
 * A stored address the rule refuses is never loaded. The view shows the refusal page instead,
 * and Settings is the way to change the address. Every load of a configured address goes
 * through here, so the refusal cannot be skipped by a new call site.
 */
function loadConfigured(view, url) {
  if (isValidUrl(url)) {
    view.webContents.loadURL(url).catch(() => {});
    return;
  }
  view.webContents
    .loadFile(path.join(__dirname, "../renderer/error.html"), { query: errorPageQuery(url, "insecure") })
    .catch(() => {});
}

// Pages in the server and console views get only what permissions.js allows, and only
// for the origins the user configured. Electron approves every request when no handler is set.
// Each request is decided when it arrives, so a changed URL applies from then on. A changed URL
// also reloads its view, which ends any capture that page was running; a mode switch rebuilds
// the windows, which does the same.
function installPermissionPolicy() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const decision = requestDecision(
      {
        permission,
        requestingUrl: details.requestingUrl,
        topUrl: topUrlOf(webContents),
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaTypes,
      },
      configuredOrigins,
    );
    callback(decision);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return checkDecision(
      {
        permission,
        requestingOrigin,
        topUrl: topUrlOf(webContents),
        isMainFrame: details.isMainFrame,
        mediaType: details.mediaType,
      },
      configuredOrigins,
    );
  });
}

// The top-level page of a view. Electron can pass a null web contents to a check; for a frame
// inside another page, "" matches no configured origin, so the rules refuse it.
function topUrlOf(webContents) {
  return webContents ? webContents.getURL() : "";
}

// Read only once a request passes the permission name, and again on each request, so a
// changed URL or a mode switch applies without a restart.
function configuredOrigins() {
  try {
    return allowedOriginsFrom(settings);
  } catch {
    return [];
  }
}

function setupViewSecurity(view, settingKey) {
  view.webContents.on("will-navigate", (event, url) => {
    // An unreadable setting counts as no allowed URL, so the navigation is cancelled.
    let allowedUrl = null;
    try {
      allowedUrl = settings[settingKey];
    } catch {
      allowedUrl = null;
    }
    if (!isNavigationAllowed(allowedUrl, url)) {
      event.preventDefault();
    }
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (windowOpenAction(url).open) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

/**
 * Every request the session makes goes through requestAllowed, so a main-frame request from a
 * view to another site is cancelled before it loads, including each redirect hop. The cancelled
 * load is remembered, so the view shows the redirect refusal rather than a connection error.
 */
function installRequestGuard() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = requestAllowed(details, viewIds, () => settings);
    if (!allowed) redirectRefusals.refuse(details.webContentsId, details.url);
    callback({ cancel: !allowed });
  });
}

/**
 * The web contents ids of the two views, null for a view that does not exist. Read on each request,
 * so a rebuilt window is judged by its own views and not by the ones it replaced.
 */
function viewIds() {
  return {
    server: serverView ? serverView.webContents.id : null,
    console: consoleView ? consoleView.webContents.id : null,
  };
}

// getUrl is read at failure time so the error page and its Retry follow a
// serverUrl/consoleUrl change made in Settings after the window was built.
function setupFailHandler(view, getUrl) {
  // A new navigation supersedes a refusal left by an earlier one (see redirect-refusals.js).
  view.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) redirectRefusals.navigationStarted(view.webContents.id);
  });
  view.webContents.on(
    "did-fail-load",
    (_event, code, _desc, validatedURL, isMainFrame) => {
      // A redirect the request guard cancelled: say so, rather than report an unreachable server.
      if (isMainFrame && redirectRefusals.matches(view.webContents.id, validatedURL)) {
        view.webContents
          .loadFile(path.join(__dirname, "../renderer/error.html"), { query: errorPageQuery(getUrl(), "redirect") })
          .catch(() => {});
        return;
      }
      if (!shouldShowErrorPage(code, isMainFrame, validatedURL)) return;
      const errorPage = path.join(__dirname, "../renderer/error.html");
      view.webContents.loadFile(errorPage, {
        query: errorPageQuery(getUrl()),
      });
    },
  );
}

/**
 * Brings a view back after its backend returns. A reload repeats the current page, which after a
 * failure is our error page, so the decision comes from planRecovery and the address is loaded
 * through loadConfigured. A refused address is never reloaded.
 */
function recoverView(view, getUrl) {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  const localConsole = Boolean(settings.isLocal && view === consoleView);
  // Local mode: a reload of a console the health poller sees as down just
  // fails again (the pod is stopped), so go through the local start instead.
  const consoleDown = Boolean(
    localConsole && healthPoller && healthPoller.status.console !== "ok",
  );
  // A local start owns the console view while it runs (see planRecovery).
  const starting = Boolean(
    localConsole && localRuntime && localRuntime.starting,
  );
  const action = planRecovery({
    localConsole,
    starting,
    quitting,
    url: wc.getURL(),
    consoleDown,
  });
  if (action === "skip") return;
  if (action === "reload") {
    wc.reload();
  } else if (action === "restart-local") {
    // Idempotent, so it also waits for the node; loading the URL directly
    // would strand the local Retry.
    showLocalLoading(view);
    startLocalRuntime();
  } else {
    loadConfigured(view, getUrl());
  }
}

function urlGetterFor(view) {
  return view === serverView
    ? () => settings.serverUrl
    : () => settings.consoleUrl;
}

// ─── Local Runtime ───────────────────────────────────────────────────────

const LOCAL_LOADING_PAGE = path.join(__dirname, "../renderer/local-loading.html");

function showLocalLoading(view) {
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  // Stages sent before the page attached are lost; replay the current one
  // once this load finishes. A superseded load never fires it.
  // Stay registered across unrelated loads until the loading page itself
  // finishes (or the start is over), so a stray load cannot eat the replay.
  const replay = () => {
    if (wc.isDestroyed() || !localRuntime || !localRuntime.starting) {
      if (!wc.isDestroyed()) wc.removeListener("did-finish-load", replay);
      return;
    }
    if (!wc.getURL().endsWith("local-loading.html")) return;
    wc.removeListener("did-finish-load", replay);
    if (localRuntime.stage) wc.send("turnstone:local-progress", localRuntime.stage);
  };
  wc.on("did-finish-load", replay);
  // A navigation superseded by a newer one rejects; that is not an error.
  wc.loadFile(LOCAL_LOADING_PAGE).catch(() => {});
}

function showLocalError(view, code, message, detail) {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents
    .loadFile(path.join(__dirname, "../renderer/local-error.html"), {
      query: { code, message, detail: String(detail || "").slice(0, 500) },
    })
    .catch(() => {});
}

// Reads consoleView at call time, so a window rebuilt mid-start gets the stages.
function sendLocalProgress(stage) {
  if (consoleView && !consoleView.webContents.isDestroyed()) {
    consoleView.webContents.send("turnstone:local-progress", stage);
  }
}

/**
 * Loads the local console into a view that is still alive. The console URL comes from settings
 * and goes through loadConfigured like every other load, so a refused address is never loaded here.
 */
function loadLocalConsole(view) {
  if (view && !view.webContents.isDestroyed()) {
    loadConfigured(view, settings.consoleUrl);
  }
}

async function startLocalRuntime() {
  if (!settings.isLocal) return;
  // Quitting: the pod is being stopped; a fresh start would fight it.
  if (quitting) return;
  const view = consoleView;
  try {
    // Inside the try: a failure to build the runtime must reach the UNEXPECTED branch below, not escape unhandled.
    if (!localRuntime) localRuntime = new LocalRuntime({ onProgress: sendLocalProgress });
    await localRuntime.start();
    loadLocalConsole(view);
  } catch (err) {
    // Quit cancelled the start on purpose; there is nothing to show.
    if (err.code === "START_CANCELLED") return;
    // The console answered; only the node is late. Open the console anyway
    // rather than strand the user on an error page for a node that may
    // register moments later.
    if (err.code === "NODE_TIMEOUT") {
      console.warn(`${err.userMessage} (${err.detail})`);
      loadLocalConsole(view);
      return;
    }
    if (!err.userMessage) {
      // Not a runtime error: a bug. Show it instead of spinning forever.
      console.error("local start failed unexpectedly:", err);
      showLocalError(view, "UNEXPECTED", "Local startup failed unexpectedly.", err && err.message);
      return;
    }
    showLocalError(view, err.code, err.userMessage, err.detail);
  }
}

// ─── View Layout ─────────────────────────────────────────────────────────

const TAB_BAR_HEIGHT = 36;

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { width, height } = mainWindow.getContentBounds();
  // Shell (title bar) always present
  shellView.setBounds(tabBarBounds(width, TAB_BAR_HEIGHT));

  const bounds = contentBounds(width, height, TAB_BAR_HEIGHT);
  const target = planLayout({
    isSingleView: settings.isSingleView,
    hasServer: settings.hasServer,
    activeTab,
    hasServerView: Boolean(serverView),
    hasConsoleView: Boolean(consoleView),
  });
  if (target === "server") serverView.setBounds(bounds);
  else if (target === "console") consoleView.setBounds(bounds);
}

// ─── Tab Switching ───────────────────────────────────────────────────────

function switchTab(tab) {
  const plan = planTabSwitch({ isSingleView: settings.isSingleView, activeTab, tab });
  if (!plan.switch) return;

  if (plan.tab === "server") {
    mainWindow.contentView.removeChildView(consoleView);
    mainWindow.contentView.addChildView(serverView);
  } else {
    mainWindow.contentView.removeChildView(serverView);
    mainWindow.contentView.addChildView(consoleView);
  }

  activeTab = plan.tab;
  settings.activeTab = plan.tab;
  layoutViews();
}

// ─── Settings Dialog ─────────────────────────────────────────────────────

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 460,
    height: 480,
    resizable: false,
    useContentSize: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow,
    modal: true,
    show: false,
    title: "Settings",
    backgroundColor: "#0b0f19",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Learn more and other links leave the app in the user's browser, never
  // inside a window that carries this preload.
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (windowOpenAction(url).open) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, "../renderer/settings.html"));
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ─── Rebuild Window ──────────────────────────────────────────────────────

/**
 * Replaces the window when the mode changes. Notifications are applied before the old window
 * closes, so the old mode stops alerting even if the rebuild throws halfway.
 */
function rebuildWindow() {
  // Apply the new mode's notifications before the window is rebuilt. If the
  // rebuild throws, the new mode is already saved, so its notifications must
  // already match it.
  notificationLifecycle.apply(reachable);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }

  // Rebuild menu for new mode
  setupMenu({
    mode: settings.mode,
    openSettings,
    switchTab,
    reloadActiveView: () => {
      const view = getActiveView();
      if (view) recoverView(view, urlGetterFor(view));
    },
    toggleDevTools: () => {
      const view = getActiveView();
      if (view) view.webContents.toggleDevTools();
    },
  });

  // Reset active tab for new mode
  if (settings.mode === "server") activeTab = "server";
  else if (settings.mode === "console") activeTab = "console";

  createMainWindow();
  startLocalRuntime();

  // Restart health poller (mode may have changed which URLs to poll)
  if (healthPoller) healthPoller.stop();
  setupHealthPoller();
}

// ─── IPC Handlers ────────────────────────────────────────────────────────

// The app's own pages load from this folder. A file: page outside it is not an app page.
const APP_PAGE_ROOT = pathToFileURL(path.join(__dirname, "../renderer") + path.sep).href;

// A bridge request that does not come from an app page in the window allowed to make it is refused.
const REFUSED_REQUEST = "Refused: this request did not come from an app page.";

ipcMain.handle("turnstone:get-settings", (event) => {
  if (!isFromAppPage(event, [() => shellView && shellView.webContents, () => settingsWindow && settingsWindow.webContents], APP_PAGE_ROOT)) {
    throw new Error(REFUSED_REQUEST);
  }
  return settings.getAll();
});

ipcMain.handle("turnstone:save-settings", (event, newSettings) => {
  if (!isFromAppPage(event, [() => settingsWindow && settingsWindow.webContents], APP_PAGE_ROOT)) {
    throw new Error(REFUSED_REQUEST);
  }
  // quitBehavior is not passed in: reading it can throw on a corrupt store,
  // and this handler never read it.
  const plan = planSettingsSave(
    { mode: settings.mode, serverUrl: settings.serverUrl, consoleUrl: settings.consoleUrl },
    newSettings,
  );
  if (plan.error) return { error: plan.error };

  writeSavePlan(settings, plan.apply);

  if (plan.modeChanged) {
    // Mode change requires full window rebuild
    rebuildWindow();
  } else {
    // Just reload affected views
    if (plan.reloadServer && serverView) {
      serverView.webContents.loadURL(settings.serverUrl);
    }
    if (plan.reloadConsole && consoleView) {
      consoleView.webContents.loadURL(settings.consoleUrl);
    }
    if (healthPoller) healthPoller.poll();
    // apply rather than restart: a refused address that was just fixed has no manager to restart.
    if (plan.restartNotifications) notificationLifecycle.apply(reachable);
  }

  return { ok: true };
});

ipcMain.on("turnstone:switch-tab", (event, tab) => {
  if (!isFromAppPage(event, [() => shellView && shellView.webContents], APP_PAGE_ROOT)) return;
  switchTab(tab);
});

// The local-error page runs in the console view; nothing else may retry.
ipcMain.on("turnstone:retry-local", (event) => {
  const hasConsoleView = Boolean(consoleView);
  const consoleDestroyed = hasConsoleView && consoleView.webContents.isDestroyed();
  // A start already in flight owns the loading page; reloading it would
  // blank the stage list until the next stage. The rule lives in ipc-guards.js.
  const allowed = canRetryLocal({
    senderIsConsole: hasConsoleView && isFromAppPage(event, [() => consoleView.webContents], APP_PAGE_ROOT),
    hasConsoleView,
    consoleDestroyed,
    starting: Boolean(localRuntime && localRuntime.starting),
  });
  if (!allowed) return;
  showLocalLoading(consoleView);
  startLocalRuntime();
});

// The settings dialog sizes itself to its content; only that window may ask.
ipcMain.on("turnstone:settings-resize", (event, height) => {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (!isFromAppPage(event, [() => settingsWindow.webContents], APP_PAGE_ROOT)) return;
  // Reject a bad request before touching `screen`, as the handler always did.
  if (!isValidHeight(height)) {
    console.warn("settings-resize: ignoring non-numeric height");
    return;
  }
  const h = clampSettingsHeight(height, screen.getPrimaryDisplay().workAreaSize.height);
  settingsWindow.setContentSize(460, h);
});

ipcMain.on("turnstone:open-settings", (event) => {
  // The error pages in the server and console views ask for Settings.
  if (!isFromAppPage(event, [() => serverView && serverView.webContents, () => consoleView && consoleView.webContents], APP_PAGE_ROOT)) return;
  openSettings();
});

// Window controls (custom title bar on Win/Linux)
ipcMain.on("turnstone:window-minimize", (event) => {
  if (!isFromAppPage(event, [() => shellView && shellView.webContents], APP_PAGE_ROOT)) return;
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("turnstone:window-maximize", (event) => {
  if (!isFromAppPage(event, [() => shellView && shellView.webContents], APP_PAGE_ROOT)) return;
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.on("turnstone:window-close", (event) => {
  if (!isFromAppPage(event, [() => shellView && shellView.webContents], APP_PAGE_ROOT)) return;
  if (mainWindow) mainWindow.close();
});

// ─── Health Polling ──────────────────────────────────────────────────────

/**
 * Starts the health poller on the reachable settings, so a refused address is reported as
 * refused and never polled.
 */
function setupHealthPoller() {
  healthPoller = new HealthPoller(reachable, (status, prev) => {
    // Send to shell renderer
    if (shellView && !shellView.webContents.isDestroyed()) {
      shellView.webContents.send("turnstone:health-update", status);
    }

    // Update tray
    if (tray) {
      tray.updateStatus(status.server, status.console);
    }

    // Auto-reload views on recovery
    if (prev.server !== "ok" && status.server === "ok" && serverView) {
      recoverView(serverView, () => settings.serverUrl);
    }
    if (prev.console !== "ok" && status.console === "ok" && consoleView) {
      // A local start owns the console view while it runs: reloading now
      // would replace the loading page with a console whose node is not up.
      const localStarting =
        settings.isLocal && localRuntime && localRuntime.starting;
      if (!localStarting) recoverView(consoleView, () => settings.consoleUrl);
    }
  });

  healthPoller.start();
}

// ─── Notification Status ─────────────────────────────────────────────────

/**
 * Shows in the tray whether notifications work, and logs each change, so a server that refuses them is not
 * silent. A stopped manager reports null, which removes the tray line.
 */
function showNotificationStatus(status) {
  if (tray) tray.updateNotifications(status);
  const label = notificationLabel(status);
  if (label) console.log(label);
}

// ─── Menu Actions ────────────────────────────────────────────────────────

function getActiveView() {
  if (settings.isSingleView) {
    return settings.hasServer ? serverView : consoleView;
  }
  return activeTab === "server" ? serverView : consoleView;
}

// ─── App Lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // A Squirrel event: make its shortcut call and exit, with no window, settings read or Local mode start.
  if (installEvent) {
    runInstallEvent(installEvent, { spawn, exit: (code) => app.exit(code) });
    return;
  }
  // Checked in every mode, before anything reads the overrides: a bad value stops the app here
  // with a message, instead of failing later inside Local mode.
  const configError = firstConfigError();
  if (configError) {
    console.error(configError);
    dialog.showErrorBox("Turnstone cannot start", configError);
    app.exit(1);
    return;
  }
  installPermissionPolicy();
  installRequestGuard();
  settings = await SettingsStore.create();
  activeTab = settings.activeTab || "server";

  // Ensure activeTab aligns with mode
  if (settings.mode === "server") activeTab = "server";
  else if (settings.mode === "console") activeTab = "console";

  const isFirstLaunch = !settings.hasLaunched;

  setupMenu({
    mode: settings.mode,
    openSettings,
    switchTab,
    reloadActiveView: () => {
      const view = getActiveView();
      if (view) recoverView(view, urlGetterFor(view));
    },
    toggleDevTools: () => {
      const view = getActiveView();
      if (view) view.webContents.toggleDevTools();
    },
  });

  createMainWindow();
  startLocalRuntime();
  setupHealthPoller();
  settings.hasLaunched = true;

  // Tray
  tray = new TurnStoneTray({
    showWindow: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    openSettings,
    quit: () => app.quit(),
  });
  tray.create();

  // Notifications run only while the mode has a server
  notificationLifecycle.apply(reachable);

  if (isFirstLaunch) {
    openSettings();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (!mainWindow) {
    if (!settings) {
      settings = await SettingsStore.create();
    }
    createMainWindow();
    startLocalRuntime();
  }
});

app.on("before-quit", (event) => {
  // Stop the pod before exiting unless the user chose to keep it. Keyed on
  // whether this session managed the pod (it inspected it, whether or not it
  // had to start it), so a mode switch away from local still stops it.
  const decision = shouldStopPodOnQuit({
    getQuitBehavior: () => (settings ? settings.quitBehavior : undefined),
    runtime: localRuntime,
    quitting,
  });
  // A corrupt setting must not trap the user in the app: the quit goes on.
  if ("error" in decision) {
    console.error("quitBehavior unreadable, not stopping pod:", decision.error.message);
  }
  if (decision.stop) {
    event.preventDefault();
    quitting = true;
    localRuntime
      .stop()
      .catch((err) => console.error("pod stop failed:", err.message))
      .finally(() => app.quit());
    return;
  }
  if (healthPoller) healthPoller.stop();
  notificationLifecycle.stop();
  if (tray) tray.destroy();
});
