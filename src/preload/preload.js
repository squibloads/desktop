const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Platform info
  platform: process.platform,

  // Settings
  getSettings: () => ipcRenderer.invoke("turnstone:get-settings"),
  saveSettings: (settings) =>
    ipcRenderer.invoke("turnstone:save-settings", settings),

  // Tab switching
  switchTab: (tab) => ipcRenderer.send("turnstone:switch-tab", tab),

  // Health updates (main -> renderer)
  onHealthUpdate: (callback) => {
    ipcRenderer.on("turnstone:health-update", (_event, status) =>
      callback(status),
    );
  },

  // Open settings dialog
  openSettings: () => ipcRenderer.send("turnstone:open-settings"),

  // Window controls (for custom title bar on Win/Linux)
  windowMinimize: () => ipcRenderer.send("turnstone:window-minimize"),
  windowMaximize: () => ipcRenderer.send("turnstone:window-maximize"),
  windowClose: () => ipcRenderer.send("turnstone:window-close"),
});
