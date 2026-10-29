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

/** loadFile's `query` takes an object; a string is silently dropped. */
function errorPageQuery(originalUrl) {
  return { url: originalUrl };
}

module.exports = { shouldShowErrorPage, errorPageQuery };
