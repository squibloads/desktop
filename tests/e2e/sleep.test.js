import { afterEach, describe, expect, it } from "vitest";
import { createFakeConsole } from "../helpers/fake-console.js";
import { closeEverything, launchApp, registerConsole } from "../helpers/launch-app.js";
import { pollUntil } from "../helpers/poll.js";

afterEach(closeEverything);

// The app polls /health every 5 seconds (health.js). A sleep stops that, and a wake checks at once.
const HEALTH_INTERVAL_MS = 5000;

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sleep and wake", () => {
  // Failure: main.js never reaches the pollers on a suspend or a resume, so the checks run on through the sleep and
  // the first one after the wake waits out the interval.
  it("stops the health checks on suspend, and checks at once on resume", async () => {
    const fake = registerConsole(createFakeConsole({ nodes: 1 }));
    await fake.start();
    const app = await launchApp({ settings: { mode: "console", consoleUrl: fake.url } });
    await pollUntil(() => fake.healthHits >= 1, { description: "the first health check" });

    await app.mainEvaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
    // A check already sent when the suspend arrived is let through before the count is taken.
    await sleepFor(500);
    const asleep = fake.healthHits;
    await sleepFor(HEALTH_INTERVAL_MS + 1500);
    expect(fake.healthHits).toBe(asleep);

    await app.mainEvaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    // Well under one interval, so only the check the resume runs can count.
    await pollUntil(() => fake.healthHits > asleep, {
      description: "a health check right after the resume",
      timeoutMs: HEALTH_INTERVAL_MS - 2000,
    });
  });
});
