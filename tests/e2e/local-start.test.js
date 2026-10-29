import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { pollUntil, waitForTitle } from "../helpers/poll.js";

// The podman calls local-runtime.js makes, in the form fake-podman.js logs them.
const MACHINE_LIST = "machine list --format json";
const MACHINE_START = "machine start turnstone";
const POD_INSPECT = "--connection turnstone pod inspect turnstone --format {{.State}}";
const POD_START = "--connection turnstone pod start turnstone";

// The text local-loading.js shows for the node stage (STAGE_LABELS).
const NODE_STAGE_LABEL = "Waiting for the node to come online (this can take about a minute)";

function startConsole(options) {
  return registerConsole(createFakeConsole(options));
}

afterEach(closeEverything);

describe("local start", () => {
  // Failure: a machine and pod that are already running get restarted on every launch, so the pod bounces and the user waits for nothing.
  it("opens the console and changes nothing when the machine and pod are already running", async () => {
    const fake = startConsole({ nodes: 1 });
    await fake.start();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "Running" },
      consolePort: fake.port,
    });

    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });
    await waitForTitle(page, "fake console");
    const errorWindows = app.windowUrls().filter((url) => url.split("?")[0].endsWith("error.html"));
    expect(errorWindows).toEqual([]);
    expect(app.readPodmanLog()).toEqual([MACHINE_LIST, POD_INSPECT]);
  });

  // Failure: a stopped machine or pod is left stopped, and the user is shown a console that never answers.
  it("starts a stopped machine, then a stopped pod, before the console opens", async () => {
    const fake = startConsole({ nodes: 1 });
    await fake.start();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "stopped", pod: "Exited" },
      consolePort: fake.port,
    });

    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });
    await waitForTitle(page, "fake console");
    expect(app.readPodmanLog()).toEqual([MACHINE_LIST, MACHINE_START, POD_INSPECT, POD_START]);
  });

  // Failure: the console opens while no node is registered, so the user lands on a console that cannot run a session.
  it("keeps the loading page up until a node registers, then opens the console", async () => {
    const fake = startConsole({ nodes: 0 });
    await fake.start();
    const app = await launchApp({ settings: { mode: "local" }, consolePort: fake.port });

    const loading = await app.findPage(urlEndsWith("local-loading.html"), { description: "loading page" });
    // Three health reads with no node: the start has checked the node more than once, not just the console.
    await pollUntil(() => fake.healthHits >= 3, { description: "three health reads" });
    expect(app.windowUrls()).not.toContain(`${fake.url}/`);
    await pollUntil(
      () => loading.evaluate((label) => document.getElementById("status").textContent === label, NODE_STAGE_LABEL),
      { description: "the node stage on the loading page" },
    );

    fake.setNodes(1);
    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page after the node registers" });
    await waitForTitle(page, "fake console");
  });
});
