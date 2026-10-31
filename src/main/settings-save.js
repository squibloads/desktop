// Validation and decision for the save-settings IPC handler. Kept free of
// Electron so the rules can be tested; the handler performs the side effects.

const { LOOPBACK_HOSTS } = require("./runtime-config.js");

const MODES = ["server", "console", "both", "local"];

/**
 * Only https can reach a remote host, and http only reaches this computer. Anything
 * else is refused before it reaches loadURL, where a file: or javascript: address
 * would be loaded. Plain http to a remote host would send logins unencrypted.
 */
function isValidUrl(str) {
  // new URL() turns an array into its text, so a non-string is refused here, before any write.
  if (typeof str !== "string") return false;
  try {
    const u = new URL(str);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK_HOSTS.includes(u.hostname);
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
    return { error: "Invalid Server URL — must be https:// (http:// only on this computer)" };
  }
  if (needsConsole && !isValidUrl(incoming.consoleUrl)) {
    return { error: "Invalid Console URL — must be https:// (http:// only on this computer)" };
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
  // A URL the mode does not use is not written, so editing it changes nothing the
  // window shows. Counting it would reconnect notifications on a hidden-field edit.
  const serverChanged = needsServer && incoming.serverUrl !== current.serverUrl;
  const consoleChanged = needsConsole && incoming.consoleUrl !== current.consoleUrl;
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

/**
 * Writes a planned save to the store. The mode is written last: if an earlier
 * write throws, the stored mode is still the old one, so the window and the
 * notifications built from it still match what is saved.
 */
function writeSavePlan(store, apply) {
  if (apply.quitBehavior !== undefined) store.quitBehavior = apply.quitBehavior;
  if (apply.serverUrl !== undefined) store.serverUrl = apply.serverUrl;
  if (apply.consoleUrl !== undefined) store.consoleUrl = apply.consoleUrl;
  store.mode = apply.mode;
}

/**
 * Settings as the health poller and the notification poll may read them. A stored address
 * the rule refuses reads as absent, so it is never polled or connected to. The getters read
 * the store each time, so a later change is seen without rebuilding this object.
 */
function reachableSettings(readStore) {
  return {
    get hasServer() {
      const store = readStore();
      return store.hasServer && isValidUrl(store.serverUrl);
    },
    get serverUrl() {
      return readStore().serverUrl;
    },
    get hasConsole() {
      const store = readStore();
      return store.hasConsole && isValidUrl(store.consoleUrl);
    },
    get consoleUrl() {
      return readStore().consoleUrl;
    },
    // A view the mode uses whose stored address is refused. The status says so, rather than
    // reading as switched off.
    get serverRefused() {
      const store = readStore();
      return store.hasServer && !isValidUrl(store.serverUrl);
    },
    get consoleRefused() {
      const store = readStore();
      return store.hasConsole && !isValidUrl(store.consoleUrl);
    },
  };
}

module.exports = { planSettingsSave, isValidUrl, writeSavePlan, reachableSettings };
