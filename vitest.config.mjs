// Test configuration.
//
// Each tier is one Vitest project. Tier globs are declared once in `tierGlobs`
// and the projects are built from that map, so tests/contract/test-layout.test.js
// can check that every tests/<tier> directory is covered.
//
// Renderer and e2e tiers are not declared yet because tests/renderer and
// tests/e2e do not exist. When they do, add them to `tierGlobs`.

import os from "node:os";
import { randomInt } from "node:crypto";
import { defineConfig } from "vitest/config";

export const tierGlobs = {
  unit: "tests/unit/**/*.test.js",
  contract: "tests/contract/**/*.test.js",
};

// VITEST_MAX_WORKERS is validated here before Vitest reads it, so a typo fails
// the run instead of silently falling back to the default worker count.
function parseEnvInt(name, raw, min) {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

// Defaults to half the logical cores: the suite is file-parallel, and
// leaving the other half free keeps a dev machine responsive during runs.
const defaultWorkers = Math.max(1, Math.floor(os.availableParallelism() / 2));

// A function, not an object, so that importing this module has no side
// effects. The seed is generated and printed only when Vitest loads the config.
export default defineConfig(() => {
  const env = process.env;
  const maxWorkers =
    parseEnvInt("VITEST_MAX_WORKERS", env.VITEST_MAX_WORKERS, 1) ?? defaultWorkers;
  // A seed without shuffle would be silently ignored, and the run would not
  // replay the order the operator asked for. An empty value counts as unset,
  // like the other env vars.
  if (env.VITEST_SEED !== undefined && env.VITEST_SEED !== "" && env.VITEST_SHUFFLE !== "1") {
    throw new Error("VITEST_SEED requires VITEST_SHUFFLE=1");
  }
  const shuffle = env.VITEST_SHUFFLE === "1";
  const seed = shuffle
    ? (parseEnvInt("VITEST_SEED", env.VITEST_SEED, 0) ?? randomInt(2 ** 31))
    : undefined;

  if (shuffle) {
    console.log(`[vitest] shuffle on, seed ${seed} (reproduce with VITEST_SEED=${seed})`);
  }

  // Shared by every project. Inline projects do not inherit root options unless
  // `extends: true` is set, so the options are duplicated per project on purpose.
  const shared = {
    pool: "forks",
    fileParallelism: true,
    maxWorkers,
    testTimeout: 10_000,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    passWithNoTests: false,
    sequence: shuffle ? { shuffle: { files: true, tests: true }, seed } : {},
  };

  return {
    test: {
      ...shared,
      projects: Object.entries(tierGlobs).map(([name, include]) => ({
        test: { ...shared, name, include: [include] },
      })),
    },
  };
});
