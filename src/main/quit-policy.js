/**
 * Whether quitting should stop the local pod. Only a session that manages a
 * running pod stops it, and only when the user chose stop. A quit already in
 * progress does not start a second stop.
 *
 * getQuitBehavior is a function because the stored value can be unreadable.
 * A failed read is returned, not thrown, so the caller can log it and let the
 * quit proceed; a corrupt setting must not trap the user in the app.
 */
function shouldStopPodOnQuit({ getQuitBehavior, runtime, quitting }) {
  try {
    const behavior = getQuitBehavior();
    const stop =
      behavior === "stop" && Boolean(runtime && runtime.active) && !quitting;
    return { stop };
  } catch (error) {
    return { stop: false, error };
  }
}

/**
 * What closing the main window does: "hide" keeps the app, its checks and the
 * Local pod running in the tray; "close" lets the window close, which quits
 * the app on Windows and Linux. Only the exact string "quit" closes.
 *
 * A close that is allowed (a quit has begun, Windows is ending the session,
 * or a mode change is rebuilding the window) always closes, and the setting
 * is not read: a throw there would block a quit or a shutdown. macOS keeps
 * its own behaviour, where the app outlives its window.
 *
 * An unreadable setting hides, the default, and the error is returned for
 * the caller to log. A hide never traps the user: Quit in the tray still works.
 */
function windowCloseAction({ getCloseBehavior, allowClose, platform }) {
  if (allowClose || platform === "darwin") return { action: "close" };
  try {
    return { action: getCloseBehavior() === "quit" ? "close" : "hide" };
  } catch (error) {
    return { action: "hide", error };
  }
}

module.exports = { shouldStopPodOnQuit, windowCloseAction };
