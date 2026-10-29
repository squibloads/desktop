import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { pollUntil, waitForText, waitForTitle } from "../helpers/poll.js";

// The podman call Retry makes first. The health poller only reads /health and never calls podman,
// so a new line for this call after Retry can only come from a start that Retry began.
const MACHINE_LIST = "machine list --format json";

// Starts a console to learn a free port, then stops it. The console stays down until a
// test starts it again, so the health poller never sees it come up during the error.
async function reservedConsole() {
  const fake = registerConsole(createFakeConsole({ nodes: 1 }));
  await fake.start();
  const port = fake.port;
  await fake.stop();
  return { fake, port };
}

function countMachineLists(app) {
  return app.readPodmanLog().filter((line) => line === MACHINE_LIST).length;
}

afterEach(closeEverything);

describe("local start errors", () => {
  // Failure: a machine that does not exist shows a generic "unable to connect" page, and the user cannot tell that Podman needs the machine created.
  it("shows MACHINE_MISSING, and Retry starts Turnstone once the machine exists", async () => {
    // The console is up but reports status error. The health poller reloads a view only on status
    // ok, so the console can load only through a start that Retry began. The start polls /health
    // until it reads ok, so the status is flipped to ok only after Retry has been seen to start one.
    const fake = registerConsole(createFakeConsole({ nodes: 1, health: "error" }));
    await fake.start();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "missing" },
      consolePort: fake.port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "MACHINE_MISSING");
    await waitForText(
      errorPage,
      "#error-message",
      "The Turnstone Podman machine does not exist. Create it, then reopen Turnstone.",
    );
    expect(countMachineLists(app)).toBe(1);

    // The machine is fixed, then Retry is clicked. A second machine list line is the start that Retry began.
    await app.setPodmanState({ machine: "running" });
    await errorPage.click("#btn-retry");
    await pollUntil(() => countMachineLists(app) === 2, {
      description: "a second machine list call after Retry",
    });

    // The start is now waiting on /health, so the console loads as soon as this reads ok.
    fake.setHealth("ok");
    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page after Retry" });
    await waitForTitle(page, "fake console");
    const listCalls = app.readPodmanLog().filter((line) => line === MACHINE_LIST);
    expect(listCalls).toEqual([MACHINE_LIST, MACHINE_LIST]);
  });

  // Failure: a missing pod shows a generic error, so the user does not learn that the pod must be created on the Turnstone connection.
  it("shows POD_MISSING when the Turnstone pod does not exist", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "missing" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "POD_MISSING");
    await waitForText(errorPage, "#error-message", "The Turnstone pod does not exist on the Podman machine.");
  });
});
