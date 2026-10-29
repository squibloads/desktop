import { describe, it, expect, vi, afterEach } from "vitest";
import { loadPage, createFakeBridge, closeAllPages } from "../helpers/load-page.js";

afterEach(() => {
  closeAllPages();
});

const SERVER = "http://server.example.test:8080";
const CONSOLE = "http://console.example.test:8090";
const URL_ERROR = "Enter a valid URL (http:// or https://)";

// Opens the settings page with the given saved settings. The page fills the
// form in a promise callback and sets the mode radio last, so waiting for a
// checked radio waits for the whole load.
async function openSettings(overrides = {}, pageOptions = {}) {
  const bridge = createFakeBridge({
    settings: {
      mode: "both",
      serverUrl: SERVER,
      consoleUrl: CONSOLE,
      quitBehavior: "stop",
      activeTab: "server",
      ...overrides,
    },
  });
  const page = loadPage("settings", { api: bridge.api, hub: bridge.hub, ...pageOptions });
  await vi.waitFor(() => {
    expect(page.document.querySelector('input[name="mode"]:checked')).not.toBeNull();
  });
  return page;
}

// The classes a url-group carries, without the base class, sorted.
function stateOf(el) {
  return [...el.classList].filter((c) => c !== "url-group").sort();
}

function setValue(page, id, value) {
  page.document.getElementById(id).value = value;
}

function press(page, target, key) {
  target.dispatchEvent(new page.window.KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("field visibility per mode", () => {
  // Failure: a mode shows a URL field it does not use, so the user edits a value Save never reads,
  // or hides the one it does use. The quit row appears outside local mode, where it has no effect.
  it.each([
    // mode, server-group, console-group, local-group
    ["server", [], ["hidden"], ["gone"]],
    ["console", ["hidden"], [], ["gone"]],
    ["both", [], [], ["gone"]],
    ["local", ["gone", "hidden"], ["gone", "hidden"], []],
  ])("mode %s: server %j, console %j, quit row %j", async (mode, serverState, consoleState, localState) => {
    const page = await openSettings({ mode });
    const doc = page.document;
    const serverGroup = stateOf(doc.getElementById("server-group"));
    const consoleGroup = stateOf(doc.getElementById("console-group"));
    const localGroup = stateOf(doc.getElementById("local-group"));

    expect(serverGroup).toEqual(serverState);
    expect(consoleGroup).toEqual(consoleState);
    expect(localGroup).toEqual(localState);
  });

  // Failure: picking a mode radio leaves the previous mode's fields on screen until the window is reopened.
  it("updates the visible fields when the mode radio changes, without reading settings again", async () => {
    const page = await openSettings({ mode: "both" });
    const doc = page.document;

    doc.getElementById("mode-local").click();

    const serverGroup = stateOf(doc.getElementById("server-group"));
    const consoleGroup = stateOf(doc.getElementById("console-group"));
    const localGroup = stateOf(doc.getElementById("local-group"));
    expect(serverGroup).toEqual(["gone", "hidden"]);
    expect(consoleGroup).toEqual(["gone", "hidden"]);
    expect(localGroup).toEqual([]);
    expect(page.api.getSettings).toHaveBeenCalledTimes(1);
  });
});

describe("initial values", () => {
  // Failure: the form opens with defaults instead of the saved URLs, mode and quit behaviour, so Save writes the defaults back.
  it("fills the URLs, quit behaviour and mode from the saved settings", async () => {
    const page = await openSettings({
      mode: "server",
      serverUrl: "https://turnstone.example.test",
      consoleUrl: "http://console.example.test:9000",
      quitBehavior: "keep",
    });
    const doc = page.document;

    expect(doc.getElementById("server-url").value).toBe("https://turnstone.example.test");
    expect(doc.getElementById("console-url").value).toBe("http://console.example.test:9000");
    expect(doc.getElementById("quit-behavior").value).toBe("keep");
    expect(doc.querySelector('input[name="mode"]:checked').id).toBe("mode-server");
  });

  // Failure: a settings file with no mode leaves no radio checked, so the mode selector shows nothing selected.
  it("selects the Both mode when the saved settings carry no mode", async () => {
    const page = await openSettings({ mode: undefined });

    expect(page.document.querySelector('input[name="mode"]:checked').id).toBe("mode-both");
  });

  // Failure: the user cannot tell why the form is empty, so they assume their saved URLs are gone and re-enter them, or Save overwrites them with blanks.
  it("shows the read error when getSettings rejects", async () => {
    const bridge = createFakeBridge();
    bridge.api.getSettings.mockRejectedValueOnce(new Error("disk gone"));
    const page = loadPage("settings", { api: bridge.api, hub: bridge.hub });

    await vi.waitFor(() => {
      expect(page.document.getElementById("save-error").classList.contains("visible")).toBe(true);
    });
    expect(page.document.getElementById("save-error").textContent).toBe("Could not read settings: disk gone");
  });
});

describe("save payload per mode", () => {
  // Failure: Save sends a URL the mode does not use with the wrong value, or sends the URLs of a mode the user did not pick.
  // Hidden fields are sent as typed (trimmed, trailing slashes removed) but never validated; main
  // stores only the URLs the mode uses.
  it.each([
    [
      "server",
      { server: "http://server.example.test:8080/", console: "not a url", quit: "keep" },
      { mode: "server", serverUrl: SERVER, consoleUrl: "not a url", quitBehavior: "keep" },
    ],
    [
      "console",
      { server: "  also not a url  ", console: "http://console.example.test:9000/", quit: "stop" },
      { mode: "console", serverUrl: "also not a url", consoleUrl: "http://console.example.test:9000", quitBehavior: "stop" },
    ],
    [
      "both",
      { server: "  http://server.example.test:8080//  ", console: "http://console.example.test:8090/", quit: "stop" },
      { mode: "both", serverUrl: SERVER, consoleUrl: CONSOLE, quitBehavior: "stop" },
    ],
    [
      "local",
      { server: "not a url", console: "not a url", quit: "keep" },
      { mode: "local", serverUrl: "not a url", consoleUrl: "not a url", quitBehavior: "keep" },
    ],
  ])("mode %s sends the expected payload", async (mode, input, payload) => {
    const page = await openSettings({ mode });
    setValue(page, "server-url", input.server);
    setValue(page, "console-url", input.console);
    page.document.getElementById("quit-behavior").value = input.quit;

    page.document.getElementById("btn-save").click();

    expect(page.api.saveSettings).toHaveBeenCalledTimes(1);
    expect(page.api.saveSettings).toHaveBeenCalledWith(payload);
  });

  // Failure: a valid https address is refused, so a server behind TLS cannot be saved, or the trailing slash is kept in the stored address.
  it("accepts https URLs and saves them without trailing slashes", async () => {
    const page = await openSettings({ mode: "both" });
    setValue(page, "server-url", "https://turnstone.example.test/");
    setValue(page, "console-url", "https://console.example.test:9443");

    page.document.getElementById("btn-save").click();

    expect(page.api.saveSettings).toHaveBeenCalledWith({
      mode: "both",
      serverUrl: "https://turnstone.example.test",
      consoleUrl: "https://console.example.test:9443",
      quitBehavior: "stop",
    });
  });
});

describe("validation", () => {
  // Failure: an invalid URL in a mode that uses it reaches the main process, and the user sees no reason in the form.
  it("blocks the save and marks the field when a used URL is not http or https", async () => {
    const page = await openSettings({ mode: "server" });
    setValue(page, "server-url", "localhost:8080");

    page.document.getElementById("btn-save").click();

    expect(page.api.saveSettings).not.toHaveBeenCalled();
    expect(page.document.getElementById("server-url").classList.contains("invalid")).toBe(true);
    expect(page.document.getElementById("server-url-error").classList.contains("visible")).toBe(true);
    expect(page.closeCalls()).toBe(0);
  });

  // Failure: a URL made only of spaces passes the check and Save sends an empty server address.
  it("rejects a URL that is only whitespace", async () => {
    const page = await openSettings({ mode: "server" });
    setValue(page, "server-url", "   ");

    page.document.getElementById("btn-save").click();

    expect(page.api.saveSettings).not.toHaveBeenCalled();
    expect(page.document.getElementById("server-url").classList.contains("invalid")).toBe(true);
  });

  // Failure: a field the mode hides is validated, so a console-only user is blocked by a server URL they cannot see.
  it("never validates a field the mode hides", async () => {
    const page = await openSettings({ mode: "console" });
    setValue(page, "server-url", "ftp://nope.example.test");

    page.document.getElementById("btn-save").click();

    expect(page.api.saveSettings).toHaveBeenCalledTimes(1);
    expect(page.document.getElementById("server-url").classList.contains("invalid")).toBe(false);
    expect(page.document.getElementById("server-url-error").classList.contains("visible")).toBe(false);
  });

  // Failure: a blank console URL in Both mode saves anyway, or the valid server field is marked too.
  it("marks only the invalid field in Both mode", async () => {
    const page = await openSettings({ mode: "both" });
    setValue(page, "console-url", "");

    page.document.getElementById("btn-save").click();

    expect(page.api.saveSettings).not.toHaveBeenCalled();
    expect(page.document.getElementById("console-url").classList.contains("invalid")).toBe(true);
    expect(page.document.getElementById("console-url-error").classList.contains("visible")).toBe(true);
    expect(page.document.getElementById("server-url").classList.contains("invalid")).toBe(false);
  });

  // Failure: in Both mode an invalid URL in either field is saved, or the field that is valid is marked as invalid.
  it.each([
    // server URL, console URL, server marked, console marked
    ["nope", CONSOLE, true, false],
    [SERVER, "nope", false, true],
    ["nope", "nope", true, true],
  ])("Both mode with server %s and console %s marks server %j and console %j", async (server, console, serverMarked, consoleMarked) => {
    const page = await openSettings({ mode: "both" });
    setValue(page, "server-url", server);
    setValue(page, "console-url", console);

    page.document.getElementById("btn-save").click();

    const doc = page.document;
    const serverInvalid = doc.getElementById("server-url").classList.contains("invalid");
    const consoleInvalid = doc.getElementById("console-url").classList.contains("invalid");
    const serverError = doc.getElementById("server-url-error");
    const consoleError = doc.getElementById("console-url-error");
    expect(page.api.saveSettings).not.toHaveBeenCalled();
    expect(serverInvalid).toBe(serverMarked);
    expect(consoleInvalid).toBe(consoleMarked);
    expect(serverError.classList.contains("visible")).toBe(serverMarked);
    expect(consoleError.classList.contains("visible")).toBe(consoleMarked);
    expect(serverError.textContent).toBe(URL_ERROR);
    expect(consoleError.textContent).toBe(URL_ERROR);
  });

  // Failure: the field keeps its red error after the user starts correcting it.
  it("clears the field error when the user types in the field", async () => {
    const page = await openSettings({ mode: "server" });
    setValue(page, "server-url", "nope");
    page.document.getElementById("btn-save").click();

    page.document.getElementById("server-url").dispatchEvent(new page.window.Event("input", { bubbles: true }));

    expect(page.document.getElementById("server-url").classList.contains("invalid")).toBe(false);
    expect(page.document.getElementById("server-url-error").classList.contains("visible")).toBe(false);
  });

  // Failure: main refuses a save and the reason is dropped, leaving the window open with no message.
  it("shows the main process's refusal and re-enables Save", async () => {
    const page = await openSettings({ mode: "server" });
    page.api.saveSettings.mockResolvedValueOnce({ error: "Invalid Server URL — must be http:// or https://" });

    page.document.getElementById("btn-save").click();

    await vi.waitFor(() => {
      expect(page.document.getElementById("save-error").classList.contains("visible")).toBe(true);
    });
    expect(page.document.getElementById("save-error").textContent).toBe("Invalid Server URL — must be http:// or https://");
    expect(page.document.getElementById("btn-save").disabled).toBe(false);
    expect(page.document.getElementById("btn-save").textContent).toBe("Save");
    expect(page.closeCalls()).toBe(0);
  });

  // Failure: a save that fails over IPC leaves Save disabled, so the user cannot retry.
  // No message is shown for this case today: the catch only re-enables Save, so the user
  // gets no reason. The last assertion pins that. A message added later changes it, on purpose.
  it("re-enables Save when the save call itself throws", async () => {
    const page = await openSettings({ mode: "server" });
    page.api.saveSettings.mockRejectedValueOnce(new Error("ipc gone"));

    page.document.getElementById("btn-save").click();

    await vi.waitFor(() => {
      expect(page.document.getElementById("btn-save").disabled).toBe(false);
    });
    expect(page.document.getElementById("btn-save").textContent).toBe("Save");
    expect(page.closeCalls()).toBe(0);
    expect(page.document.getElementById("save-error").classList.contains("visible")).toBe(false);
  });

  // Failure: a successful save leaves the dialog open, so the user does not see the change take effect.
  it("closes the window after a successful save", async () => {
    const page = await openSettings({ mode: "server" });

    page.document.getElementById("btn-save").click();

    await vi.waitFor(() => {
      expect(page.closeCalls()).toBe(1);
    });
  });

  // Failure: a second click while the first save is in flight sends the save twice.
  it("disables Save and shows Saving while the save is in flight", async () => {
    const page = await openSettings({ mode: "server" });
    page.api.saveSettings.mockImplementationOnce(() => new Promise(() => {}));
    const saveBtn = page.document.getElementById("btn-save");

    saveBtn.click();
    saveBtn.click();

    expect(saveBtn.disabled).toBe(true);
    expect(saveBtn.textContent).toBe("Saving…");
    expect(page.api.saveSettings).toHaveBeenCalledTimes(1);
  });
});

describe("closing and keyboard", () => {
  // Failure: Cancel saves, or does not close, so the user's edits are written when they meant to discard them.
  it("Cancel closes the window and saves nothing", async () => {
    const page = await openSettings({ mode: "server" });
    setValue(page, "server-url", "http://changed.example.test");

    page.document.getElementById("btn-cancel").click();

    expect(page.closeCalls()).toBe(1);
    expect(page.api.saveSettings).not.toHaveBeenCalled();
  });

  // Failure: Escape does nothing, so keyboard users have no way out of the dialog except Tab to Cancel.
  it("Escape closes the window without saving, from the page or from a text field", async () => {
    const page = await openSettings({ mode: "server" });

    press(page, page.document, "Escape");
    press(page, page.document.getElementById("server-url"), "Escape");

    expect(page.closeCalls()).toBe(2);
    expect(page.api.saveSettings).not.toHaveBeenCalled();
  });

  // Failure: pressing Enter in a URL field does not save, so the keyboard path to Save is broken.
  it("Enter in a text field saves", async () => {
    const page = await openSettings({ mode: "server" });
    const input = page.document.getElementById("server-url");
    input.focus();

    press(page, input, "Enter");

    expect(page.api.saveSettings).toHaveBeenCalledTimes(1);
  });

  // Failure: Enter on a mode radio or the quit select saves the form, so changing the mode with the keyboard saves too early.
  it.each([["mode-console"], ["quit-behavior"]])("Enter on %s does not save", async (id) => {
    const page = await openSettings({ mode: "server" });
    const control = page.document.getElementById(id);
    control.focus();

    press(page, control, "Enter");

    expect(page.api.saveSettings).not.toHaveBeenCalled();
  });
});

describe("window resizing", () => {
  // Failure: the window is not resized when the content changes height, so Save and Cancel are pushed off the bottom.
  // The observer's callback is fired by the test rather than on observe(), so the sequence below is only the heights
  // the test triggers. See the ResizeObserver stub in load-page.js for why.
  it("observes the settings box and reports its height plus the 32px body padding, each time it changes", async () => {
    const page = await openSettings({ mode: "both" });
    const box = page.document.querySelector(".settings-box");
    expect(page.resizeObservers).toHaveLength(1);
    expect(page.resizeObservers[0].targets[0]).toBe(box);

    box.getBoundingClientRect = () => ({ height: 300.4 });
    page.triggerResize();
    box.getBoundingClientRect = () => ({ height: 420 });
    page.triggerResize();

    expect(page.api.resizeSettings.mock.calls).toEqual([[333], [452]]);
  });
});

describe("theme", () => {
  // Failure: the dialog keeps the dark palette under a light system theme, so the text is unreadable on the light background.
  it("applies the light theme when the system prefers light", async () => {
    const page = await openSettings({ mode: "both" }, { prefersLight: true });

    expect(page.document.documentElement.dataset.theme).toBe("light");
  });

  // Failure: the dialog takes the light palette under a dark system theme.
  it("applies no light theme when the system prefers dark", async () => {
    const page = await openSettings({ mode: "both" }, { prefersLight: false });

    expect(page.document.documentElement.dataset.theme).toBe("");
  });

  // Failure: the dialog keeps the theme it loaded with after the system theme changes, so it stays on the old palette until it is reopened.
  it("follows a change event when the system theme switches while the page is open", async () => {
    const page = await openSettings({ mode: "both" }, { prefersLight: false });

    page.setPrefersLight(true);
    const afterLight = page.document.documentElement.dataset.theme;
    page.setPrefersLight(false);
    const afterDark = page.document.documentElement.dataset.theme;

    expect(afterLight).toBe("light");
    expect(afterDark).toBe("");
  });
});
