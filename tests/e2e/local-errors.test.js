import { afterEach, describe, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeAllApps, launchApp, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { waitForText, waitForTitle } from "../helpers/poll.js";

const consoles = [];

// Starts a console to learn a free port, then stops it. The console stays down until a
// test starts it again, so the health poller never sees it come up during the error.
async function reservedConsole() {
  const fake = createFakeConsole({ nodes: 1 });
  consoles.push(fake);
  await fake.start();
  const port = fake.port;
  await fake.stop();
  return { fake, port };
}

afterEach(async () => {
  await closeAllApps();
  await Promise.all(consoles.splice(0).map((fake) => fake.stop()));
});

describe("local start errors", () => {
  // Failure: a machine that does not exist shows a generic "unable to connect" page, and the user cannot tell that Podman needs the machine created.
  it("shows MACHINE_MISSING, and Retry starts Turnstone once the machine exists", async () => {
    const { fake, port } = await reservedConsole();
    const app = await launchApp({
      settings: { mode: "local" },
      podmanState: { machine: "missing" },
      consolePort: port,
    });

    const errorPage = await app.findPage(urlEndsWith("local-error.html"), { description: "local error page" });
    await waitForText(errorPage, "#error-title", "MACHINE_MISSING");
    await waitForText(
      errorPage,
      "#error-message",
      "The Turnstone Podman machine does not exist. Create it, then reopen Turnstone.",
    );

    // The machine is fixed and Retry is clicked while the console is still down, so the
    // start owns the console view before the console comes up.
    await app.setPodmanState({ machine: "running" });
    await errorPage.click("#btn-retry");
    await fake.start(port);

    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page after Retry" });
    await waitForTitle(page, "fake console");
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
