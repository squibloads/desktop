const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
} = require("electron");
const path = require("path");
const { SettingsStore } = require("./settings-store.js");
const { HealthPoller } = require("./health.js");
const { setupMenu } = require("./menu.js");
const { TurnStoneTray } = require("./tray.js");
const { NotificationManager } = require("./notifications.js");

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
    setupFailHandler(serverView, settings.serverUrl);
  }

  // --- Console view (if mode includes console) ---
  if (settings.hasConsole) {
    consoleView = new WebContentsView({ webPreferences: contentViewPrefs });
    consoleView.webContents.loadURL(settings.consoleUrl);
    setupViewSecurity(consoleView, "consoleUrl");
    setupFailHandler(consoleView, settings.consoleUrl);
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

  // Show when ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
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

  mainWindow.on("closed", () => {
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

function setupFailHandler(view, originalUrl) {
  view.webContents.on("did-fail-load", (_event, _code, _desc, validatedURL) => {
    // Don't intercept error page loads
    if (validatedURL.startsWith("file://")) return;
    const errorPage = path.join(__dirname, "../renderer/error.html");
    const url = encodeURIComponent(originalUrl);
    view.webContents.loadFile(errorPage, { query: `url=${url}` });
  });
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
      if (view) view.webContents.reload();
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

  // Validate only the URLs needed for this mode
  if (needsServer && !isValidUrl(newSettings.serverUrl)) {
    return { error: "Invalid Server URL — must be http:// or https://" };
  }
  if (needsConsole && !isValidUrl(newSettings.consoleUrl)) {
    return { error: "Invalid Console URL — must be http:// or https://" };
  }

  const modeChanged = mode !== settings.mode;
  const serverChanged = newSettings.serverUrl !== settings.serverUrl;
  const consoleChanged = newSettings.consoleUrl !== settings.consoleUrl;

  settings.mode = mode;
  settings.serverUrl = newSettings.serverUrl;
  settings.consoleUrl = newSettings.consoleUrl;

  if (modeChanged) {
    // Mode change requires full window rebuild
    rebuildWindow();
  } else {
    // Just reload affected views
    if (serverChanged && serverView) {
      serverView.webContents.loadURL(settings.serverUrl);
    }
    if (consoleChanged && consoleView) {
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
      serverView.webContents.reload();
    }
    if (prev.console !== "ok" && status.console === "ok" && consoleView) {
      consoleView.webContents.reload();
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
      if (view) view.webContents.reload();
    },
    toggleDevTools: () => {
      const view = getActiveView();
      if (view) view.webContents.toggleDevTools();
    },
  });

  createMainWindow();
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
  }
});

app.on("before-quit", () => {
  if (healthPoller) healthPoller.stop();
  if (notifications) notifications.stop();
  if (tray) tray.destroy();
});
