// Runs the Electron smoke tier. TURNSTONE_E2E=1 switches the e2e project on in
// vitest.config.mjs; without it the project does not exist, so a plain `npx vitest run`
// never opens a window.
//
// Node instead of `TURNSTONE_E2E=1 vitest` so the same script works in PowerShell, cmd and
// POSIX shells. Extra arguments go to vitest, e.g.
// `node tests/helpers/run-e2e.mjs tests/e2e/quit.test.js`.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitestEntry = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));

const child = spawn(process.execPath, [vitestEntry, "run", "--project", "e2e", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, TURNSTONE_E2E: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
