import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { pollUntil } from "../helpers/poll.js";

afterEach(closeEverything);

// The stop local-runtime.js sends, in the form fake-podman.js logs it.
const POD_STOP = "--connection turnstone pod stop turnstone";
// A deadline for the app's exit, not a measurement of it.
const EXIT_WITHIN_MS = 20_000;

function withDeadline(promise, ms, description) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} did not happen within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The app's main windows: every BrowserWindow but Settings. The main window loads no page of its own.
function mainWindows(app) {
  return app.mainEvaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && !w.webContents.getURL().endsWith("settings.html"))
      .map((w) => ({ visible: w.isVisible() })),
  );
}

async function firstWindowVisible(app) {
  const [win] = await mainWindows(app);
  return Boolean(win && win.visible);
}

// Closes the main window the way the X button, Alt+F4 or the taskbar's Close does. The call can lose its connection
// when the close quits the app, which is what some tests expect.
function closeWindow(app) {
  return app
    .mainEvaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    })
    .catch(() => {});
}

function exited(app) {
  const child = app.app.process();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function startLocal(settings = {}) {
  const fake = registerConsole(createFakeConsole({ nodes: 1 }));
  await fake.start();
  const app = await launchApp({ settings: { mode: "local", ...settings }, consolePort: fake.port });
  await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });
  // The window starts hidden and shows itself once the shell has painted (main.js); a close before that is not the
  // close under test.
  await pollUntil(() => firstWindowVisible(app), { description: "the window shown at startup" });
  return app;
}

describe("closing the window", () => {
  // Failure: X quits the app and stops the pod, so opening the app again starts the pod from nothing.
  it("hides the window, keeps the app and the pod running, and a second launch brings it back", async () => {
    const app = await startLocal();
    const podmanBefore = app.readPodmanLog();

    await closeWindow(app);
    await pollUntil(async () => !(await firstWindowVisible(app)), { description: "the window hidden" });

    expect(await mainWindows(app)).toEqual([{ visible: false }]);
    expect(app.readPodmanLog()).toEqual(podmanBefore);

    const second = app.spawnSecondInstance();
    await withDeadline(second.exited, EXIT_WITHIN_MS, "the second copy's exit");
    await pollUntil(() => firstWindowVisible(app), { description: "the window shown again" });
    // Neither the hide nor the return touched the pod: no stop, and no new start.
    expect(app.readPodmanLog()).toEqual(podmanBefore);
  });

  // Failure: the one-time notice is shown on every close, or never, because the first close is not recorded.
  it("records the first close to the tray, so its notice shows once", async () => {
    const app = await startLocal();
    const settingsFile = join(app.userDataDir, "turnstone-desktop.json");
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).trayHintShown).not.toBe(true);

    await closeWindow(app);

    await pollUntil(() => JSON.parse(readFileSync(settingsFile, "utf8")).trayHintShown === true, {
      description: "trayHintShown saved",
    });
  });

  // Failure: a user who chose to quit on close is left with the app and the pod running in the tray.
  it("quits and stops the pod when Quit the app is chosen", async () => {
    const app = await startLocal({ closeBehavior: "quit" });

    await closeWindow(app);
    await withDeadline(exited(app), EXIT_WITHIN_MS, "the app's exit");

    expect(app.readPodmanLog()).toContain(POD_STOP);
  });

  // Failure: with the window hidden, Quit in the tray is cancelled by the close handler, and the app cannot be quit.
  it("still quits from the tray, and stops the pod, while the window is hidden", async () => {
    const app = await startLocal();
    await closeWindow(app);
    await pollUntil(async () => !(await firstWindowVisible(app)), { description: "the window hidden" });

    // The tray's Quit item calls app.quit() (main.js).
    app.mainEvaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
    await withDeadline(exited(app), EXIT_WITHIN_MS, "the app's exit");

    expect(app.readPodmanLog()).toContain(POD_STOP);
  });

  // Failure: a Windows shutdown or sign-out is answered with a hide, and the app holds up the shutdown.
  it("lets the window close once Windows is ending the session", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({ settings: { mode: "console", consoleUrl: fake.url } });
    await pollUntil(() => firstWindowVisible(app), { description: "the window shown at startup" });

    app
      .mainEvaluate(({ BrowserWindow }) => {
        const [win] = BrowserWindow.getAllWindows();
        win.emit("session-end");
        win.close();
      })
      .catch(() => {});

    await withDeadline(exited(app), EXIT_WITHIN_MS, "the app's exit");
  });

  // Failure: a mode change hides the old window instead of closing it, so a hidden copy of the old mode is left behind.
  it("still closes the old window when a mode change rebuilds it", async () => {
    const first = registerConsole(createFakeConsole({ nodes: 1 }));
    const second = registerConsole(createFakeConsole({ nodes: 1 }));
    await first.start();
    await second.start();
    const app = await launchApp({ settings: { mode: "console", consoleUrl: first.url } });
    await pollUntil(() => firstWindowVisible(app), { description: "the window shown at startup" });

    await app.clickMenuItem("Settings…");
    const settingsPage = await app.findPage(urlEndsWith("settings.html"), { description: "settings window" });
    const result = await settingsPage.evaluate(
      (url) => window.electronAPI.saveSettings({ mode: "server", serverUrl: url }),
      second.url,
    );
    expect(result?.error).toBeUndefined();

    await pollUntil(
      async () => {
        const windows = await mainWindows(app);
        return windows.length === 1 && windows[0].visible;
      },
      { description: "one visible main window after the rebuild" },
    );
  });
});
