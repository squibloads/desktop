// The Windows AppUserModelID. Windows puts a window on a pinned taskbar button only when the two carry the same ID.
// Without one, a copy the pin did not start (at login, from the installer, from another shortcut) gets a button of its
// own beside the pin, and close-to-tray then brings the window back on that second button. Windows also needs the ID
// to match a Start menu shortcut to show the app's notifications.
//
// No electron require, so the choice can be tested. main.js sets it before any window opens.

const { isPackagedApp } = require("./runtime-config.js");

// What Squirrel stamps on the shortcuts it makes: com.squirrel.<maker-squirrel name>.<executableName>, both from
// forge.config.js. tests/contract/packaging.test.js keeps the two in step.
const INSTALLED_APP_ID = "com.squirrel.turnstone-desktop.turnstone-desktop";

// A dev run's own ID, so a dev copy never shares a taskbar button with an installed one. The dev shortcut carries it;
// README.md says how to stamp it.
const DEV_APP_ID = "turnstone-desktop.dev";

/** The ID to set on Windows, or null on macOS and Linux, which have no such ID. */
function appUserModelId({ platform = process.platform, packaged = isPackagedApp() } = {}) {
  if (platform !== "win32") return null;
  return packaged ? INSTALLED_APP_ID : DEV_APP_ID;
}

module.exports = { appUserModelId, INSTALLED_APP_ID, DEV_APP_ID };
