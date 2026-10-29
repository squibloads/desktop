const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  screen,
} = require("electron");
const path = require("path");
const { SettingsStore } = require("./settings-store.js");
const { HealthPoller } = require("./health.js");
const { setupMenu } = require("./menu.js");
const { TurnStoneTray } = require("./tray.js");
const { NotificationManager } = require("./notifications.js");
const { LocalRuntime } = require("./local-runtime.js");
const { shouldShowErrorPage, errorPageQuery, recoveryAction } = require("./load-failure.js");

let settings = null;
let mainWindow = null;
let shellView = null;
let serverView = null;
let consoleView = null;
let settingsWindow = null;
let activeTab = "server";
let healthPoller = null;
let tray = null;
let notifications = null;
let localRuntime = null;
let quitting = false;

// ─── Window Creation ─────────────────────────────────────────────────────

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
  };

  // --- Server view (if mode includes server) ---
  if (settings.hasServer) {
    serverView = new WebContentsView({ webPreferences: contentViewPrefs });
    serverView.webContents.loadURL(settings.serverUrl);
    setupViewSecurity(serverView, "serverUrl");
    setupFailHandler(serverView, () => settings.serverUrl);
  }

  // --- Console view (if mode includes console) ---
  if (settings.hasConsole) {
    consoleView = new WebContentsView({ webPreferences: contentViewPrefs });
    // Local mode shows the loading page until the pod and its node are up
    // (startLocalRuntime), so the view is never blank while starting.
    if (settings.isLocal) showLocalLoading(consoleView);
    else consoleView.webContents.loadURL(settings.consoleUrl);
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

function setupViewSecurity(view, settingKey) {
  view.webContents.on("will-navigate", (event, url) => {
    try {
      const allowed = new URL(settings[settingKey]);
      const target = new URL(url);
      if (target.origin !== allowed.origin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

// getUrl is read at failure time so the error page and its Retry follow a
// serverUrl/consoleUrl change made in Settings after the window was built.
function setupFailHandler(view, getUrl) {
  view.webContents.on(
    "did-fail-load",
    (_event, code, _desc, validatedURL, isMainFrame) => {
      if (!shouldShowErrorPage(code, isMainFrame, validatedURL)) return;
      const errorPage = path.join(__dirname, "../renderer/error.html");
      view.webContents.loadFile(errorPage, {
        query: errorPageQuery(getUrl()),
      });
    },
  );
}

// A reload repeats the current page, which after a failure is our error page;
// recoveryAction decides when the original URL has to be loaded instead.
function recoverView(view, getUrl) {
  const wc = view.webContents;
  if (wc.isDestroyed()) return;
  // The health poller keeps running while the quit-time pod stop finishes;
  // a recovery then must not re-run a start that cancels or races the stop.
  if (quitting) return;
  const localConsole = settings.isLocal && view === consoleView;
  // A local start owns the console view while it runs: loading the console
  // now would replace the loading page with one whose node is not up.
  if (localConsole && localRuntime && localRuntime.starting) return;
  if (recoveryAction(wc.getURL()) === "reload") {
    wc.reload();
  } else if (localConsole) {
    // Our own local error/loading page is showing: re-run the local start
    // (idempotent, so it also waits for the node) rather than load the URL
    // directly and strand the local Retry.
    showLocalLoading(view);
    startLocalRuntime();
  } else {
    wc.loadURL(getUrl()).catch(() => {});
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

function loadLocalConsole(view) {
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.loadURL(settings.consoleUrl).catch(() => {});
  }
}

async function startLocalRuntime() {
  if (!settings.isLocal) return;
  // Quitting: the pod is being stopped; a fresh start would fight it.
  if (quitting) return;
  if (!localRuntime) localRuntime = new LocalRuntime({ onProgress: sendLocalProgress });
  const view = consoleView;
  try {
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
  shellView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });

  const contentBounds = {
    x: 0,
    y: TAB_BAR_HEIGHT,
    width,
    height: height - TAB_BAR_HEIGHT,
  };

  if (settings.isSingleView) {
    const view = settings.hasServer ? serverView : consoleView;
    if (view) view.setBounds(contentBounds);
  } else {
    if (activeTab === "server" && serverView) {
      serverView.setBounds(contentBounds);
    } else if (consoleView) {
      consoleView.setBounds(contentBounds);
    }
  }
}

// ─── Tab Switching ───────────────────────────────────────────────────────

function switchTab(tab) {
  if (settings.isSingleView) return;
  if (tab === activeTab) return;
  if (tab !== "server" && tab !== "console") return;

  if (tab === "server") {
    mainWindow.contentView.removeChildView(consoleView);
    mainWindow.contentView.addChildView(serverView);
  } else {
    mainWindow.contentView.removeChildView(serverView);
    mainWindow.contentView.addChildView(consoleView);
  }

  activeTab = tab;
  settings.activeTab = tab;
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
    },
  });

  // Learn more and other links leave the app in the user's browser, never
  // inside a window that carries this preload.
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
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

// ─── URL Validation ──────────────────────────────────────────────────────

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Rebuild Window ──────────────────────────────────────────────────────

function rebuildWindow() {
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

  // Restart notifications
  if (notifications) notifications.stop();
  if (settings.hasServer) {
    notifications = new NotificationManager(settings);
    notifications.start();
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────────────

ipcMain.handle("turnstone:get-settings", () => {
  return settings.getAll();
});

ipcMain.handle("turnstone:save-settings", (_event, newSettings) => {
  const mode = newSettings.mode || "both";
  const needsServer = mode === "server" || mode === "both";
  const needsConsole = mode === "console" || mode === "both";
  if (!["server", "console", "both", "local"].includes(mode)) {
    return { error: "Invalid mode" };
  }

  // Validate only the URLs needed for this mode
  if (needsServer && !isValidUrl(newSettings.serverUrl)) {
    return { error: "Invalid Server URL — must be http:// or https://" };
  }
  if (needsConsole && !isValidUrl(newSettings.consoleUrl)) {
    return { error: "Invalid Console URL — must be http:// or https://" };
  }

  if (newSettings.quitBehavior !== undefined) {
    if (newSettings.quitBehavior !== "stop" && newSettings.quitBehavior !== "keep") {
      return { error: "Invalid quit behaviour" };
    }
    settings.quitBehavior = newSettings.quitBehavior;
  }

  const modeChanged = mode !== settings.mode;
  const serverChanged = newSettings.serverUrl !== settings.serverUrl;
  const consoleChanged = newSettings.consoleUrl !== settings.consoleUrl;

  settings.mode = mode;
  // Local mode hides both URL fields; never overwrite the saved remote URLs.
  if (needsServer) settings.serverUrl = newSettings.serverUrl;
  if (needsConsole) settings.consoleUrl = newSettings.consoleUrl;

  if (modeChanged) {
    // Mode change requires full window rebuild
    rebuildWindow();
  } else {
    // Just reload affected views
    if (serverChanged && serverView) {
      serverView.webContents.loadURL(settings.serverUrl);
    }
    if (consoleChanged && consoleView && !settings.isLocal) {
      consoleView.webContents.loadURL(settings.consoleUrl);
    }
    if (healthPoller) healthPoller.poll();
    if (serverChanged && notifications) {
      notifications.stop();
      notifications.start();
    }
  }

  return { ok: true };
});

ipcMain.on("turnstone:switch-tab", (_event, tab) => {
  switchTab(tab);
});

// The local-error page runs in the console view; nothing else may retry.
ipcMain.on("turnstone:retry-local", (event) => {
  if (!consoleView || consoleView.webContents.isDestroyed()) return;
  if (event.sender !== consoleView.webContents) return;
  // A start already in flight owns the loading page; reloading it would
  // blank the stage list until the next stage.
  if (localRuntime && localRuntime.starting) return;
  showLocalLoading(consoleView);
  startLocalRuntime();
});

// The settings dialog sizes itself to its content; only that window may ask.
ipcMain.on("turnstone:settings-resize", (event, height) => {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (event.sender !== settingsWindow.webContents) return;
  if (typeof height !== "number" || !Number.isFinite(height)) {
    console.warn("settings-resize: ignoring non-numeric height");
    return;
  }
  const maxH = screen.getPrimaryDisplay().workAreaSize.height - 120;
  const h = Math.min(Math.max(Math.round(height), 300), Math.max(300, maxH));
  settingsWindow.setContentSize(460, h);
});

ipcMain.on("turnstone:open-settings", () => {
  openSettings();
});

// Window controls (custom title bar on Win/Linux)
ipcMain.on("turnstone:window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("turnstone:window-maximize", () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.on("turnstone:window-close", () => {
  if (mainWindow) mainWindow.close();
});

// ─── Health Polling ──────────────────────────────────────────────────────

function setupHealthPoller() {
  healthPoller = new HealthPoller(settings, (status, prev) => {
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

// ─── Menu Actions ────────────────────────────────────────────────────────

function getActiveView() {
  if (settings.isSingleView) {
    return settings.hasServer ? serverView : consoleView;
  }
  return activeTab === "server" ? serverView : consoleView;
}

// ─── App Lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
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

  // Notifications (only if server mode is active)
  if (settings.hasServer) {
    notifications = new NotificationManager(settings);
    notifications.start();
  }

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
  let stopPod = false;
  try {
    stopPod = Boolean(
      settings &&
        settings.quitBehavior === "stop" &&
        localRuntime &&
        localRuntime.active,
    );
  } catch (err) {
    // A corrupt setting must not trap the user in the app.
    console.error("quitBehavior unreadable, not stopping pod:", err.message);
  }
  if (stopPod && !quitting) {
    event.preventDefault();
    quitting = true;
    localRuntime
      .stop()
      .catch((err) => console.error("pod stop failed:", err.message))
      .finally(() => app.quit());
    return;
  }
  if (healthPoller) healthPoller.stop();
  if (notifications) notifications.stop();
  if (tray) tray.destroy();
});
