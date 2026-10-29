import { describe, it, expect } from "vitest";

const { shouldShowErrorPage, errorPageQuery, recoveryAction } = require("../../src/main/load-failure.js");

describe("shouldShowErrorPage", () => {
  it("shows the error page when the main frame cannot connect", () => {
    expect(shouldShowErrorPage(-102, true, "https://turnstone.example.com:8443/")).toBe(true);
  });

  it("ignores ERR_ABORTED: a redirect or superseded navigation, not an outage", () => {
    expect(shouldShowErrorPage(-3, true, "https://turnstone.example.com:8443/")).toBe(false);
  });

  it("ignores failures in sub-frames", () => {
    expect(shouldShowErrorPage(-102, false, "https://turnstone.example.com:8443/embed")).toBe(false);
  });

  it("never replaces the error page itself", () => {
    expect(shouldShowErrorPage(-6, true, "file:///app/error.html")).toBe(false);
  });
});

describe("errorPageQuery", () => {
  it("is an object, as loadFile's query option requires", () => {
    expect(errorPageQuery("https://turnstone.example.com:8443")).toEqual({ url: "https://turnstone.example.com:8443" });
  });
});

describe("recoveryAction non-http pages", () => {
  it.each(["about:blank", "data:text/html,hi", "chrome-error://chromewebdata/"])(
    "loads the original URL when the view shows %s",
    (url) => {
      expect(recoveryAction(url)).toBe("load-original");
    },
  );
});

describe("recoveryAction", () => {
  it("loads the original URL when the view is showing the local error page", () => {
    expect(recoveryAction("file:///app/renderer/error.html?url=http%3A%2F%2F127.0.0.1%3A8090%2F")).toBe("load-original");
  });

  it("loads the original URL when the view is showing a local loading page", () => {
    expect(recoveryAction("file:///app/renderer/local-loading.html")).toBe("load-original");
  });

  it("reloads a live server page", () => {
    expect(recoveryAction("http://127.0.0.1:8090/")).toBe("reload");
  });

  it("reloads a live https page", () => {
    expect(recoveryAction("https://example.com:8443/console")).toBe("reload");
  });

  it("loads the original URL when nothing is loaded yet (empty string)", () => {
    expect(recoveryAction("")).toBe("load-original");
  });

  it("loads the original URL when the URL is undefined", () => {
    expect(recoveryAction(undefined)).toBe("load-original");
  });
});
