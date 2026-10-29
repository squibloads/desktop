import { describe, it, expect, afterEach } from "vitest";
import { loadPage, createFakeBridge, closeAllPages } from "../helpers/load-page.js";

afterEach(() => {
  closeAllPages();
});

// jsdom does not navigate. It reports each navigation it declines with this message,
// so a test counts attempts through the virtual console instead of reading location.
const NAVIGATION_NOT_IMPLEMENTED = "Not implemented: navigation to another Document";

describe("connection error page", () => {
  // Failure: the failed URL is not shown, so the user cannot tell which server is unreachable.
  it("shows the failed URL from the query string as text", () => {
    const page = loadPage("error", { ...createFakeBridge(), query: { url: "http://server.example.test:8080/" } });

    expect(page.document.getElementById("error-url").textContent).toBe("http://server.example.test:8080/");
  });

  // Failure: a failed URL containing markup becomes elements on the page instead of text.
  it("renders markup in the failed URL as text, creating no elements", () => {
    const page = loadPage("error", {
      ...createFakeBridge(),
      query: { url: "http://server.example.test/<img src=x onerror=y>" },
    });
    const doc = page.document;

    expect(doc.getElementById("error-url").textContent).toBe("http://server.example.test/<img src=x onerror=y>");
    expect(doc.querySelector("img")).toBeNull();
  });

  // Failure: Retry with no failed URL navigates anyway. jsdom treats an empty-URL navigation as a no-op on the
  // page's own address and reports nothing, so a reload is not visible here: this test catches only a navigation
  // to another document. The mutation run leaves the empty-URL guard unkilled for that reason.
  it("Retry does not navigate when there is no failed URL", () => {
    const page = loadPage("error", createFakeBridge());

    page.document.getElementById("btn-retry").click();

    expect(page.jsdomErrors).toEqual([]);
  });

  // Failure: Retry does nothing, so the user has to close and reopen the window to reach the server.
  it("Retry asks the browser to load the failed URL", () => {
    const page = loadPage("error", { ...createFakeBridge(), query: { url: "http://server.example.test:8080/" } });

    page.document.getElementById("btn-retry").click();

    expect(page.jsdomErrors).toEqual([NAVIGATION_NOT_IMPLEMENTED]);
  });

  // Failure: Settings re-runs the connection instead of opening the settings dialog.
  it("Settings calls openSettings once and nothing else", () => {
    const page = loadPage("error", { ...createFakeBridge(), query: { url: "http://server.example.test:8080/" } });

    page.document.getElementById("btn-settings").click();

    expect(page.api.openSettings).toHaveBeenCalledTimes(1);
    expect(page.api.openSettings).toHaveBeenCalledWith();
    expect(page.jsdomErrors).toEqual([]);
  });
});
