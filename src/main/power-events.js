// Sleep and wake. A request in flight as the PC sleeps can hang on a connection that died, or fail and read as an
// outage that never happened, and the first poll after a wake can be up to 10 seconds away. So the polls stop on
// suspend and run at once on resume.
//
// No electron require: main.js passes powerMonitor, and the tests an EventEmitter.

/**
 * Runs onSuspend on each suspend and onResume on each resume, and logs both, so a support log shows whether a wake was
 * seen. A handler that throws is logged: an exception escaping here would reach Electron's event loop.
 */
function watchSleep(powerMonitor, { onSuspend, onResume, log = console.log, error = console.error }) {
  const on = (event, line, handler) => {
    powerMonitor.on(event, () => {
      log(line);
      try {
        handler();
      } catch (err) {
        error(`power: ${event} handler failed:`, err);
      }
    });
  };
  on("suspend", "power: suspend, polls paused", onSuspend);
  on("resume", "power: resume, polling now", onResume);
}

module.exports = { watchSleep };
