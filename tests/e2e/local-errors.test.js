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
// The calls that bring in the pinned image.
const PINNED = require("../../src/main/turnstone-image.js").pinnedImageRef();
const IMAGE_EXISTS = `--connection turnstone image exists ${PINNED}`;
const PULL = `--connection turnstone pull ${PINNED}`;
const IMAGE_DIGESTS = `--connection turnstone image inspect ${PINNED} --format {{json .RepoDigests}}`;
// The config script, run as root on a first run.
const CONFIG = `machine ssh --username root turnstone ${require("../../src/main/turnstone-config.js").configCommand()}`;
// The user session check and the same with one start first, run as root after the machine check.
const { sessionCommand } = require("../../src/main/user-session.js");
const SESSION = `machine ssh --username root turnstone ${sessionCommand()}`;
const SESSION_START = `machine ssh --username root turnstone ${sessionCommand({ start: true })}`;

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

  // Failure: a first run has no image for the pod, and nothing fetches the pinned one.
  it("pulls the pinned image on a first run and checks its digest, then shows POD_MISSING", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "missing", image: "missing" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    // Creating the pod is #1681; until then a first run stops here, with the image and config.toml in place.
    await waitForText(errorPage, "#error-title", "POD_MISSING");
    expect(app.readPodmanLog().slice(-4)).toEqual([IMAGE_EXISTS, PULL, IMAGE_DIGESTS, CONFIG]);
  });

  // Failure: a settings file that could not be written shows a generic error or a missing pod, and Retry never runs
  // the script again.
  it("shows CONFIG_WRITE_FAILED when the settings file cannot be written, and Retry runs the script again", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "missing", config: "failed" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "CONFIG_WRITE_FAILED");
    await waitForText(errorPage, "#error-message", "Turnstone could not create its settings file in its machine.");
    expect(app.readPodmanLog().slice(-1)).toEqual([CONFIG]);

    await app.setPodmanState({ config: "created" });
    await errorPage.click("#btn-retry");
    await waitForText(errorPage, "#error-title", "POD_MISSING");
    expect(app.readPodmanLog().filter((line) => line === CONFIG)).toEqual([CONFIG, CONFIG]);
  });

  // Failure: a machine whose user session is held by another WSL distribution shows "connect failed" at the pod, or
  // Retry after that distribution stopped never starts the session again.
  it("shows USER_SESSION_FAILED when the session will not come up, and Retry starts it again", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "missing", session: "failed", sessionStart: "fails" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "USER_SESSION_FAILED");
    await waitForText(errorPage, "#error-message", "The Turnstone machine's user session would not start, so the pod cannot run.");
    // The rest of the detail names this PC's running WSL distributions, so only its start is pinned.
    expect(await errorPage.textContent("#error-detail")).toMatch(/^user@1000\.service is failed, also after starting it again\. /);
    expect(app.readPodmanLog().slice(-2)).toEqual([SESSION, SESSION_START]);

    // The other distribution is closed, then Retry. The pod is missing, so the start goes on to stop there.
    await app.setPodmanState({ sessionStart: "ok" });
    await errorPage.click("#btn-retry");
    await waitForText(errorPage, "#error-title", "POD_MISSING");
    expect(app.readPodmanLog().filter((line) => line === SESSION_START)).toEqual([SESSION_START, SESSION_START]);
  });

  // Failure: a failed download shows a generic "unable to connect" page, and the user cannot tell the image is missing.
  it("shows IMAGE_PULL_FAILED with Podman's error when the pull fails", async () => {
    const { port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "running", pod: "missing", image: "missing", failPull: true },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "IMAGE_PULL_FAILED");
    await waitForText(errorPage, "#error-message", "The Turnstone image could not be downloaded.");
    expect(await errorPage.textContent("#error-detail")).toContain("connection reset");
    expect(app.readPodmanLog()).not.toContain(IMAGE_DIGESTS);
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
