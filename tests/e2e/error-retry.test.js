import { afterEach, describe, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { waitForText, waitForTitle } from "../helpers/poll.js";

afterEach(closeEverything);

describe("console mode error retry", () => {
  // Failure: once the console is running, Retry on the error page does nothing, and the user stays on "Unable to connect" until they restart the app.
  it("loads the console from the failed address when Retry is clicked after it comes up", async () => {
    // The console reports status error, so the health poller cannot reload the view on its own.
    // Only the Retry click can load the page, which is what this test is for.
    const fake = registerConsole(createFakeConsole({ nodes: 1, health: "error" }));
    await fake.start();
    const address = fake.url;
    const port = fake.port;
    await fake.stop();

    const app = await launchApp({ settings: { mode: "console", consoleUrl: address } });
    const errorPage = await app.findPage(urlEndsWith("error.html"), { description: "error page" });
    await waitForText(errorPage, "#error-url", address);

    await fake.start(port);
    await errorPage.click("#btn-retry");

    const page = await app.findPage(urlIs(`${address}/`), { description: "console page after Retry" });
    await waitForTitle(page, "fake console");
  });
});
