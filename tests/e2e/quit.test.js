import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole, urlIs } from "../helpers/launch-app.js";

const POD_INSPECT = "--connection turnstone pod inspect turnstone --format {{.State}}";
const POD_STOP = "--connection turnstone pod stop turnstone";
// Written by fake-podman.js once a stop has finished, after its delay.
const POD_STOP_DONE = "pod stop done";
// Long enough that an app which exits without waiting for the stop misses the completion line.
const POD_STOP_DELAY_MS = "1500";

afterEach(closeEverything);

// app.close() runs app.quit() in the main process, so the app's own before-quit stop is what
// runs here. The stop is the only pod call that can come after the console has loaded.
describe("quit", () => {
  // Failure: quitting leaves the local pod running, so the pod keeps using the machine after the user closed Turnstone.
  it("stops the pod when the app quits, by default", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({ settings: { mode: "local" }, consolePort: fake.port });
    await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });

    await app.close();

    expect(app.readPodmanLog()).toContain(POD_STOP);
  });

  // Failure: the app exits while the pod is still stopping, so the pod is left running after the user closed Turnstone.
  it("waits for the pod stop to finish before the app exits", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({
      settings: { mode: "local" },
      consolePort: fake.port,
      env: { FAKE_PODMAN_STOP_DELAY_MS: POD_STOP_DELAY_MS },
    });
    await app.findPage(urlIs(`${fake.url}/`), { description: "console page" });

    await app.close();

    expect(app.readPodmanLog()).toContain(POD_STOP);
    expect(app.readPodmanLog()).toContain(POD_STOP_DONE);
  });

  // Failure: a user who chose Keep Turnstone running finds the pod stopped anyway when they close the app.
  it("leaves the pod running when quitBehavior is keep", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
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
