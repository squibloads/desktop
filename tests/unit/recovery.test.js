import { describe, it, expect } from "vitest";

const { planRecovery } = require("../../src/main/recovery.js");

const ERROR_PAGE = "file:///app/renderer/error.html?url=http%3A%2F%2F127.0.0.1%3A8090%2F";
const LOADING_PAGE = "file:///app/renderer/local-loading.html";
const LIVE_LOCAL = "http://127.0.0.1:8090/";
const LIVE_REMOTE = "https://server.example.com:8443/console";

// A remote (server or non-local console) view on a live page, healthy.
const REMOTE = { localConsole: false, starting: false, quitting: false, url: LIVE_REMOTE, consoleDown: false };
// The local console view on a live page, healthy.
const LOCAL = { localConsole: true, starting: false, quitting: false, url: LIVE_LOCAL, consoleDown: false };

describe("planRecovery quitting", () => {
  // Failure: a recovery during quit re-runs a start that races the pod stop and leaves a pod running.
  it("skips a remote view while the app is quitting", () => {
    expect(planRecovery({ ...REMOTE, quitting: true })).toBe("skip");
  });

  // Failure: quitting restarts the local pod instead of letting the stop finish.
  it("skips the local console while the app is quitting, even on a live page", () => {
    expect(planRecovery({ ...LOCAL, quitting: true })).toBe("skip");
  });

  // Failure: quitting while the console shows an error page starts the local runtime again.
  it("skips the local console while quitting, even when it shows the error page", () => {
    expect(planRecovery({ ...LOCAL, quitting: true, url: ERROR_PAGE, consoleDown: true })).toBe("skip");
  });
});

describe("planRecovery local start", () => {
  // Failure: a recovery replaces the local loading page with a console whose node is not up yet.
  it("skips the local console while a local start owns it", () => {
    expect(planRecovery({ ...LOCAL, starting: true })).toBe("skip");
  });

  // Failure: the same race when the console is showing its error page during a start.
  it("skips the local console mid-start even when it shows the error page", () => {
    expect(planRecovery({ ...LOCAL, starting: true, url: ERROR_PAGE })).toBe("skip");
  });

  // Failure: a local start in progress blocks recovery of the server view, which has nothing to do with it.
  it("does not hold a remote view back for a local start", () => {
    expect(planRecovery({ ...REMOTE, starting: true })).toBe("reload");
  });
});

describe("planRecovery local console", () => {
  // Failure: reloading a console whose pod is stopped fails again and the view never comes back.
  it("restarts the local runtime when the poller reports the console down", () => {
    expect(planRecovery({ ...LOCAL, consoleDown: true })).toBe("restart-local");
  });

  // Failure: a down console on an error page is reloaded, which re-shows the error page.
  it("restarts the local runtime when the console is down and showing the error page", () => {
    expect(planRecovery({ ...LOCAL, consoleDown: true, url: ERROR_PAGE })).toBe("restart-local");
  });

  // Failure: a console that is up gets restarted on every reload, dropping the session.
  it("reloads a live local console page that the poller does not see as down", () => {
    expect(planRecovery(LOCAL)).toBe("reload");
  });

  // Failure: the local Retry stops working because a reload re-shows our own error page.
  it("restarts the local runtime when the console shows the local error page", () => {
    expect(planRecovery({ ...LOCAL, url: ERROR_PAGE })).toBe("restart-local");
  });

  // Failure: a reload of the local loading page never reaches the console, so the start is never reached.
  it("restarts the local runtime when the console shows the local loading page", () => {
    expect(planRecovery({ ...LOCAL, url: LOADING_PAGE })).toBe("restart-local");
  });

  // Failure: a blank local console view stays blank because nothing starts the pod.
  it("restarts the local runtime when nothing is loaded yet", () => {
    expect(planRecovery({ ...LOCAL, url: "" })).toBe("restart-local");
  });

  // Failure: an about:blank local console view is reloaded and stays blank.
  it("restarts the local runtime when the console shows about:blank", () => {
    expect(planRecovery({ ...LOCAL, url: "about:blank" })).toBe("restart-local");
  });
});

describe("planRecovery remote view", () => {
  // Failure: a server view on a live page is loaded again from the saved URL and loses its state.
  it("reloads a remote view on a live page", () => {
    expect(planRecovery(REMOTE)).toBe("reload");
  });

  // Failure: a server view that failed to load reloads its own error page forever.
  it("loads the saved URL when a remote view shows the error page", () => {
    expect(planRecovery({ ...REMOTE, url: ERROR_PAGE })).toBe("load-url");
  });

  // Failure: a remote view stuck on a browser-internal page is reloaded and stays stuck.
  it.each(["about:blank", "chrome-error://chromewebdata/", "data:text/html,hi", ""])(
    "loads the saved URL when a remote view shows %s",
    (url) => {
      expect(planRecovery({ ...REMOTE, url })).toBe("load-url");
    },
  );

  // Failure: a remote view with no URL at all is reloaded instead of loaded from settings.
  it("loads the saved URL when the view has no URL", () => {
    expect(planRecovery({ ...REMOTE, url: undefined })).toBe("load-url");
  });

  // Failure: the local-console down flag makes a healthy remote view restart a local pod.
  it("ignores the console-down flag for a remote view", () => {
    expect(planRecovery({ ...REMOTE, consoleDown: true })).toBe("reload");
  });
});
