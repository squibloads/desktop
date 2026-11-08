import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { pollUntil, waitForText, waitForTitle } from "../helpers/poll.js";

// The podman call Retry makes first. The health poller only reads /health and never calls podman,
// so a new line for this call after Retry can only come from a start that Retry began.
const MACHINE_LIST = "machine list --format json";
// The calls that create a missing machine, in the form fake-podman.js logs them.
const VERSION = "version --format {{.Client.Version}}";
const MACHINE_INIT = "machine init turnstone --username user";
const MACHINE_RM = "machine rm --force turnstone";

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
  // Failure: a create that fails shows a generic "unable to connect" page and leaves a half-made machine, so Retry meets
  // the broken machine instead of creating a new one.
  it("shows MACHINE_CREATE_FAILED, removes the half-made machine, and Retry creates it", async () => {
    // The console is up but reports status error. The health poller reloads a view only on status
    // ok, so the console can load only through a start that Retry began. The start polls /health
    // until it reads ok, so the status is flipped to ok only after Retry has been seen to start one.
    const fake = registerConsole(createFakeConsole({ nodes: 1, health: "error" }));
    await fake.start();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "missing", failInit: true },
      consolePort: fake.port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "MACHINE_CREATE_FAILED");
    await waitForText(errorPage, "#error-message", "The Turnstone Podman machine could not be created.");
    expect(app.readPodmanLog()).toEqual([MACHINE_LIST, VERSION, MACHINE_INIT, MACHINE_RM]);

    // The cause is gone, then Retry is clicked. A second machine list line is the start that Retry began.
    await app.setPodmanState({ failInit: false });
    await errorPage.click("#btn-retry");
    await pollUntil(() => countMachineLists(app) === 2, {
      description: "a second machine list call after Retry",
    });

    // The start is now waiting on /health, so the console loads as soon as this reads ok.
    fake.setHealth("ok");
    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page after Retry" });
    await waitForTitle(page, "fake console");
    const initCalls = app.readPodmanLog().filter((line) => line === MACHINE_INIT);
    expect(initCalls).toEqual([MACHINE_INIT, MACHINE_INIT]);
  });

  // Failure: a Podman with the fresh-machine pids cgroup bug creates a machine where no container can run.
  it("shows PODMAN_TOO_OLD with the version found, and creates nothing", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "missing", podmanVersion: "6.0.2" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "PODMAN_TOO_OLD");
    expect(await errorPage.textContent("#error-detail")).toContain("6.0.2");
    expect(app.readPodmanLog()).toEqual([MACHINE_LIST, VERSION]);
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

  // Failure: a machine whose user has passwordless sudo runs the agent anyway, and sudo mounts any drive past the
  // folder scoping (ADR-05).
  it("shows MACHINE_NOT_HARDENED with the gap, and never starts the pod, when the machine has a gap", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "Exited", hardening: "gap" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "MACHINE_NOT_HARDENED");
    await waitForText(
      errorPage,
      "#error-message",
      "The Turnstone machine's safety settings are not holding, so Turnstone was not started.",
    );
    await waitForText(errorPage, "#error-detail", "the machine user can use sudo without a password");
    expect(app.readPodmanLog()).not.toContain("--connection turnstone pod start turnstone");
  });
});
