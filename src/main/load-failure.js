// Chromium's ERR_ABORTED: the load was superseded (a redirect, a new
// navigation, a cancelled request). The page is still loading, not down.
const ERR_ABORTED = -3;

/**
 * Decide whether a did-fail-load means the backend is unreachable.
 * Sub-frame failures and aborted loads used to replace a working page
 * with the error page, which looked like the saved settings were lost.
 */
function shouldShowErrorPage(errorCode, isMainFrame, url) {
  if (!isMainFrame) return false;
  if (errorCode === ERR_ABORTED) return false;
  if (url.startsWith("file://")) return false;
  return true;
}

/**
 * loadFile's `query` takes an object; a string is silently dropped. A reason tells the error
 * page which message to show. Without one, the page shows the connection error.
 */
function errorPageQuery(originalUrl, reason) {
  return reason === undefined ? { url: originalUrl } : { url: originalUrl, reason };
}

/**
 * Pick how to recover a view after its backend comes back. A reload repeats
 * whatever the view is showing, so when that is our own error or loading
 * page the reload re-shows the page and never reaches the server; the
 * original URL has to be loaded instead. An empty URL means nothing useful
 * is loaded, so it takes the same path.
 */
function recoveryAction(currentUrl) {
  if (typeof currentUrl !== "string" || currentUrl === "") return "load-original";
  // Allow-list: only a live http(s) page is worth reloading. Our own file://
  // pages, about:blank, data: and chrome-error: all need the URL loaded.
  if (/^https?:\/\//i.test(currentUrl)) return "reload";
  return "load-original";
}

module.exports = { shouldShowErrorPage, errorPageQuery, recoveryAction };
