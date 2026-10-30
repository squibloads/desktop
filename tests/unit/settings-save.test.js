import { describe, it, expect } from "vitest";

const { planSettingsSave, isValidUrl, writeSavePlan } = require("../../src/main/settings-save.js");

const SERVER_URL = "http://127.0.0.1:8080";
const CONSOLE_URL = "http://127.0.0.1:8090";
const NEW_SERVER_URL = "https://server.example.com:8443";
const NEW_CONSOLE_URL = "https://console.example.com:8443";

// What the store holds before a save. quitBehavior is part of the shape but
// the planner never reads it, so a corrupt stored value cannot block a save.
function savedBoth() {
  return { mode: "both", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" };
}

describe("planSettingsSave valid saves", () => {
  // Failure: a server address edit is saved but the server view keeps showing the old page.
  it("writes the new server URL and reloads only the server view", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: NEW_SERVER_URL,
      consoleUrl: CONSOLE_URL,
    });
    expect(result).toEqual({
      apply: { mode: "both", serverUrl: NEW_SERVER_URL, consoleUrl: CONSOLE_URL },
      modeChanged: false,
      reloadServer: true,
      reloadConsole: false,
      restartNotifications: true,
    });
  });

  // Failure: a console address edit is saved but the console view keeps the old page.
  it("writes the new console URL and reloads only the console view", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: NEW_CONSOLE_URL,
    });
    expect(result).toEqual({
      apply: { mode: "both", serverUrl: SERVER_URL, consoleUrl: NEW_CONSOLE_URL },
      modeChanged: false,
      reloadServer: false,
      reloadConsole: true,
      restartNotifications: false,
    });
  });

  // Failure: saving Local mode overwrites the remote URLs the user saved for the other modes.
  it("writes no URLs in local mode, so the saved remote addresses survive", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "local",
      serverUrl: "http://127.0.0.1:9999",
      consoleUrl: "http://127.0.0.1:9998",
    });
    expect(result.apply).toEqual({ mode: "local" });
    expect(result.error).toBeUndefined();
  });

  // Failure: a console-only save is refused because of a server address field the user cannot see.
  it("does not validate or write the server URL in console mode", () => {
    const result = planSettingsSave(
      { mode: "console", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" },
      { mode: "console", serverUrl: "not a url", consoleUrl: NEW_CONSOLE_URL },
    );
    expect(result.apply).toEqual({ mode: "console", consoleUrl: NEW_CONSOLE_URL });
    expect(result.error).toBeUndefined();
  });

  // Failure: changing the mode patches views in place and leaves the menu and window layout of the old mode.
  it("asks for a window rebuild instead of per-view reloads on a mode change", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "server",
      serverUrl: NEW_SERVER_URL,
      consoleUrl: CONSOLE_URL,
    });
    expect(result.modeChanged).toBe(true);
    expect(result.reloadServer).toBe(false);
    expect(result.reloadConsole).toBe(false);
    expect(result.restartNotifications).toBe(false);
  });

  // Failure: in local mode the console view is reloaded to a saved remote address the pod does not serve.
  it("does not reload the console view in local mode when the console URL field changes", () => {
    const result = planSettingsSave(
      { mode: "local", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" },
      { mode: "local", serverUrl: SERVER_URL, consoleUrl: NEW_CONSOLE_URL },
    );
    expect(result.reloadConsole).toBe(false);
  });

  // Failure: a quit-behaviour choice made in settings is silently dropped on save.
  it("saves a keep quit behaviour when one is sent", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
      quitBehavior: "keep",
    });
    expect(result.apply).toEqual({
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
      quitBehavior: "keep",
    });
  });

  // Failure: a save that omits the quit behaviour resets the user's stored choice.
  it("leaves the stored quit behaviour alone when the save does not send one", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
    });
    expect("quitBehavior" in result.apply).toBe(false);
  });

  // Failure: a save with no mode field switches the user out of their current mode.
  it("saves a payload with no mode as both", () => {
    const result = planSettingsSave(savedBoth(), {
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
    });
    expect(result.apply.mode).toBe("both");
    // An empty mode is the same as Both, so on a Both setup it must not rebuild the window.
    expect(result.modeChanged).toBe(false);
  });

  // Failure: saving unchanged settings restarts notifications and reloads pages the user was reading.
  it("reloads and restarts nothing when the save changes nothing", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
    });
    expect(result.modeChanged).toBe(false);
    expect(result.reloadServer).toBe(false);
    expect(result.reloadConsole).toBe(false);
    expect(result.restartNotifications).toBe(false);
  });

  // Failure: the planner edits the caller's saved-settings object, so a refused save leaves a half-changed record.
  it("does not modify the current or incoming objects", () => {
    const current = savedBoth();
    const incoming = { mode: "server", serverUrl: NEW_SERVER_URL };
    planSettingsSave(current, incoming);
    expect(current).toEqual({ mode: "both", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" });
    expect(incoming).toEqual({ mode: "server", serverUrl: NEW_SERVER_URL });
  });
});

// A URL the mode does not use is neither written nor a change. Comparing it anyway restarted
// notifications and reloaded views on a save that only edited a hidden field.
describe("planSettingsSave URLs the mode does not use", () => {
  // Failure: an edited server field saved in console mode reconnects notifications to a server the mode does not show.
  it("does not restart notifications or reload the server view in console mode when only the server field changed", () => {
    const result = planSettingsSave(
      { mode: "console", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" },
      { mode: "console", serverUrl: NEW_SERVER_URL, consoleUrl: CONSOLE_URL },
    );
    expect(result.reloadServer).toBe(false);
    expect(result.restartNotifications).toBe(false);
  });

  // Failure: an edited server field saved in local mode reconnects notifications to the remote server saved earlier.
  it("does not restart notifications or reload the server view in local mode when only the server field changed", () => {
    const result = planSettingsSave(
      { mode: "local", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" },
      { mode: "local", serverUrl: NEW_SERVER_URL },
    );
    expect(result.reloadServer).toBe(false);
    expect(result.restartNotifications).toBe(false);
  });

  // Failure: an edited console field saved in server mode reloads the console view to an address the mode does not show.
  it("does not reload the console view in server mode when only the console field changed", () => {
    const result = planSettingsSave(
      { mode: "server", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" },
      { mode: "server", serverUrl: SERVER_URL, consoleUrl: NEW_CONSOLE_URL },
    );
    expect(result.reloadConsole).toBe(false);
  });

  // Failure: gating on the mode also drops the restart for a real server change, so alerts keep coming from the old server.
  it("still restarts notifications in server mode when the server URL changes", () => {
    const result = planSettingsSave(
      { mode: "server", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" },
      { mode: "server", serverUrl: NEW_SERVER_URL },
    );
    expect(result.restartNotifications).toBe(true);
  });
});

describe("planSettingsSave refused saves", () => {
  // Failure: a server address sent as an array passes validation, the store rejects it, and the mode has already changed.
  it("refuses a server URL that is not a string", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "server",
      serverUrl: ["http://127.0.0.1:8080"],
      consoleUrl: CONSOLE_URL,
    });
    expect(result).toEqual({ error: "Invalid Server URL — must be https:// (http:// only on this computer)" });
  });

  // Failure: an unknown mode string is written to the store and the next launch shows a blank window.
  it("refuses an unknown mode before checking any URL", () => {
    const result = planSettingsSave(savedBoth(), { mode: "kiosk", serverUrl: "bad" });
    expect(result).toEqual({ error: "Invalid mode" });
  });

  // Failure: a server address that is not http or https is saved and the view tries to load it.
  it("refuses a server URL that is not http or https", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "server",
      serverUrl: "ftp://files.example.com/",
      consoleUrl: CONSOLE_URL,
    });
    expect(result).toEqual({ error: "Invalid Server URL — must be https:// (http:// only on this computer)" });
  });

  // Failure: a javascript: or file: console address is saved and loaded into the console view.
  it("refuses a console URL that is a javascript: link in both mode", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: "javascript:alert(1)",
    });
    expect(result).toEqual({ error: "Invalid Console URL — must be https:// (http:// only on this computer)" });
  });

  // Failure: server mode saves with the server address blank and the window opens on an empty page.
  it("refuses a missing server URL in server mode", () => {
    const result = planSettingsSave(savedBoth(), { mode: "server" });
    expect(result).toEqual({ error: "Invalid Server URL — must be https:// (http:// only on this computer)" });
  });

  // Failure: a bad server address in an unused field is reported while the mode itself is unknown.
  it("reports an invalid mode ahead of invalid URLs", () => {
    const result = planSettingsSave(savedBoth(), { mode: "kiosk", serverUrl: "ftp://x", consoleUrl: "ftp://x" });
    expect(result).toEqual({ error: "Invalid mode" });
  });

  // Failure: an unknown quit behaviour is stored and the app then cannot read its own settings at quit.
  it("refuses an unknown quit behaviour and applies nothing", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
      quitBehavior: "maybe",
    });
    expect(result).toEqual({ error: "Invalid quit behaviour" });
  });

  // Failure: null for quit behaviour is treated as "not sent" and the stored choice is overwritten.
  it("refuses a null quit behaviour instead of treating it as absent", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "both",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
      quitBehavior: null,
    });
    expect(result).toEqual({ error: "Invalid quit behaviour" });
  });
});

describe("isValidUrl", () => {
  // Failure: an array holding a valid address is coerced to that address and passes, then the store throws on the write.
  it.each([[["http://127.0.0.1:8080"]], [{ toString: () => "http://127.0.0.1:8080" }]])(
    "rejects a non-string value (%#)",
    (value) => {
      expect(isValidUrl(value)).toBe(false);
    },
  );

  // Failure: a valid server address is rejected and the user cannot save a working setup.
  it.each([
    "http://127.0.0.1:8080/",
    "https://server.example.com:8443/console",
    "http://localhost:8090",
    "https://192.168.1.20:8443",
    "http://[::1]:8090/",
  ])("accepts %s", (url) => {
    expect(isValidUrl(url)).toBe(true);
  });

  // Failure: a remote address over plain http is accepted, so the login and the session travel unencrypted.
  it.each(["http://192.168.1.20:8080", "http://server.example.com:8443/", "http://example.com"])(
    "rejects plain http to a remote host: %s",
    (url) => {
      expect(isValidUrl(url)).toBe(false);
    },
  );

  // Failure: a remote host that only contains a loopback name passes as loopback, so plain http reaches the remote server.
  it.each([
    "http://localhost.evil.example",
    "http://evil.example/localhost",
    "http://localhost@evil.example",
    "http://127.0.0.1.evil.example",
    "http://evil.example/?host=127.0.0.1",
  ])("rejects a loopback look-alike: %s", (url) => {
    expect(isValidUrl(url)).toBe(false);
  });

  // Failure: a loopback host on a non-http scheme passes, so the scheme check is lost.
  it.each(["ftp://localhost:21", "ws://localhost:8080", "file://127.0.0.1/share/x"])(
    "rejects a non-http scheme on loopback: %s",
    (url) => {
      expect(isValidUrl(url)).toBe(false);
    },
  );

  // Failure: a file:, javascript: or scheme-less address is accepted and loaded into a view.
  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://files.example.com/", "server.example.com:8443", ""])(
    "rejects %s",
    (url) => {
      expect(isValidUrl(url)).toBe(false);
    },
  );

  // Failure: a missing field from the renderer crashes the save handler instead of returning a message.
  it.each([undefined, null])("rejects a missing value (%s) without throwing", (value) => {
    expect(isValidUrl(value)).toBe(false);
  });
});

describe("planSettingsSave plain http", () => {
  // Failure: a remote server saved over plain http is accepted, so the login crosses the network unencrypted.
  it("refuses a remote server over plain http", () => {
    const result = planSettingsSave(savedBoth(), { mode: "server", serverUrl: "http://192.168.1.20:8080" });
    expect(result).toEqual({ error: "Invalid Server URL — must be https:// (http:// only on this computer)" });
  });

  // Failure: a remote console over plain http is accepted, so the console login crosses the network unencrypted.
  it("refuses a remote console over plain http", () => {
    const result = planSettingsSave(savedBoth(), { mode: "console", consoleUrl: "http://console.example.com:8090" });
    expect(result).toEqual({ error: "Invalid Console URL — must be https:// (http:// only on this computer)" });
  });

  // Failure: plain http to this computer is refused, so the local server cannot be saved.
  it("accepts plain http to localhost", () => {
    const result = planSettingsSave(savedBoth(), { mode: "server", serverUrl: "http://localhost:8080" });
    expect(result.error).toBeUndefined();
  });
});

describe("planSettingsSave empty mode", () => {
  // Failure: an empty mode from the dialog is treated as invalid instead of falling back to Both.
  it("falls back to both when the mode is an empty string", () => {
    const result = planSettingsSave(savedBoth(), {
      mode: "",
      serverUrl: SERVER_URL,
      consoleUrl: CONSOLE_URL,
    });
    expect(result.apply.mode).toBe("both");
  });
});

describe("writeSavePlan", () => {
  // Failure: a console URL that fails to save leaves the mode switched, so the window keeps the old mode while the store says the new one.
  it("keeps the saved mode when an earlier write throws", () => {
    const store = { mode: "both", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" };
    Object.defineProperty(store, "consoleUrl", {
      get: () => CONSOLE_URL,
      set: () => {
        throw new Error("disk full");
      },
    });

    expect(() => writeSavePlan(store, { mode: "console", consoleUrl: NEW_CONSOLE_URL })).toThrow("disk full");
    expect(store.mode).toEqual("both");
  });

  // Failure: a save drops one of the fields the plan carries, so the stored settings differ from what the user saved.
  it("writes every field the plan carries", () => {
    const store = { mode: "both", serverUrl: SERVER_URL, consoleUrl: CONSOLE_URL, quitBehavior: "stop" };
    writeSavePlan(store, { mode: "server", serverUrl: NEW_SERVER_URL, quitBehavior: "keep" });

    expect(store).toEqual({
      mode: "server",
      serverUrl: NEW_SERVER_URL,
      consoleUrl: CONSOLE_URL,
      quitBehavior: "keep",
    });
  });
});
