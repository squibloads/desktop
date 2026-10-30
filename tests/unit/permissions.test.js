import { describe, it, expect, vi } from "vitest";

const {
  permissionNameAllowed,
  originOf,
  allowedOriginsFrom,
  requestDecision,
  checkDecision,
} = require("../../src/main/permissions.js");

const CONSOLE = "https://console.example";
const CONSOLE_PAGE = "https://console.example/";
const EVIL_PAGE = "https://evil.example/";

// A configured-origins getter that returns the given list.
const granted = (origins) => () => origins;

describe("permissionNameAllowed", () => {
  // Failure: voice input is refused, so microphone capture stops working for the one page that needs it.
  it("allows audio capture", () => {
    expect(permissionNameAllowed("media", ["audio"])).toBe(true);
  });

  // Failure: a configured page gets the camera, or a mixed audio and video request is granted whole.
  it("refuses video, and refuses a request that also asks for video", () => {
    expect(permissionNameAllowed("media", ["video"])).toBe(false);
    expect(permissionNameAllowed("media", ["audio", "video"])).toBe(false);
  });

  // Failure: a media request that names no usable type is granted, because an empty list passes an every() check. Desktop capture arrives this way.
  it("refuses a media request with no usable media type", () => {
    expect(permissionNameAllowed("media", undefined)).toBe(false);
    expect(permissionNameAllowed("media", [])).toBe(false);
    expect(permissionNameAllowed("media", ["unknown"])).toBe(false);
  });

  // Failure: copy buttons break in the console, because the clipboard write is refused.
  it("allows clipboard writes", () => {
    expect(permissionNameAllowed("clipboard-sanitized-write", undefined)).toBe(true);
  });

  // Failure: fullscreen is granted although the console never requests it, so a page gets a permission it does not use.
  it("refuses fullscreen, which the console does not use", () => {
    expect(permissionNameAllowed("fullscreen", undefined)).toBe(false);
  });

  // Failure: a device, location, clipboard-read or file permission is granted to a configured page that never needs it.
  it("refuses every other permission", () => {
    const refused = [
      "geolocation", "notifications", "midiSysex", "hid", "serial", "usb", "display-capture",
      "clipboard-read", "openExternal", "fileSystem", "pointerLock", "idle-detection",
      "window-management", "keyboardLock", "speaker-selection", "storage-access", "unknown",
    ];
    for (const permission of refused) {
      expect(permissionNameAllowed(permission, undefined), permission).toBe(false);
    }
  });
});

describe("originOf", () => {
  // Failure: the path or the userinfo stays in the origin, so the comparison never matches a configured origin.
  it("returns the origin of an http or https URL, without path or userinfo", () => {
    expect(originOf("https://user:pw@console.example:8443/v1/x?y=1")).toBe("https://console.example:8443");
  });

  // Failure: the trailing slash of the URL form Electron sends for a check is kept, so the origin never matches.
  it("accepts the URL form Electron sends for a check, with a trailing slash", () => {
    expect(originOf("http://127.0.0.1:64843/")).toBe("http://127.0.0.1:64843");
  });

  // Failure: a file:, blob:, ws:, data: or unparseable address gets an origin that could match a configured one.
  it("returns an empty string for anything that is not http or https", () => {
    const others = [
      "file:///C:/x.html", "javascript:alert(1)", "blob:https://console.example/uuid",
      "ws://console.example/", "data:text/html,hi", "about:blank", "not a url", "", undefined,
    ];
    for (const url of others) {
      expect(originOf(url), String(url)).toBe("");
    }
  });
});

describe("allowedOriginsFrom", () => {
  // Failure: a server view that is not shown keeps its origin, so a stale remote server gains permissions in Local mode.
  it("drops the server origin when the server view is hidden", () => {
    const settings = {
      hasServer: false,
      serverUrl: "https://server.example:8443/v1",
      hasConsole: true,
      consoleUrl: CONSOLE_PAGE,
    };
    expect(allowedOriginsFrom(settings)).toEqual([CONSOLE]);
  });

  // Failure: a console view that is not shown keeps its origin, so the origin of a hidden view gains permissions.
  it("drops the console origin when the console view is hidden", () => {
    const settings = {
      hasServer: true,
      serverUrl: "https://server.example:8443/v1",
      hasConsole: false,
      consoleUrl: CONSOLE_PAGE,
    };
    expect(allowedOriginsFrom(settings)).toEqual(["https://server.example:8443"]);
  });

  // Failure: one bad URL throws, and the other view loses its origin too.
  it("skips a configured URL that is not http or https, or does not parse", () => {
    const settings = {
      hasServer: true,
      serverUrl: "file:///C:/x.html",
      hasConsole: true,
      consoleUrl: CONSOLE_PAGE,
    };
    expect(allowedOriginsFrom(settings)).toEqual([CONSOLE]);
    expect(allowedOriginsFrom({ hasServer: true, serverUrl: "not a url", hasConsole: false })).toEqual([]);
  });
});

describe("requestDecision", () => {
  const request = (overrides) => ({
    permission: "media",
    requestingUrl: CONSOLE_PAGE,
    topUrl: CONSOLE_PAGE,
    isMainFrame: true,
    mediaTypes: ["audio"],
    ...overrides,
  });

  // Failure: voice input from the configured console is refused.
  it("allows audio for a configured main frame", () => {
    expect(requestDecision(request({}), granted([CONSOLE]))).toBe(true);
  });

  // Failure: a page from another site gets the microphone, because the requesting URL is never read.
  it("refuses a requesting origin that is not configured", () => {
    expect(requestDecision(request({ requestingUrl: EVIL_PAGE }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: an unconfigured frame inside the configured console gets the microphone, because only the top page is judged.
  it("refuses an unconfigured frame inside the configured console", () => {
    expect(requestDecision(request({ requestingUrl: EVIL_PAGE, isMainFrame: false }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: a frame showing a configured URL inside an unconfigured page gets the microphone, because the top page was never checked.
  it("refuses a frame whose top page is not configured", () => {
    expect(requestDecision(request({ isMainFrame: false, topUrl: EVIL_PAGE }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: the console's own embedded frames lose their permissions, so voice stops working inside them.
  it("allows a frame inside a configured page", () => {
    expect(requestDecision(request({ isMainFrame: false }), granted([CONSOLE]))).toBe(true);
  });

  // Failure: a frame whose top page is unknown is granted, because an empty top URL is read as allowed.
  it("refuses a frame when the top page is unknown", () => {
    expect(requestDecision(request({ isMainFrame: false, topUrl: "" }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: a request with no media types is granted, because an empty list passes an every() check.
  it("refuses a media request with no media types", () => {
    expect(requestDecision(request({ mediaTypes: [] }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: the configured origins are read for a request that is refused anyway, so every denied request pays for a settings read.
  it("does not read the configured origins when the permission is refused", () => {
    const getOrigins = vi.fn(granted([CONSOLE]));
    expect(requestDecision(request({ permission: "geolocation", mediaTypes: undefined }), getOrigins)).toBe(false);
    expect(getOrigins).not.toHaveBeenCalled();
  });
});

describe("checkDecision", () => {
  const check = (overrides) => ({
    permission: "media",
    requestingOrigin: CONSOLE,
    topUrl: CONSOLE_PAGE,
    isMainFrame: true,
    mediaType: "audio",
    ...overrides,
  });

  // Failure: the console reports its own microphone as denied while it is granted, so its permission UI is wrong.
  it("reports audio as allowed for a configured origin", () => {
    expect(checkDecision(check({}), granted([CONSOLE]))).toBe(true);
  });

  // Failure: the URL form Electron sends for a check never matches a configured origin, so every check is denied.
  it("matches the URL form Electron sends for a check", () => {
    expect(checkDecision(check({ requestingOrigin: "https://user:pw@console.example/top?x=1" }), granted([CONSOLE]))).toBe(true);
    expect(checkDecision(check({ requestingOrigin: "http://127.0.0.1:64843/" }), granted(["http://127.0.0.1:64843"]))).toBe(true);
  });

  // Failure: a video check, or an unknown media type, is reported as allowed.
  it("refuses video, and an unknown media type", () => {
    expect(checkDecision(check({ mediaType: "video" }), granted([CONSOLE]))).toBe(false);
    expect(checkDecision(check({ mediaType: "unknown" }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: a media check that names no type is reported as allowed, because a missing type reads as audio.
  it("refuses a media check that names no media type", () => {
    expect(checkDecision(check({ mediaType: undefined }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: a clipboard-read check is reported as allowed, or the clipboard write check is refused and copy breaks.
  it("refuses clipboard-read, and allows the clipboard write", () => {
    expect(checkDecision(check({ permission: "clipboard-read", mediaType: undefined }), granted([CONSOLE]))).toBe(false);
    expect(checkDecision(check({ permission: "clipboard-sanitized-write", mediaType: undefined }), granted([CONSOLE]))).toBe(true);
  });

  // Failure: a check from an unconfigured origin, or an empty origin from an opaque frame, is reported as allowed.
  it("refuses an origin that is not configured, and an empty origin", () => {
    expect(checkDecision(check({ requestingOrigin: EVIL_PAGE }), granted([CONSOLE]))).toBe(false);
    expect(checkDecision(check({ requestingOrigin: "" }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: a frame inside an unconfigured top page is reported as allowed.
  it("refuses a frame whose top page is not configured", () => {
    expect(checkDecision(check({ isMainFrame: false, topUrl: EVIL_PAGE }), granted([CONSOLE]))).toBe(false);
  });

  // Failure: a refused check still reads the configured origins, so every denied check pays for a settings read at page load.
  it("does not read the configured origins when the permission is refused", () => {
    const getOrigins = vi.fn(granted([CONSOLE]));
    expect(checkDecision(check({ permission: "geolocation", mediaType: undefined }), getOrigins)).toBe(false);
    expect(getOrigins).not.toHaveBeenCalled();
  });
});
