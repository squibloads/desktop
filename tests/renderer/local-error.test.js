import { describe, it, expect, afterEach } from "vitest";
import { loadPage, createFakeBridge, closeAllPages } from "../helpers/load-page.js";

afterEach(() => {
  closeAllPages();
});

// Failure: the error code, message or detail is shown as HTML, so text from the failure
// (a path, a log line, a crafted value) can add elements or run script in the error page.
const HOSTILE = {
  code: "<img src=x onerror=y>",
  message: '<b onclick="z()">bold</b>',
  detail: "<script>alert(1)</script>",
};

describe("local error page", () => {
  // Failure: the page shows nothing, or the wrong text, for the error the start failed with.
  it("shows the code, message and detail from the query string", () => {
    const page = loadPage("local-error", {
      ...createFakeBridge(),
      query: { code: "MACHINE_START_FAILED", message: "The Podman machine did not start", detail: "exit status 125" },
    });
    const doc = page.document;

    expect(doc.getElementById("error-title").textContent).toBe("MACHINE_START_FAILED");
    expect(doc.getElementById("error-message").textContent).toBe("The Podman machine did not start");
    expect(doc.getElementById("error-detail").textContent).toBe("exit status 125");
  });

  // Failure: a missing parameter shows the word "null" or "undefined", or throws and leaves the buttons unwired.
  it("shows empty text when the query string carries no parameters", () => {
    const page = loadPage("local-error", createFakeBridge());
    const doc = page.document;

    expect(doc.getElementById("error-title").textContent).toBe("");
    expect(doc.getElementById("error-message").textContent).toBe("");
    expect(doc.getElementById("error-detail").textContent).toBe("");
  });

  // Failure: markup in the code, message or detail becomes elements on the page instead of text.
  it("renders markup in the code, message and detail as text, creating no elements", () => {
    const page = loadPage("local-error", { ...createFakeBridge(), query: HOSTILE });
    const doc = page.document;

    expect(doc.getElementById("error-title").textContent).toBe("<img src=x onerror=y>");
    expect(doc.getElementById("error-message").textContent).toBe('<b onclick="z()">bold</b>');
    expect(doc.getElementById("error-detail").textContent).toBe("<script>alert(1)</script>");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.getElementById("error-title").children.length).toBe(0);
  });

  // Failure: Retry opens Settings instead of re-running the start, so the user can never recover without restarting the app.
  it("Retry calls retryLocal once and nothing else", () => {
    const page = loadPage("local-error", createFakeBridge());

    page.document.getElementById("btn-retry").click();

    expect(page.api.retryLocal).toHaveBeenCalledTimes(1);
    expect(page.api.retryLocal).toHaveBeenCalledWith();
    expect(page.api.openSettings).not.toHaveBeenCalled();
  });

  // Failure: Settings re-runs the start instead of opening the settings dialog, so the user cannot change the connection.
  it("Settings calls openSettings once and nothing else", () => {
    const page = loadPage("local-error", createFakeBridge());

    page.document.getElementById("btn-settings").click();

    expect(page.api.openSettings).toHaveBeenCalledTimes(1);
    expect(page.api.openSettings).toHaveBeenCalledWith();
    expect(page.api.retryLocal).not.toHaveBeenCalled();
  });
});
