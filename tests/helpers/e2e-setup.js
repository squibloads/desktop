// Runs before each e2e test file. The smoke tier must fail when Electron is missing,
// never skip: a skipped smoke tier looks green while testing nothing. `require("electron")`
// throws when the package's postinstall did not download the binary, and the path it
// returns must exist on disk.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require("electron");
} catch (err) {
  throw new Error(
    `Electron is not installed (${err.message}). Run npm ci without ELECTRON_SKIP_BINARY_DOWNLOAD, then rerun npm run test:e2e.`,
  );
}

if (typeof electronPath !== "string" || !existsSync(electronPath)) {
  throw new Error(
    `Electron binary not found at ${String(electronPath)}. Run npm ci without ELECTRON_SKIP_BINARY_DOWNLOAD, then rerun npm run test:e2e.`,
  );
}
