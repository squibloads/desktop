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

module.exports = { shouldStopPodOnQuit };
