import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith } from "../helpers/launch-app.js";
import { pollUntil } from "../helpers/poll.js";

afterEach(closeEverything);

// What each page asks to open. Only the first two are http or https.
const LINKS = ["https://example.com/a", "http://example.com/b", "javascript:void(0)", "file:///C:/Windows/win.ini", "about:blank"];

/**
 * Replaces shell.openExternal in the app's main process with a recorder, so no link reaches a real browser, and
 * returns a reader for the links it was given. The replacement is read back, and the test stops if it did not take.
 */
async function recordOpenExternal(app) {
  const installed = await app.mainEvaluate(({ shell }) => {
    globalThis.openedLinks = [];
    shell.openExternal = async (url) => {
      globalThis.openedLinks.push(url);
    };
    return shell.openExternal.toString().includes("openedLinks");
  });
  if (!installed) throw new Error("shell.openExternal could not be replaced; refusing to open real links");
  return () => app.mainEvaluate(() => globalThis.openedLinks);
}

describe("new windows from the app's pages", () => {
  // Failure: a page in a view or window, the shell included, opens a window inside the app, or a link that is not
  // http or https reaches the user's shell.
  it("are denied from every page, and only http and https links go to the browser", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1, health: "ok" }));
    await fake.start();
    const address = fake.url;
    await fake.stop();

    // A stopped address gives the error page in both views, so each view holds a page that can ask for a window.
    const app = await launchApp({ settings: { mode: "both", serverUrl: address, consoleUrl: address } });
    await app.findPage(urlEndsWith("shell.html"), { description: "shell" });
    await pollUntil(
      () =>
        app.mainEvaluate(
          ({ webContents }) =>
            webContents.getAllWebContents().filter((page) => page.getURL().split("?")[0].endsWith("error.html")).length === 2,
        ),
      { description: "the error page in both views" },
    );
    await app.clickMenuItem("Settings…");
    await app.findPage(urlEndsWith("settings.html"), { description: "settings window" });
    const opened = await recordOpenExternal(app);

    const asked = await app.mainEvaluate(
      async ({ BrowserWindow, webContents }, links) => {
        const before = BrowserWindow.getAllWindows().length;
        const pages = webContents.getAllWebContents().filter((page) => page.getURL().startsWith("file:"));
        const results = [];
        for (const page of pages) {
          const code = `${JSON.stringify(links)}.map((link) => window.open(link) === null)`;
          results.push({ page: page.getURL().split("?")[0].split("/").pop(), denied: await page.executeJavaScript(code, true) });
        }
        return { before, after: BrowserWindow.getAllWindows().length, results };
      },
      LINKS,
    );

    // The shell, the error page in each view, and Settings.
    expect(asked.results.map(({ page }) => page).sort()).toEqual(["error.html", "error.html", "settings.html", "shell.html"]);
    for (const { denied } of asked.results) expect(denied).toEqual(LINKS.map(() => true));
    expect(asked.after).toBe(asked.before);
    expect(await opened()).toEqual(asked.results.flatMap(() => ["https://example.com/a", "http://example.com/b"]));
  });
});
