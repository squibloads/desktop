// Pure helpers that keep the smoke tier away from a real Podman. They live apart from
// launch-app.js so the unit tier can test them without starting Electron.

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// The file names a podman executable carries on each platform.
const PODMAN_FILE_NAMES = ["podman", "podman.exe", "podman.cmd", "podman.bat"];

function dirHoldsPodman(dir, platform) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  // Windows file names are case-insensitive, so PODMAN.EXE is podman there and not elsewhere.
  return names.some((name) =>
    PODMAN_FILE_NAMES.includes(platform === "win32" ? name.toLowerCase() : name),
  );
}

// Returns pathValue with every directory that holds a podman executable removed. launch-app.js
// applies it to the child's PATH. The TURNSTONE_PODMAN override is the primary guard; this is the
// second one, so that if the override were ever lost the app still could not find a real podman
// on the PATH it is given. It does not cover the child's working directory or the application
// directory, which Windows searches before PATH.
export function pathWithoutPodman(pathValue, { platform = process.platform, separator } = {}) {
  const sep = separator ?? (platform === "win32" ? ";" : ":");
  return pathValue
    .split(sep)
    .filter((entry) => {
      const unquoted = entry.replace(/^"(.*)"$/, "$1");
      return !dirHoldsPodman(resolve(unquoted || "."), platform);
    })
    .join(sep);
}

// Returns null when raw is a TURNSTONE_PODMAN value that starts the given node binary, otherwise
// the reason it does not. The smoke tier sets [execPath, fake-podman.js]; any other first element
// would run a different binary. The reason names the variable, never the value.
export function checkPodmanOverride(raw, execPath) {
  if (raw === undefined || raw === "") return "TURNSTONE_PODMAN is not set in the child environment";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "TURNSTONE_PODMAN is not valid JSON in the child environment";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return "TURNSTONE_PODMAN is not a non-empty JSON array in the child environment";
  }
  if (parsed[0] !== execPath) {
    return "TURNSTONE_PODMAN does not start with the test runner's node binary";
  }
  return null;
}
