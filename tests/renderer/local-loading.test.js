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

    expect(stageStates(document)).toEqual(STARTING);
    expect(document.getElementById("status").textContent).toBe("Starting the Podman machine");
    expect(jsdomErrors).toEqual([]);
  });

  // Failure: a stage that is reported is not shown, or earlier stages are not marked done, so progress looks stuck.
  it("marks earlier stages done and the current one active as each stage arrives", () => {
    const bridge = createFakeBridge();
    const page = loadPage("local-loading", bridge);

    page.hub.emitLocalProgress("pod");
    expect(stageStates(page.document)).toEqual({ machine: "done", pod: "active", console: "pending", node: "pending" });
    expect(page.document.getElementById("status").textContent).toBe("Starting Turnstone");

    page.hub.emitLocalProgress("console");
    expect(stageStates(page.document)).toEqual({ machine: "done", pod: "done", console: "active", node: "pending" });
    expect(page.document.getElementById("status").textContent).toBe("Waiting for the console");

    page.hub.emitLocalProgress("node");
    expect(stageStates(page.document)).toEqual({ machine: "done", pod: "done", console: "done", node: "active" });
    expect(page.document.getElementById("status").textContent).toBe(
      "Waiting for the node to come online (this can take about a minute)",
    );
  });

  // Failure: a stage sent before the page's listener attaches is shown as if the page had seen it; it is lost, and the
  // page stays on the first stage until main replays the current stage once the load finishes.
  it("drops a stage sent before the page attached, and shows the replay sent after load", () => {
    const bridge = createFakeBridge();
    bridge.hub.emitLocalProgress("console");

    const page = loadPage("local-loading", bridge);
    expect(stageStates(page.document)).toEqual(STARTING);

    page.hub.emitLocalProgress("console");
    expect(stageStates(page.document)).toEqual({ machine: "done", pod: "done", console: "active", node: "pending" });
  });

  // Failure: an unknown stage name clears every stage or shows "undefined" in the status line.
  it("ignores a stage name it does not know, leaving the page as it was", () => {
    const page = loadPage("local-loading", createFakeBridge());
    page.hub.emitLocalProgress("pod");

    page.hub.emitLocalProgress("bogus");

    expect(stageStates(page.document)).toEqual({ machine: "done", pod: "active", console: "pending", node: "pending" });
    expect(page.document.getElementById("status").textContent).toBe("Starting Turnstone");
  });
});
