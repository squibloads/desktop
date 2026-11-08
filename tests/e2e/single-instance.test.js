import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlIs } from "../helpers/launch-app.js";
import { pollUntil } from "../helpers/poll.js";

afterEach(closeEverything);

// Electron starts in a few seconds here, and a copy that loses the lock exits before it builds a window. The bound is
// a deadline for the exit, not a measurement of it.
const EXIT_WITHIN_MS = 20_000;

function withDeadline(promise, ms, description) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} did not happen within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("one copy at a time", () => {
  // Failure: a second launch runs its own Local start against the same machine and pod, and quitting either copy
  // stops the pod under the other.
  it("a second launch exits without touching the pod, and the first copy keeps its console", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({ settings: { mode: "local" }, consolePort: fake.port });
    await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });
    const podmanBefore = app.readPodmanLog();

    const second = app.spawnSecondInstance();
    const { code } = await withDeadline(second.exited, EXIT_WITHIN_MS, "the second copy's exit");

    expect(code, second.output()).toBe(0);
    // No call at all: the second copy never inspected, started or stopped anything.
    expect(app.readPodmanLog()).toEqual(podmanBefore);
    expect(await app.windowCount()).toBe(1);
    expect(app.windowUrls()).toContain(`${fake.url}/`);
  });

  // Failure: the second launch exits but the first window stays hidden in the tray, so the double-click looks like it
  // did nothing.
  it("brings a hidden first window back", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({ settings: { mode: "console", consoleUrl: fake.url } });
    const visible = () => app.mainEvaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
    // The window starts hidden and shows itself once the shell has painted (main.js). A hide before that first show
    // would be undone by it, and this test would pass with no handler at all.
    await pollUntil(visible, { description: "the first window shown at startup" });
    await app.mainEvaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    expect(await visible()).toBe(false);

    const second = app.spawnSecondInstance();
    await withDeadline(second.exited, EXIT_WITHIN_MS, "the second copy's exit");

    await pollUntil(visible, { description: "the first window shown again" });
  });

  // Control for the two tests above: the lock belongs to one user-data directory. A copy with a directory of its own
  // keeps running, so an exit above comes from the lock, not from a copy that cannot start at all.
  it("lets a copy with its own user-data directory run alongside", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({ settings: { mode: "console", consoleUrl: fake.url } });
    const sameDir = app.spawnSecondInstance();
    await withDeadline(sameDir.exited, EXIT_WITHIN_MS, "the same-directory copy's exit");

    const ownDir = app.spawnSecondInstance({ ownUserData: true });
    await sleepFor(8000);

    expect(ownDir.running(), ownDir.output()).toBe(true);
  });
});
