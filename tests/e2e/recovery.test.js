import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeAllApps, launchApp, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { pollUntil, waitForTitle } from "../helpers/poll.js";

const POD_START = "--connection turnstone pod start turnstone";

const consoles = [];

function startConsole() {
  const fake = createFakeConsole({ nodes: 1 });
  consoles.push(fake);
  return fake;
}

// The shell's health dot for the console. shell.js sets the state as a class on this element.
function consoleDotHas(shell, state) {
  return () => shell.evaluate((cls) => document.getElementById("console-health").classList.contains(cls), state);
}

afterEach(async () => {
  await closeAllApps();
  await Promise.all(consoles.splice(0).map((fake) => fake.stop()));
});

describe("recovery", () => {
  // Failure: after the console goes down and comes back, the console view stays on a dead page, and the user has to reload by hand.
  it("shows the console health dot as disconnected, then reloads the console view when it returns", async () => {
    const fake = startConsole();
    await fake.start();
    const app = await launchApp({ settings: { mode: "local" }, consolePort: fake.port });
    const shell = await app.findPage(urlEndsWith("shell.html"), { description: "shell window" });
    const consolePage = await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });

    await fake.stop();
    await pollUntil(consoleDotHas(shell, "disconnected"), { description: "console dot to read disconnected" });
    // Marked after the dot changed, so the only reload that can clear the marker is the recovery.
    await consolePage.evaluate(() => {
      window.__beforeRecovery = true;
    });

    await fake.restartOnSamePort();
    await pollUntil(() => consolePage.evaluate(() => window.__beforeRecovery === undefined), {
      description: "the console view to reload",
    });
    await waitForTitle(consolePage, "fake console");
  });

  // Failure: Reload with the console down and the pod stopped does nothing useful, so the user cannot bring Turnstone back without quitting the app.
  it("restarts a stopped pod when Reload is used while the console is down", async () => {
    const fake = startConsole();
    await fake.start();
    const app = await launchApp({ settings: { mode: "local" }, consolePort: fake.port });
    const shell = await app.findPage(urlEndsWith("shell.html"), { description: "shell window" });
    await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });

    await app.setPodmanState({ pod: "Exited" });
    await fake.stop();
    await pollUntil(consoleDotHas(shell, "disconnected"), { description: "console dot to read disconnected" });

    await app.clickMenuItem("Reload");
    await pollUntil(() => app.readPodmanLog().includes(POD_START), { description: "a pod start after Reload" });
    expect(app.readPodmanLog().filter((line) => line === POD_START)).toEqual([POD_START]);
    // The loading page takes the view while the start runs; the old console page is gone.
    await app.findPage(urlEndsWith("local-loading.html"), { description: "loading page during the restart" });

    await fake.restartOnSamePort();
    const page = await app.findPage(urlIs(`${fake.url}/`), { description: "console page after the console returns" });
    await waitForTitle(page, "fake console");
  });
});
