import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith } from "../helpers/launch-app.js";
import { waitForText } from "../helpers/poll.js";

afterEach(closeEverything);

// A stopped console gives the error page in the console view: a file page that holds the bridge.
async function openErrorPageInConsoleView() {
  const fake = registerConsole(createFakeConsole({ nodes: 1, health: "ok" }));
  await fake.start();
  const address = fake.url;
  await fake.stop();

  const app = await launchApp({ settings: { mode: "console", consoleUrl: address } });
  const errorPage = await app.findPage(urlEndsWith("error.html"), { description: "error page in the console view" });
  await waitForText(errorPage, "#error-url", address);
  return { app, errorPage };
}

describe("bridge calls from pages that hold the bridge", () => {
  // Failure: the error page in the console view changes or reads settings, so a page the app did not make for those calls reaches the handlers.
  it("refuses settings calls from the error page in a view, and the shell still reads settings", async () => {
    const { app, errorPage } = await openErrorPageInConsoleView();

    const fromErrorPage = await errorPage.evaluate(async () => {
      const outcome = {};
      try {
        await window.electronAPI.saveSettings({ mode: "console", consoleUrl: "http://127.0.0.1:9" });
        outcome.save = "accepted";
      } catch (err) {
        outcome.save = err.message;
      }
      try {
        await window.electronAPI.getSettings();
        outcome.get = "accepted";
      } catch (err) {
        outcome.get = err.message;
      }
      return outcome;
    });
    expect(fromErrorPage.save).toContain("Refused");
    expect(fromErrorPage.get).toContain("Refused");

    // Window controls belong to the shell. A close from the error page must not close the window.
    await errorPage.evaluate(() => window.electronAPI.windowClose());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await app.windowCount()).toBe(1);

    const shell = await app.findPage(urlEndsWith("shell.html"), { description: "shell" });
    const mode = await shell.evaluate(async () => (await window.electronAPI.getSettings()).mode);
    expect(mode).toBe("console");

    // The same close from the shell does close the window, so the channel itself is wired.
    await shell.evaluate(() => window.electronAPI.windowClose());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await app.windowCount()).toBe(0);
  });

  // Failure: the error page's Settings button is refused, so a stopped console's address cannot be fixed from the page that reports it.
  it("lets the error page's Settings button open Settings", async () => {
    const { app, errorPage } = await openErrorPageInConsoleView();

    await errorPage.click("#btn-settings");
    await app.findPage(urlEndsWith("settings.html"), { description: "settings window" });
  });
});
