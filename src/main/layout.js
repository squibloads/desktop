/**
 * Bounds for the tab bar: the top strip across the full window width.
 * Kept separate from contentBounds so the window code can apply both without
 * knowing the arithmetic.
 */
function tabBarBounds(width, tabBarHeight) {
  return { x: 0, y: 0, width, height: tabBarHeight };
}

/**
 * Bounds for a page under the tab bar. The height is not clamped: a window
 * shorter than the bar yields a negative value, exactly as the layout always
 * has.
 */
function contentBounds(width, height, tabBarHeight) {
  return { x: 0, y: tabBarHeight, width, height: height - tabBarHeight };
}

/**
 * Which page gets the content bounds, or null when none should be laid out.
 * A single-view window shows the server page when one is configured, and
 * otherwise the console page. A tabbed window shows the active tab's page
 * when it exists, and otherwise the console page when that exists. Only a
 * page that actually exists is named, so a missing view is never resized.
 */
function planLayout({ isSingleView, hasServer, activeTab, hasServerView, hasConsoleView }) {
  if (isSingleView) {
    if (hasServer) return hasServerView ? "server" : null;
    return hasConsoleView ? "console" : null;
  }
  if (activeTab === "server" && hasServerView) return "server";
  return hasConsoleView ? "console" : null;
}

/**
 * Whether a tab click should swap the visible page, and to which tab. A
 * single-view window has no tabs. Clicking the active tab does nothing. Only
 * the two known tab names are accepted; anything else, including non-strings
 * and property names such as "__proto__", is ignored.
 */
function planTabSwitch({ isSingleView, activeTab, tab }) {
  if (isSingleView) return { switch: false };
  if (tab === activeTab) return { switch: false };
  if (tab !== "server" && tab !== "console") return { switch: false };
  return { switch: true, tab };
}

module.exports = { contentBounds, tabBarBounds, planLayout, planTabSwitch };
