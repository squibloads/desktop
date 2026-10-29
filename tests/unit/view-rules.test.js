import { describe, it, expect } from "vitest";

const { isNavigationAllowed, windowOpenAction } = require("../../src/main/view-rules.js");

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

  // Failure: two local file links are treated as different sites and a page cannot move between its own local files.
  // Today's code compares the opaque origin "null" for both, so this is allowed. Settings only hold http(s) URLs, so this path is not reachable from the UI.
  it("treats two file URLs as the same opaque origin (today's behaviour)", () => {
    expect(isNavigationAllowed("file:///C:/a.html", "file:///C:/b.html")).toBe(true);
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

  // Failure: an upper-case scheme is opened in the browser today; the rule matches today's case-sensitive check, so a change here is a visible behaviour change.
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
