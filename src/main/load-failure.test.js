import { describe, it, expect } from "vitest";

const { shouldShowErrorPage, errorPageQuery } = require("./load-failure.js");

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
