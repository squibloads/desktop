import { describe, it, expect, vi } from "vitest";
import config from "../../vitest.config.mjs";
import { OrderedRandomSequencer } from "../helpers/ordered-random-sequencer.mjs";

// A seed that is silently ignored makes a replay run in a different order from
// the one the operator asked for, so the config must refuse it.
describe("vitest.config.mjs seed handling", () => {
  it("rejects VITEST_SEED when VITEST_SHUFFLE is not 1", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "42");
    expect(() => config()).toThrow("VITEST_SEED requires VITEST_SHUFFLE=1");
  });

  it("accepts an empty VITEST_SEED when shuffle is off", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "");
    expect(() => config()).not.toThrow();
  });
});

// Vitest's default sequencer orders files by project discovery timing, so a
// fixed seed would not replay the same file order. The repo sequencer is used
// on every project when shuffling, and the default is left alone otherwise.
describe("vitest.config.mjs sequencer", () => {
  it("uses the ordered sequencer on the root and every project when shuffling", () => {
    // config() prints the seed line when shuffling; keep it out of the test output.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("VITEST_SHUFFLE", "1");
    vi.stubEnv("VITEST_SEED", "123");
    const { test } = config();
    expect(test.sequence.sequencer).toBe(OrderedRandomSequencer);
    expect(test.projects.length).toBeGreaterThan(0);
    expect(test.projects.every((p) => p.test.sequence.sequencer === OrderedRandomSequencer)).toBe(true);
  });

  it("leaves the default sequencer in place when not shuffling", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "");
    const { test } = config();
    expect(test.sequence.sequencer).toBeUndefined();
  });
});
