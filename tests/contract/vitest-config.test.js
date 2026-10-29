import { describe, it, expect, vi } from "vitest";
import config from "../../vitest.config.mjs";

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
