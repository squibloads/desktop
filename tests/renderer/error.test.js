import { describe, it, expect, afterEach } from "vitest";
import { loadPage, createFakeBridge, closeAllPages } from "../helpers/load-page.js";

afterEach(() => {
  closeAllPages();
});

// jsdom does not navigate. It reports each navigation it declines with this message,
// so a test counts attempts through the virtual console instead of reading location.
// It reports only that a navigation to another document was requested, not where it
// goes: a test can prove a navigation was asked for, never which address it targets.
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

  // Failure: Retry with no failed URL navigates to some other document. This test catches only that.
  // It does not catch the guard being removed. An empty href resolves to the page's own address (an empty
  // reference keeps the base URL's query), and jsdom treats a navigation to the current address as a no-op,
  // so it reports nothing. A reload of the same address, which is what the guard prevents, is not observable
  // here. The mutation pass confirmed this: removing `if (failedUrl)` from error.js survives.
  it("Retry with an empty failed URL does not navigate to another document", () => {
    const page = loadPage("error", { ...createFakeBridge(), query: { url: "" } });

    page.document.getElementById("btn-retry").click();

    expect(page.jsdomErrors).toEqual([]);
  });

  // Failure: Retry does nothing, so the user has to close and reopen the window to reach the server.
  // This proves only that a navigation was requested. The target address is not observable in jsdom,
  // so this test does not show that the failed URL is what gets loaded.
  it("Retry requests a navigation when a failed URL is present", () => {
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

describe("theme", () => {
  // Failure: the error page keeps the dark palette under a light system theme, so its text is hard to read on the light background.
  it("applies the light theme at load when the system prefers light", () => {
    const page = loadPage("error", { ...createFakeBridge(), prefersLight: true });

    expect(page.document.documentElement.dataset.theme).toBe("light");
  });

  // Failure: the error page takes the light palette under a dark system theme.
  it("applies no light theme at load when the system prefers dark", () => {
    const page = loadPage("error", { ...createFakeBridge(), prefersLight: false });

    expect(page.document.documentElement.dataset.theme).toBe("");
  });

  // Failure: the error page keeps the theme it loaded with after the system theme changes.
  it("follows a change event when the system theme switches while the page is open", () => {
    const page = loadPage("error", { ...createFakeBridge(), prefersLight: false });

    page.setPrefersLight(true);
    const afterLight = page.document.documentElement.dataset.theme;
    page.setPrefersLight(false);
    const afterDark = page.document.documentElement.dataset.theme;

    expect(afterLight).toBe("light");
    expect(afterDark).toBe("");
  });
});
