// One copy of the app at a time. Two copies in Local mode would both run the start against the same machine and pod,
// and quitting either one stops the pod under the other; two copies also mean two tray icons and two sets of checks.
// So a second launch hands over to the first copy, which brings its window forward, and exits.
//
// The lock belongs to the user-data directory, so a copy started with a different one (each e2e test, for one) holds
// a lock of its own.
//
// No electron require: main.js passes app, and the tests an EventEmitter.

/**
 * Takes the lock. True: this copy is the only one, and onSecondLaunch runs each time another launch starts. False:
 * another copy holds it, so this one must exit before it builds anything. A handler that throws is logged: an
 * exception escaping here would reach Electron's event loop and take down the copy the user already has open.
 */
function claimSingleInstance(app, onSecondLaunch, { error = console.error } = {}) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => {
    try {
      onSecondLaunch();
    } catch (err) {
      error("second launch: could not bring the window forward:", err);
    }
  });
  return true;
}

/**
 * Brings the window to the front: out of the taskbar if minimized, out of the tray if hidden, then focused. A window
 * that is already up is only focused, because a restore or show can move or resize it on some desktops. False when
 * there is no window, which happens for a launch during startup, before the window exists.
 */
function bringToFront(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

module.exports = { claimSingleInstance, bringToFront };
