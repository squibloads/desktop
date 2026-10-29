// Runs the whole suite with files and tests in random order.
//
// Node instead of `VAR=1 vitest` so the same script works in PowerShell,
// cmd and POSIX shells. The seed is generated and printed by vitest.config.mjs;
// set VITEST_SEED to replay a previous order. Extra arguments are passed to
// vitest, e.g. `npm run test:shuffle -- --project unit`.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitestEntry = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));

const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, VITEST_SHUFFLE: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
