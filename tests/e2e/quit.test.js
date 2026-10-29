import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeAllApps, launchApp, urlIs } from "../helpers/launch-app.js";

const POD_INSPECT = "--connection turnstone pod inspect turnstone --format {{.State}}";
const POD_STOP = "--connection turnstone pod stop turnstone";

const consoles = [];

afterEach(async () => {
  await closeAllApps();
  await Promise.all(consoles.splice(0).map((fake) => fake.stop()));
});

// app.close() runs app.quit() in the main process, so the app's own before-quit stop is what
// runs here. The stop is the only pod call that can come after the console has loaded.
describe("quit", () => {
  // Failure: quitting leaves the local pod running, so the pod keeps using the machine after the user closed Turnstone.
  it("stops the pod when the app quits, by default", async () => {
    const fake = createFakeConsole({ nodes: 1 });
    consoles.push(fake);
    await fake.start();
    const app = await launchApp({ settings: { mode: "local" }, consolePort: fake.port });
    await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });

    await app.close();

    expect(app.readPodmanLog()).toContain(POD_STOP);
  });

  // Failure: a user who chose Keep Turnstone running finds the pod stopped anyway when they close the app.
  it("leaves the pod running when quitBehavior is keep", async () => {
    const fake = createFakeConsole({ nodes: 1 });
    consoles.push(fake);
    await fake.start();
    const app = await launchApp({
      settings: { mode: "local", quitBehavior: "keep" },
      consolePort: fake.port,
    });
    await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });

    await app.close();

    // The inspect line shows the session did manage the pod, so the missing stop is the setting at work.
    expect(app.readPodmanLog()).toContain(POD_INSPECT);
    expect(app.readPodmanLog()).not.toContain(POD_STOP);
  });
});
