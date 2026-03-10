const schema = {
  mode: { type: "string", default: "both" }, // 'server', 'console', 'both'
  serverUrl: { type: "string", default: "http://localhost:8080" },
  consoleUrl: { type: "string", default: "http://localhost:8090" },
  windowBounds: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number", default: 1280 },
      height: { type: "number", default: 820 },
    },
    default: { width: 1280, height: 820 },
  },
  activeTab: { type: "string", default: "server" },
  hasLaunched: { type: "boolean", default: false },
};

class SettingsStore {
  constructor(store) {
    this.store = store;
  }

  static async create() {
    const { default: Store } = await import("electron-store");
    const store = new Store({ schema, name: "turnstone-desktop" });
    return new SettingsStore(store);
  }

  get mode() {
    return this.store.get("mode");
  }
  set mode(v) {
    this.store.set("mode", v);
  }

  get serverUrl() {
    return this.store.get("serverUrl");
  }
  set serverUrl(v) {
    this.store.set("serverUrl", v);
  }

  get consoleUrl() {
    return this.store.get("consoleUrl");
  }
  set consoleUrl(v) {
    this.store.set("consoleUrl", v);
  }

  get windowBounds() {
    return this.store.get("windowBounds");
  }
  set windowBounds(v) {
    this.store.set("windowBounds", v);
  }

  get activeTab() {
    return this.store.get("activeTab");
  }
  set activeTab(v) {
    this.store.set("activeTab", v);
  }

  get hasLaunched() {
    return this.store.get("hasLaunched");
  }
  set hasLaunched(v) {
    this.store.set("hasLaunched", v);
  }

  get hasServer() {
    return this.mode === "server" || this.mode === "both";
  }
  get hasConsole() {
    return this.mode === "console" || this.mode === "both";
  }
  get isSingleView() {
    return this.mode !== "both";
  }

  getAll() {
    return {
      mode: this.mode,
      serverUrl: this.serverUrl,
      consoleUrl: this.consoleUrl,
      activeTab: this.activeTab,
    };
  }
}

module.exports = { SettingsStore };
