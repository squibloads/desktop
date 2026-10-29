const LOCAL_CONSOLE_URL = "http://127.0.0.1:8090";

const schema = {
  mode: { type: "string", default: "both" }, // 'server', 'console', 'both', 'local'
  quitBehavior: { type: "string", enum: ["stop", "keep"], default: "stop" }, // local mode: 'stop' | 'keep'
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

  // Local mode always talks to the pod's published port, whatever was saved.
  get consoleUrl() {
    return this.isLocal ? LOCAL_CONSOLE_URL : this.store.get("consoleUrl");
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

  // conf fills schema defaults on read, so an absent key reads as "stop".
  // Anything else that is not stop/keep is a failed read and throws.
  get quitBehavior() {
    const raw = this.store.get("quitBehavior");
    if (raw !== "stop" && raw !== "keep") {
      throw new Error(`invalid quitBehavior in settings store: ${raw}`);
    }
    return raw;
  }
  set quitBehavior(v) {
    if (v !== "stop" && v !== "keep") {
      throw new Error(`invalid quitBehavior: ${v}`);
    }
    this.store.set("quitBehavior", v);
  }

  get isLocal() {
    return this.mode === "local";
  }
  get hasServer() {
    return this.mode === "server" || this.mode === "both";
  }
  get hasConsole() {
    return (
      this.mode === "console" || this.mode === "both" || this.mode === "local"
    );
  }
  get isSingleView() {
    return this.mode !== "both";
  }

  getAll() {
    return {
      mode: this.mode,
      serverUrl: this.serverUrl,
      // Raw saved value: the getter returns the local pod URL in local mode,
      // and saving that back would overwrite the user's remote Console URL.
      consoleUrl: this.store.get("consoleUrl"),
      activeTab: this.activeTab,
      quitBehavior: this.quitBehavior,
    };
  }
}

module.exports = { SettingsStore };
