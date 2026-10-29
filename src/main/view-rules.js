/**
 * Whether a view may navigate to targetUrl. Only the same origin as the view's
 * configured URL is allowed. Origin, not host, decides: a different port or
 * scheme is a different site. Anything that does not parse is refused, so a
 * bad URL in settings or on the page cancels the navigation rather than
 * letting it through.
 */
function isNavigationAllowed(allowedUrl, targetUrl) {
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

module.exports = { isNavigationAllowed, windowOpenAction };
