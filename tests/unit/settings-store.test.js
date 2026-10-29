import { describe, it, expect } from "vitest";

const { SettingsStore } = require("../../src/main/settings-store.js");

// Create a mock store object that mimics electron-store's get/set API
function mockStore() {
  const data = {};
  return {
    get(key) {
      return data[key];
    },
    set(key, val) {
      data[key] = val;
    },
  };
}

describe("SettingsStore", () => {
  function create(initial = {}) {
    const store = mockStore();
    // Set defaults
    const defaults = {
      mode: "both",
      serverUrl: "http://localhost:8080",
      consoleUrl: "http://localhost:8090",
      activeTab: "server",
      hasLaunched: false,
      quitBehavior: "stop",
      ...initial,
    };
    for (const [k, v] of Object.entries(defaults)) {
      store.set(k, v);
    }
    return new SettingsStore(store);
  }

  it("has correct defaults", () => {
    const s = create();
    expect(s.mode).toBe("both");
    expect(s.serverUrl).toBe("http://localhost:8080");
    expect(s.consoleUrl).toBe("http://localhost:8090");
    expect(s.activeTab).toBe("server");
    expect(s.hasLaunched).toBe(false);
  });

  it("persists values via set/get", () => {
    const s = create();
    s.serverUrl = "http://example.com:9000";
    expect(s.serverUrl).toBe("http://example.com:9000");

    s.mode = "console";
    expect(s.mode).toBe("console");
  });

  describe("derived getters", () => {
    it("hasServer is true for server and both modes", () => {
      const s = create();
      s.mode = "server";
      expect(s.hasServer).toBe(true);
      expect(s.hasConsole).toBe(false);

      s.mode = "both";
      expect(s.hasServer).toBe(true);
      expect(s.hasConsole).toBe(true);
    });

    it("hasConsole is true for console and both modes", () => {
      const s = create();
      s.mode = "console";
      expect(s.hasConsole).toBe(true);
      expect(s.hasServer).toBe(false);
    });

    it("isSingleView is true for server and console, false for both", () => {
      const s = create();
      s.mode = "server";
      expect(s.isSingleView).toBe(true);

      s.mode = "console";
      expect(s.isSingleView).toBe(true);

      s.mode = "both";
      expect(s.isSingleView).toBe(false);
    });
  });

  describe("getAll", () => {
    it("returns current settings", () => {
      const s = create();
      s.mode = "server";
      s.serverUrl = "http://test:1234";
      s.consoleUrl = "http://test:5678";
      s.activeTab = "console";

      expect(s.getAll()).toEqual({
        mode: "server",
        serverUrl: "http://test:1234",
        consoleUrl: "http://test:5678",
        activeTab: "console",
        quitBehavior: "stop",
      });
    });
  });
});

describe("SettingsStore local mode", () => {
  function createLocal(initial = {}) {
    const data = { mode: "local", quitBehavior: "stop", serverUrl: "http://x:1", consoleUrl: "http://y:2", ...initial };
    return new SettingsStore({
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = v;
      },
    });
  }

  it("is console-only against the local pod, ignoring saved URLs", () => {
    const s = createLocal();
    expect(s.hasConsole).toBe(true);
    expect(s.hasServer).toBe(false);
    expect(s.isSingleView).toBe(true);
    expect(s.isLocal).toBe(true);
    expect(s.consoleUrl).toBe("http://127.0.0.1:8090");
  });

  it("keeps the saved consoleUrl for other modes", () => {
    const s = createLocal({ mode: "both" });
    expect(s.isLocal).toBe(false);
    expect(s.consoleUrl).toBe("http://y:2");
  });

  it("defaults quitBehavior to stop and rejects unknown values", () => {
    const s = createLocal();
    expect(s.quitBehavior).toBe("stop");
    s.quitBehavior = "keep";
    expect(s.quitBehavior).toBe("keep");
    expect(() => {
      s.quitBehavior = "bogus";
    }).toThrow();
  });

  it("getAll exposes quitBehavior", () => {
    expect(createLocal().getAll().quitBehavior).toBe("stop");
  });

  it("getAll returns the saved remote consoleUrl, not the local override", () => {
    const s = createLocal({ consoleUrl: "http://console.example.com:8090" });
    expect(s.getAll().consoleUrl).toBe("http://console.example.com:8090");
    expect(s.consoleUrl).toBe("http://127.0.0.1:8090");
  });
});

describe("SettingsStore quitBehavior validation", () => {
  const make = (v) =>
    new SettingsStore({ get: () => v, set: () => {} });

  it("returns stored stop and keep", () => {
    expect(make("stop").quitBehavior).toBe("stop");
    expect(make("keep").quitBehavior).toBe("keep");
  });

  it("throws on an unreadable value instead of inventing one", () => {
    expect(() => make("bogus").quitBehavior).toThrow(/invalid quitBehavior/);
    expect(() => make(undefined).quitBehavior).toThrow(/invalid quitBehavior/);
  });
});
