const { recoveryAction } = require("./load-failure.js");

/**
 * Decide how to bring a view back. The caller executes the result.
 *
 * "skip": quitting, or a local start owns the console view. Recovery must not
 * start a load that races the pod stop, or replaces the loading page with a
 * console whose node is not up.
 * "restart-local": the local console is down, or shows our own error or
 * loading page. A reload would re-show that page and never reach the server,
 * so the local start runs again instead.
 * "reload": a live page that is worth reloading.
 * "load-url": anything else; the saved URL is loaded.
 *
 * consoleDown only applies to the local console; a remote view ignores it.
 */
function planRecovery({ localConsole, starting, quitting, url, consoleDown }) {
  if (quitting) return "skip";
  if (localConsole && starting) return "skip";
  if (localConsole && (consoleDown || recoveryAction(url) !== "reload")) {
    return "restart-local";
  }
  if (recoveryAction(url) === "reload") return "reload";
  return "load-url";
}

module.exports = { planRecovery };
