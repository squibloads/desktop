// Redirects the request guard cancelled, remembered per view. A cancelled load fails
// like any other load, so this is how the view tells a refused redirect from an
// unreachable server.

/**
 * A navigation that starts in a view supersedes an earlier refusal there: once the view
 * has moved on, a later failure of the same address is an ordinary failure, not a refused
 * redirect. A repeated failure event for the refused load still matches, so it shows the
 * same page rather than the generic one.
 */
function createRedirectRefusals() {
  const byView = new Map();
  return {
    refuse(viewId, url) {
      byView.set(viewId, url);
    },
    navigationStarted(viewId) {
      byView.delete(viewId);
    },
    matches(viewId, url) {
      return byView.has(viewId) && byView.get(viewId) === url;
    },
  };
}

module.exports = { createRedirectRefusals };
