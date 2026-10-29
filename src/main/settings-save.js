// Validation and decision for the save-settings IPC handler. Kept free of
// Electron so the rules can be tested; the handler performs the side effects.

const MODES = ["server", "console", "both", "local"];

/**
 * Only http and https can be shown in a view. Anything else is refused before
 * it reaches loadURL, where a file: or javascript: address would be loaded.
 */
function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a save and decide what it changes.
 *
 * Only the URLs the mode uses are validated and written: a Local save must
 * not overwrite the remote URLs saved for the other modes, and a console-only
 * save must not be refused over a server field the user cannot see.
 *
 * A mode change rebuilds the window, so the per-view reload flags are false
 * then. Without a mode change, the flags say which views to reload.
 *
 * current.quitBehavior is deliberately unused: reading it can throw on a
 * corrupt store, and a save never depended on it.
 */
function planSettingsSave(current, incoming) {
  const mode = incoming.mode || "both";
  const needsServer = mode === "server" || mode === "both";
  const needsConsole = mode === "console" || mode === "both";

  if (!MODES.includes(mode)) return { error: "Invalid mode" };
  if (needsServer && !isValidUrl(incoming.serverUrl)) {
    return { error: "Invalid Server URL — must be http:// or https://" };
  }
  if (needsConsole && !isValidUrl(incoming.consoleUrl)) {
    return { error: "Invalid Console URL — must be http:// or https://" };
  }
  if (
    incoming.quitBehavior !== undefined &&
    incoming.quitBehavior !== "stop" &&
    incoming.quitBehavior !== "keep"
  ) {
    return { error: "Invalid quit behaviour" };
  }

  const apply = { mode };
  if (needsServer) apply.serverUrl = incoming.serverUrl;
  if (needsConsole) apply.consoleUrl = incoming.consoleUrl;
  if (incoming.quitBehavior !== undefined) apply.quitBehavior = incoming.quitBehavior;

  const modeChanged = mode !== current.mode;
  const serverChanged = incoming.serverUrl !== current.serverUrl;
  const consoleChanged = incoming.consoleUrl !== current.consoleUrl;
  // Local mode has no console reload: its console always follows the pod's port.
  const sameMode = !modeChanged;

  return {
    apply,
    modeChanged,
    reloadServer: sameMode && serverChanged,
    reloadConsole: sameMode && consoleChanged && mode !== "local",
    restartNotifications: sameMode && serverChanged,
  };
}

module.exports = { planSettingsSave, isValidUrl };
