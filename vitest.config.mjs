// Test configuration.
//
// Each tier is one Vitest project. Tier globs are declared once in `tierGlobs`
// and the projects are built from that map, so tests/contract/test-layout.test.js
// can check that every tests/<tier> directory is covered.
//
// Every project runs in Node. The renderer tier builds its own jsdom window per
// page (tests/helpers/load-page.js), so it needs no Vitest DOM environment. The
// e2e tier launches Electron, so its project exists only when TURNSTONE_E2E=1.

import os from "node:os";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { OrderedRandomSequencer } from "./tests/helpers/ordered-random-sequencer.mjs";

export const tierGlobs = {
  unit: "tests/unit/**/*.test.js",
  contract: "tests/contract/**/*.test.js",
  renderer: "tests/renderer/**/*.test.js",
  e2e: "tests/e2e/**/*.test.js",
};

// Each e2e test launches Electron. The test timeout leaves room for chained 30 s waits; the hook
// timeout covers the launch and the quit (the quit guard is 25 s). At most
// three apps at once so a runner is not starved of CPU and memory.
function e2eOverrides(maxWorkers) {
  return {
    testTimeout: 120_000,
    hookTimeout: 60_000,
    maxWorkers: Math.min(maxWorkers, 3),
    setupFiles: [fileURLToPath(new URL("./tests/helpers/e2e-setup.js", import.meta.url))],
  };
}

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
    // The smoke-tier overrides are cleared so an exported value in the developer's shell cannot
    // change a result. The empty string counts as unset in runtime-config.js.
    env: { TURNSTONE_PODMAN: "", TURNSTONE_LOCAL_CONSOLE_URL: "" },
    passWithNoTests: false,
    // Vitest's own RandomSequencer orders files by project discovery timing, so
    // a replayed seed could run files in a different order. The repo sequencer
    // sorts first and only then shuffles.
    sequence: shuffle
      ? { shuffle: { files: true, tests: true }, seed, sequencer: OrderedRandomSequencer }
      : {},
  };

  // The e2e project opens real windows, so it is built only when the run asks for it. Without the
  // gate, a plain `npx vitest run` would launch Electron.
  const e2eEnabled = env.TURNSTONE_E2E === "1";
  const projects = Object.entries(tierGlobs)
    .filter(([name]) => name !== "e2e" || e2eEnabled)
    .map(([name, include]) => ({
      test: {
        ...shared,
        name,
        include: [include],
        ...(name === "e2e" ? e2eOverrides(maxWorkers) : {}),
      },
    }));

  return {
    test: {
      ...shared,
      projects,
    },
  };
});
