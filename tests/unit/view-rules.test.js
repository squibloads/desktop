import { describe, it, expect } from "vitest";

const { isNavigationAllowed, windowOpenAction, mainFrameRequestAllowed, requestAllowed } = require("../../src/main/view-rules.js");

describe("mainFrameRequestAllowed", () => {
  // Failure: a configured https page redirected to plain http on another site loads in the view, carrying the login over http.
  it("refuses a main-frame request to another origin, over http or https", () => {
    expect(mainFrameRequestAllowed("http://192.168.1.99:8080/", "https://console.example.com:8443/")).toBe(false);
    expect(mainFrameRequestAllowed("https://other.example.com/", "https://console.example.com:8443/")).toBe(false);
  });

  // Failure: the console's own pages are refused, so the console stops after its first page.
  it("allows a main-frame request to the configured origin", () => {
    expect(mainFrameRequestAllowed("https://console.example.com:8443/v1/x", "https://console.example.com:8443/")).toBe(true);
  });

  // Failure: the app's own pages are refused, so the refusal and error pages cannot be shown.
  it("allows the app's own file pages and blank pages", () => {
    expect(mainFrameRequestAllowed("file:///C:/app/renderer/error.html", "https://console.example.com:8443/")).toBe(true);
    expect(mainFrameRequestAllowed("about:blank", "https://console.example.com:8443/")).toBe(true);
  });

  // Failure: a refused configured address lets an http request through, so a redirect loads an address the rule refuses.
  it("refuses every http request when the configured address is itself refused", () => {
    expect(mainFrameRequestAllowed("http://192.168.1.20:8080/", "http://192.168.1.20:8080/")).toBe(false);
  });
});

describe("requestAllowed", () => {
  const views = { server: 7, console: 9 };
  const settings = { serverUrl: "https://server.example.com:8443/", consoleUrl: "https://console.example.com/" };
  const readViews = () => views;
  const readSettings = () => settings;
  const page = (webContentsId, url) => ({ resourceType: "mainFrame", webContentsId, url });

  // Failure: a server-side redirect from the server view to another site loads in the view, past the navigation check.
  it("cancels a main-frame redirect from the server view to another site", () => {
    expect(requestAllowed(page(7, "https://other.example.com/login"), readViews, readSettings)).toBe(false);
  });

  // Failure: the server view's own pages are cancelled, so the server stops after its first page.
  it("allows the server view's own pages", () => {
    expect(requestAllowed(page(7, "https://server.example.com:8443/v1/x"), readViews, readSettings)).toBe(true);
  });

  // Failure: an https page redirected to plain http on its own host carries the login over http.
  it("cancels a downgrade to plain http on the same host", () => {
    expect(requestAllowed(page(7, "http://server.example.com:8443/"), readViews, readSettings)).toBe(false);
  });

  // Failure: a view is judged against the other view's address, so the console is blocked on its own pages or the server may load the console's site.
  it("judges each view against its own configured address", () => {
    expect(requestAllowed(page(9, "https://console.example.com/v1/x"), readViews, readSettings)).toBe(true);
    expect(requestAllowed(page(9, "https://server.example.com:8443/"), readViews, readSettings)).toBe(false);
    expect(requestAllowed(page(7, "https://console.example.com/"), readViews, readSettings)).toBe(false);
  });

  // Failure: a web contents that is not a view loads another site, because no view address is there to compare with.
  it("refuses a main-frame request from a web contents that is not a view", () => {
    expect(requestAllowed(page(42, "https://other.example.com/"), readViews, readSettings)).toBe(false);
  });

  // Failure: a web contents that is not a view is judged against the server address, so it may load the server's pages.
  it("refuses the server address from a web contents that is not a view", () => {
    expect(requestAllowed(page(42, "https://server.example.com:8443/"), readViews, readSettings)).toBe(false);
  });

  // Failure: the app's own file pages are cancelled, so the error and refusal pages cannot load.
  it("allows the app's own file pages from any web contents", () => {
    expect(requestAllowed(page(42, "file:///C:/app/renderer/error.html"), readViews, readSettings)).toBe(true);
  });

  // Failure: a page's scripts and images are judged as navigations, so a page that loads them from a CDN stops working.
  it("does not judge a page's subresources", () => {
    const script = { resourceType: "script", webContentsId: 7, url: "https://cdn.example.net/app.js" };
    const image = { resourceType: "image", webContentsId: 42, url: "https://cdn.example.net/logo.png" };
    expect(requestAllowed(script, readViews, readSettings)).toBe(true);
    expect(requestAllowed(image, readViews, readSettings)).toBe(true);
  });

  // Failure: a request with no web contents id matches a view that has none, and is judged against that view's address.
  it("refuses a main-frame request with no web contents id when no view exists", () => {
    const none = { server: null, console: null };
    expect(requestAllowed({ resourceType: "mainFrame", url: "https://server.example.com:8443/" }, () => none, readSettings)).toBe(false);
  });

  // Failure: an unreadable settings store leaves the request unanswered, so the view hangs instead of being refused.
  it("refuses when the settings cannot be read", () => {
    const broken = () => {
      throw new Error("corrupt store");
    };
    expect(requestAllowed(page(7, "https://server.example.com:8443/"), readViews, broken)).toBe(false);
  });

  // Failure: an unreadable view leaves the request unanswered, so the page hangs instead of being refused.
  it("refuses when the views cannot be read", () => {
    const broken = () => {
      throw new Error("Object has been destroyed");
    };
    expect(requestAllowed(page(7, "https://server.example.com:8443/"), broken, readSettings)).toBe(false);
  });

  // Failure: the address is read once, so a changed server URL keeps its old origin until the app restarts.
  it("applies a changed address to the next request", () => {
    const live = { serverUrl: "https://a.example.com/", consoleUrl: "" };
    const read = () => live;
    expect(requestAllowed(page(7, "https://a.example.com/x"), readViews, read)).toBe(true);
    live.serverUrl = "https://b.example.com/";
    expect(requestAllowed(page(7, "https://a.example.com/x"), readViews, read)).toBe(false);
  });
});

describe("isNavigationAllowed", () => {
  // Failure: a link to another page of the same site is blocked and the in-app page cannot move between its own pages.
  it("allows a path and query change on the same origin", () => {
    expect(isNavigationAllowed("https://example.com/a?x=1", "https://example.com/b?y=2")).toBe(true);
  });

  // Failure: a different port on the same host is allowed and the embedded view loads a second service.
  it("blocks the same host on a different port", () => {
    expect(isNavigationAllowed("https://example.com/", "https://example.com:8443/")).toBe(false);
  });

  // Failure: an http downgrade of the configured https server is allowed and traffic leaves TLS.
  it("blocks the same host over a different scheme", () => {
    expect(isNavigationAllowed("https://example.com/", "http://example.com/")).toBe(false);
  });

  // Failure: a configured remote plain-http address still allows navigation, so the page moves on over http.
  it("refuses navigation when the configured URL is a remote plain-http address", () => {
    expect(isNavigationAllowed("http://192.168.1.20:8080/", "http://192.168.1.20:8080/next")).toBe(false);
  });

  // Failure: loopback http is refused as a configured URL, so the local server cannot be navigated within.
  it("allows navigation within a loopback http address", () => {
    expect(isNavigationAllowed("http://localhost:8090/", "http://localhost:8090/next")).toBe(true);
  });

  // Failure: a link to a different host is loaded inside the app view with the app's preload attached.
  it("blocks a different host", () => {
    expect(isNavigationAllowed("https://example.com/", "https://other.example.com/")).toBe(false);
  });

  // Failure: a same-site link carrying a user name in its URL is blocked, so the page does not load.
  it("allows a target that differs only by credentials in the URL", () => {
    expect(isNavigationAllowed("https://example.com/", "https://user:secret@example.com/")).toBe(true);
  });

  // Failure: a corrupt server URL in settings lets every navigation through.
  it("blocks everything when the allowed URL does not parse", () => {
    expect(isNavigationAllowed("not a url", "https://example.com/")).toBe(false);
  });

  // Failure: a malformed link from the page is loaded instead of being cancelled.
  it("blocks a target that does not parse", () => {
    expect(isNavigationAllowed("https://example.com/", "not a url")).toBe(false);
  });

  // Failure: an empty settings value lets the first navigation through before the server URL is set.
  it("blocks when both strings are empty", () => {
    expect(isNavigationAllowed("", "")).toBe(false);
  });

  // Failure: an empty link target from the page is treated as a same-site link.
  it("blocks an empty target when the allowed URL is set", () => {
    expect(isNavigationAllowed("https://example.com/", "")).toBe(false);
  });

  // Failure: a blank page inside the app view is treated as the server and its script runs with the app preload.
  it("blocks about:blank", () => {
    expect(isNavigationAllowed("https://example.com/", "about:blank")).toBe(false);
  });

  // Failure: a local file link from the page replaces the server view with a file on disk.
  it("blocks a file URL when the allowed URL is http", () => {
    expect(isNavigationAllowed("https://example.com/", "file:///C:/Users/x/page.html")).toBe(false);
  });

  // Failure: a non-http(s) setting (file:, data:, or "localhost:3000" which parses as a scheme) has the opaque origin "null" and would allow every other opaque target.
  it.each([
    ["file:///C:/a.html", "file:///C:/b.html"],
    ["data:text/html,a", "data:text/html,b"],
    ["localhost:3000", "localhost:4000"],
  ])("refuses when the allowed URL %s is not http(s)", (allowed, target) => {
    expect(isNavigationAllowed(allowed, target)).toBe(false);
  });
});

describe("windowOpenAction", () => {
  // Failure: a link with an http address opened by the page does not reach the user's browser.
  it("opens an https URL", () => {
    expect(windowOpenAction("https://example.com/docs")).toEqual({ open: true });
  });

  // Failure: a plain http link opened by the page does not reach the user's browser.
  it("opens an http URL", () => {
    expect(windowOpenAction("http://127.0.0.1:8080/")).toEqual({ open: true });
  });

  // Failure: an upper-case scheme is not opened today (the check is case-sensitive), so a change here is a visible behaviour change.
  it("does not open an upper-case HTTP:// URL (today's case-sensitive match)", () => {
    expect(windowOpenAction("HTTP://example.com/")).toEqual({ open: false });
  });

  // Failure: a javascript: link from the page runs in the user's shell through the default handler.
  it("does not open a javascript: URL", () => {
    expect(windowOpenAction("javascript:alert(1)")).toEqual({ open: false });
  });

  // Failure: widening the scheme check (a prefix match on "ftp:", "mailto:" or "vbscript:") hands those links to the user's shell.
  it.each(["ftp://example.com/x", "mailto:a@example.com", "vbscript:msgbox(1)"])(
    "does not open %s",
    (url) => {
      expect(windowOpenAction(url)).toEqual({ open: false });
    },
  );

  // Failure: a file: link from the page opens a local file in the user's shell.
  it("does not open a file: URL", () => {
    expect(windowOpenAction("file:///C:/Windows/system.ini")).toEqual({ open: false });
  });

  // Failure: a data: link from the page opens an arbitrary document in the user's browser.
  it("does not open a data: URL", () => {
    expect(windowOpenAction("data:text/html,<p>x</p>")).toEqual({ open: false });
  });

  // Failure: an empty link from the page is passed to the shell as an empty command.
  it("does not open an empty URL", () => {
    expect(windowOpenAction("")).toEqual({ open: false });
  });

  // Failure: a request without a string URL crashes the window-open handler and the page's link is lost silently.
  // Today's handler would throw a TypeError here; the window API always passes a string, so this path is only defensive.
  it.each([undefined, null, 42, { href: "https://example.com/" }])(
    "does not open and does not throw for a non-string URL (%j)",
    (url) => {
      expect(windowOpenAction(url)).toEqual({ open: false });
    },
  );
});
