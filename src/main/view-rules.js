const { isValidUrl } = require("./settings-save.js");

/**
 * Whether a view may navigate to targetUrl. Only the same origin as the view's
 * configured URL is allowed. Origin, not host, decides: a different port or
 * scheme is a different site. Anything that does not parse is refused, so a
 * bad URL in settings or on the page cancels the navigation rather than
 * letting it through.
 */
function isNavigationAllowed(allowedUrl, targetUrl) {
  // A configured address the rule refuses grants no navigation at all.
  if (!isValidUrl(allowedUrl)) return false;
  try {
    const allowed = new URL(allowedUrl);
    // Opaque origins (file:, data:, a scheme-less host:port) all read "null" and
    // would match each other, so only an http(s) setting can allow anything.
    if (allowed.protocol !== "http:" && allowed.protocol !== "https:") return false;
    const target = new URL(targetUrl);
    return target.origin === allowed.origin;
  } catch {
    return false;
  }
}

/**
 * Whether a window-open request should be handed to the user's browser. Only
 * http and https links leave the app; every other scheme is dropped. The check
 * is case-sensitive on purpose: it is the rule the app has always applied.
 * A non-string request is refused rather than thrown, so the caller can still
 * deny the window.
 */
function windowOpenAction(url) {
  const open =
    typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"));
  return { open };
}

/**
 * Whether a main-frame request from a view may go ahead. Only http and https are checked: the
 * app's own pages and blank pages are not requests to another site. A configured page's
 * requests, including each redirect hop, must stay on its configured origin, so a redirect to
 * another site is cancelled before it loads. A null configuredUrl (a web contents that is not a
 * view) allows no http or https request, because a null address is refused.
 */
function mainFrameRequestAllowed(url, configuredUrl) {
  if (!/^https?:\/\//i.test(url)) return true;
  return isNavigationAllowed(configuredUrl, url);
}

/**
 * Whether a request the session sees may go ahead. A page's subresources (scripts, images,
 * XHR) belong to the page, so only a main-frame request is judged, against the address its view
 * is configured to show. Anything the rule cannot read is refused: an unanswered request leaves
 * its page hanging, and a refusal shows the refusal page instead.
 */
function requestAllowed(details, readViews, readSettings) {
  try {
    if (details.resourceType !== "mainFrame") return true;
    const configured = configuredAddressOf(details.webContentsId, readViews(), readSettings());
    return mainFrameRequestAllowed(details.url, configured);
  } catch {
    return false;
  }
}

/**
 * The address a web contents is configured to show: serverUrl for the server view, consoleUrl for
 * the console view, and null for anything else. The views hold each view's web contents id, or
 * null when that view does not exist.
 */
function configuredAddressOf(webContentsId, views, settings) {
  if (webContentsId === views.server) return settings.serverUrl;
  if (webContentsId === views.console) return settings.consoleUrl;
  return null;
}

module.exports = { isNavigationAllowed, windowOpenAction, mainFrameRequestAllowed, requestAllowed };
