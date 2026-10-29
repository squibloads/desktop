/**
 * Whether the local-error page's retry request may start the local runtime.
 * Only the console view may ask, it must still be alive, and no start may be
 * in flight: a running start owns the loading page, and reloading it would
 * blank the stage list. The sender check is the caller's job, through
 * settings-window.js isFromWindow, so this stays free of window objects.
 */
function canRetryLocal({ senderIsConsole, hasConsoleView, consoleDestroyed, starting }) {
  return Boolean(hasConsoleView && !consoleDestroyed && senderIsConsole && !starting);
}

module.exports = { canRetryLocal };
