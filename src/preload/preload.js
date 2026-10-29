const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Platform info
  platform: process.platform,

  // Settings
  getSettings: () => ipcRenderer.invoke("turnstone:get-settings"),
  saveSettings: (settings) =>
    ipcRenderer.invoke("turnstone:save-settings", settings),
  // Content height in CSS px; main clamps it and sizes the settings window.
  resizeSettings: (height) =>
    ipcRenderer.send("turnstone:settings-resize", height),

  // Tab switching
  switchTab: (tab) => ipcRenderer.send("turnstone:switch-tab", tab),

  // Health updates (main -> renderer) — returns cleanup function
  onHealthUpdate: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("turnstone:health-update", handler);
    return () => ipcRenderer.removeListener("turnstone:health-update", handler);
  },

  // Local mode: re-run the start sequence after a failure
  retryLocal: () => ipcRenderer.send("turnstone:retry-local"),

  // Open settings dialog
  openSettings: () => ipcRenderer.send("turnstone:open-settings"),

  // Window controls (for custom title bar on Win/Linux)
  windowMinimize: () => ipcRenderer.send("turnstone:window-minimize"),
  windowMaximize: () => ipcRenderer.send("turnstone:window-maximize"),
  windowClose: () => ipcRenderer.send("turnstone:window-close"),
});
