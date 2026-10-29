import { describe, it, expect, afterEach } from "vitest";
import { loadPage, createFakeBridge, closeAllPages } from "../helpers/load-page.js";

afterEach(() => {
  closeAllPages();
});

// The state of each stage row: "done", "active" or "pending", read from its classes.
function stageStates(doc) {
  const states = {};
  for (const name of ["machine", "pod", "console", "node"]) {
    const el = doc.querySelector(`#stages li[data-stage="${name}"]`);
    states[name] = el.classList.contains("done")
      ? "done"
      : el.classList.contains("active")
        ? "active"
        : "pending";
  }
  return states;
}

const STARTING = { machine: "active", pod: "pending", console: "pending", node: "pending" };

describe("local loading stages", () => {
  // Failure: the page opens on a blank or wrong stage, so the user sees progress before the start has begun.
  it("starts on the Podman machine stage", () => {
    const { document, jsdomErrors } = loadPage("local-loading", createFakeBridge());

    const states = stageStates(document);
    expect(states).toEqual(STARTING);
    expect(document.getElementById("status").textContent).toBe("Starting the Podman machine");
    expect(jsdomErrors).toEqual([]);
  });

  // Failure: a stage that is reported is not shown, or earlier stages are not marked done, so progress looks stuck.
  it("marks earlier stages done and the current one active as each stage arrives", () => {
    const bridge = createFakeBridge();
    const page = loadPage("local-loading", bridge);

    page.hub.emitLocalProgress("pod");
    const afterPod = stageStates(page.document);
    expect(afterPod).toEqual({ machine: "done", pod: "active", console: "pending", node: "pending" });
    expect(page.document.getElementById("status").textContent).toBe("Starting Turnstone");

    page.hub.emitLocalProgress("console");
    const afterConsole = stageStates(page.document);
    expect(afterConsole).toEqual({ machine: "done", pod: "done", console: "active", node: "pending" });
    expect(page.document.getElementById("status").textContent).toBe("Waiting for the console");

    page.hub.emitLocalProgress("node");
    const afterNode = stageStates(page.document);
    expect(afterNode).toEqual({ machine: "done", pod: "done", console: "done", node: "active" });
    expect(page.document.getElementById("status").textContent).toBe(
      "Waiting for the node to come online (this can take about a minute)",
    );
  });

  // Failure: a stage main sends once the page has loaded (the replay that catches up a stage sent before
  // the listener attached) is not shown, so the page stays on the first stage while the start has moved on.
  it("shows the stage main sends after load, skipping the first stage", () => {
    const page = loadPage("local-loading", createFakeBridge());
    const atLoad = stageStates(page.document);
    expect(atLoad).toEqual(STARTING);

    page.hub.emitLocalProgress("console");

    const afterReplay = stageStates(page.document);
    expect(afterReplay).toEqual({ machine: "done", pod: "done", console: "active", node: "pending" });
  });

  // Failure: an unknown stage name clears every stage or shows "undefined" in the status line.
  it("ignores a stage name it does not know, leaving the page as it was", () => {
    const page = loadPage("local-loading", createFakeBridge());
    page.hub.emitLocalProgress("pod");

    page.hub.emitLocalProgress("bogus");

    const states = stageStates(page.document);
    expect(states).toEqual({ machine: "done", pod: "active", console: "pending", node: "pending" });
    expect(page.document.getElementById("status").textContent).toBe("Starting Turnstone");
  });
});

describe("theme", () => {
  // Failure: the loading page keeps the dark palette under a light system theme, so its text is hard to read on the light background.
  it("applies the light theme at load when the system prefers light", () => {
    const page = loadPage("local-loading", { ...createFakeBridge(), prefersLight: true });

    expect(page.document.documentElement.dataset.theme).toBe("light");
  });

  // Failure: the loading page takes the light palette under a dark system theme.
  it("applies no light theme at load when the system prefers dark", () => {
    const page = loadPage("local-loading", { ...createFakeBridge(), prefersLight: false });

    expect(page.document.documentElement.dataset.theme).toBe("");
  });

  // Failure: the page takes the wrong palette after a system theme switch. local-loading.js reads the theme
  // once, at load, and has no change listener, so the page keeps the theme it loaded with. This pins that
  // current behaviour. If the page starts following the system theme, change this test to expect "light".
  it("keeps the load-time theme when a change event fires, because the script has no change listener", () => {
    const page = loadPage("local-loading", { ...createFakeBridge(), prefersLight: false });

    page.setPrefersLight(true);

    expect(page.document.documentElement.dataset.theme).toBe("");
  });
});
