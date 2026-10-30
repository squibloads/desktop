import { describe, it, expect } from "vitest";

const { isFromAppPage } = require("../../src/main/ipc-senders.js");

const ROOT = "file:///C:/app/renderer/";
const SHELL = "file:///C:/app/renderer/shell.html";
const SETTINGS = "file:///C:/app/renderer/settings.html";

/**
 * A web contents as the rule sees it: its main frame, its current URL, and whether it is alive.
 */
function page(url, { destroyed = false } = {}) {
  return { getURL: () => url, isDestroyed: () => destroyed, mainFrame: { name: "main" } };
}

// The request as Electron delivers it: the web contents that sent it and the frame it came from.
const event = (sender, senderFrame = sender.mainFrame) => ({ sender, senderFrame });
const only = (webContents) => [() => webContents];

describe("isFromAppPage", () => {
  // Failure: a call from the console view is accepted when it should only come from the shell, so any view that can run the bridge can change settings.
  it("accepts a call from an app page in an allowed window", () => {
    const shell = page(SHELL);
    expect(isFromAppPage(event(shell), only(shell), ROOT)).toBe(true);
  });

  // Failure: a call from a window the handler does not name is accepted, so the handler is not limited to the window that should make it.
  it("refuses an app page in a window the handler does not allow", () => {
    const shell = page(SHELL);
    const consoleView = page("file:///C:/app/renderer/error.html");
    expect(isFromAppPage(event(consoleView), only(shell), ROOT)).toBe(false);
  });

  // Failure: a remote page that has navigated into an allowed view reaches the handlers, because the view itself is the one allowed.
  it("refuses an allowed window that now shows a site", () => {
    const view = page("https://console.example.com/");
    expect(isFromAppPage(event(view), only(view), ROOT)).toBe(false);
  });

  // Failure: a plain http page in an allowed view reaches the handlers, so a cleartext page can change settings.
  it("refuses an allowed window that shows plain http", () => {
    const view = page("http://192.168.1.20:8080/");
    expect(isFromAppPage(event(view), only(view), ROOT)).toBe(false);
  });

  // Failure: a blank page in an allowed view reaches the handlers, so a page with no address is trusted as an app page.
  it("refuses an allowed window that shows a blank page", () => {
    const view = page("about:blank");
    expect(isFromAppPage(event(view), only(view), ROOT)).toBe(false);
  });

  // Failure: a destroyed window still answers, so a call made as the window closes runs against a view that is gone.
  it("refuses a destroyed window", () => {
    const shell = page(SHELL, { destroyed: true });
    expect(isFromAppPage(event(shell), only(shell), ROOT)).toBe(false);
  });

  // Failure: a request with no sender is accepted, so a call the window system cannot attribute goes through.
  it("refuses a request with no sender", () => {
    const shell = page(SHELL);
    expect(isFromAppPage(undefined, only(shell), ROOT)).toBe(false);
    expect(isFromAppPage({}, only(shell), ROOT)).toBe(false);
  });

  // Failure: an unreadable address is taken as an app page, so a page that cannot say where it is gets the bridge.
  it("refuses a sender whose address cannot be read", () => {
    const broken = { getURL: () => { throw new Error("Object has been destroyed"); }, isDestroyed: () => false, mainFrame: {} };
    expect(isFromAppPage(event(broken), only(broken), ROOT)).toBe(false);
  });

  // Failure: a list of windows that cannot be read leaves the call unanswered, so the handler hangs instead of refusing.
  it("refuses when the window list cannot be read", () => {
    const shell = page(SHELL);
    expect(isFromAppPage(event(shell), null, ROOT)).toBe(false);
  });

  // Failure: one window whose reader throws refuses every window in the list, so the shell's call fails when the Settings window is the broken one.
  it("accepts a call from an allowed window when another reader throws", () => {
    const settings = page(SETTINGS);
    const broken = () => {
      throw new Error("Object has been destroyed");
    };
    expect(isFromAppPage(event(settings), [broken, () => settings], ROOT)).toBe(true);
  });

  // Failure: an unreadable window lets any caller through, so a call from a window the handler does not list is accepted while a neighbour's reader throws.
  it("refuses an unlisted window when another reader throws", () => {
    const shell = page(SHELL);
    const view = page("file:///C:/app/renderer/error.html");
    const broken = () => {
      throw new Error("Object has been destroyed");
    };
    expect(isFromAppPage(event(view), [broken, () => shell], ROOT)).toBe(false);
  });

  // Failure: a missing window in the list blocks the windows that do exist, so Settings cannot save while the shell is open.
  it("accepts a call from an allowed window when another listed window is missing", () => {
    const settings = page(SETTINGS);
    expect(isFromAppPage(event(settings), [() => null, () => settings], ROOT)).toBe(true);
  });

  // Failure: the check accepts only one listed window, so a handler shared by two windows refuses one of them.
  it("accepts a call from any of several allowed windows", () => {
    const shell = page(SHELL);
    const settings = page(SETTINGS);
    expect(isFromAppPage(event(settings), [() => shell, () => settings], ROOT)).toBe(true);
    expect(isFromAppPage(event(shell), [() => shell, () => settings], ROOT)).toBe(true);
  });

  // Failure: a page from another folder on disk is accepted, so a file the app did not ship reaches the handlers.
  it("refuses a file page outside the app's renderer folder", () => {
    const shell = page("file:///C:/other/shell.html");
    expect(isFromAppPage(event(shell), only(shell), ROOT)).toBe(false);
  });

  // Failure: a network-share file page is accepted, so a page on another machine's disk reaches the handlers.
  it("refuses a file page on a network share", () => {
    const shell = page("file://host/share/renderer/shell.html");
    expect(isFromAppPage(event(shell), only(shell), ROOT)).toBe(false);
  });

  // Failure: a sibling folder that shares the renderer folder's name as a prefix is accepted, so renderer-evil/ passes as renderer/.
  it("refuses a sibling folder whose name starts with the renderer folder's name", () => {
    const shell = page("file:///C:/app/renderer-evil/shell.html");
    expect(isFromAppPage(event(shell), only(shell), ROOT)).toBe(false);
  });

  // Failure: a drive letter in a different case is refused, so every app page fails on a machine that reports the path that way.
  it("accepts the renderer folder with a different drive-letter case", () => {
    const shell = page("file:///c:/app/renderer/shell.html");
    expect(isFromAppPage(event(shell), only(shell), ROOT)).toBe(true);
  });

  // Failure: a frame inside an app page reaches the handlers, so an iframe the app did not make can call the bridge.
  it("refuses a sub-frame of an app page", () => {
    const shell = page(SHELL);
    const childFrame = { name: "child" };
    expect(isFromAppPage(event(shell, childFrame), only(shell), ROOT)).toBe(false);
  });
});
