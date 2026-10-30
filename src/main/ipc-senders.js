const { isFromWindow } = require("./settings-window.js");

/**
 * Whether a bridge request came from one of the app's own pages, in one of the windows its handler
 * allows. The page must be a file: page in the app's renderer folder, and the request must come from
 * its top frame. A view keeps its web contents when it moves to a site, so the window check alone
 * would let a remote page reach the handler. Each window is read on its own, so a window that is gone
 * or unreadable refuses only itself. Anything the rule cannot read is refused.
 */
function isFromAppPage(event, windows, appRoot) {
  try {
    const allowed = windows.some((readWindow) => {
      try {
        return isFromWindow(event, readWindow());
      } catch {
        return false;
      }
    });
    if (!allowed || event.senderFrame !== event.sender.mainFrame) return false;
    return event.sender.getURL().toLowerCase().startsWith(appRoot.toLowerCase());
  } catch {
    return false;
  }
}

module.exports = { isFromAppPage };
