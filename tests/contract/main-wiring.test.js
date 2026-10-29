import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// main.js is not run by the tests, so these pin the call shapes that feed the
// pure modules. A wiring slip (swapped arguments, a hard-coded flag, a dropped
// sender check) would pass every unit test of the modules themselves.
const main = readFileSync(join(__dirname, "..", "..", "src", "main", "main.js"), "utf8");

const shapes = [
  // Failure: swapped width and height put the page in the wrong place.
  ["content bounds", "contentBounds(width, height, TAB_BAR_HEIGHT)"],
  // Failure: a wrong tab bar size shifts or clips the whole window.
  ["tab bar bounds", "tabBarBounds(width, TAB_BAR_HEIGHT)"],
  // Failure: a fixed answer lets any window trigger the local start.
  ["retry sender check", "senderIsConsole: hasConsoleView && isFromWindow(event, consoleView.webContents)"],
  // Failure: ignoring the configured URL lets the page navigate anywhere.
  ["navigation setting", "isNavigationAllowed(allowedUrl, url)"],
  ["allowed url source", "allowedUrl = settings[settingKey];"],
  // Failure: a fixed flag lays out a view that does not exist.
  ["layout server flag", "hasServer: settings.hasServer,"],
  ["layout active tab", "    activeTab,"],
  // Failure: switching on the requested tab instead of the planned one.
  ["tab switch plan", 'if (plan.tab === "server")'],
];

describe("main.js wiring", () => {
  it.each(shapes)("keeps the %s call shape", (_name, text) => {
    expect(main.includes(text)).toBe(true);
  });

  // Failure: the open handler runs when the rule says no, opening links the rule rejected.
  it("opens external links only when the rule allows them, in both handlers", () => {
    const hits = main.match(/if \(windowOpenAction\(url\)\.open\) \{/g) || [];
    expect(hits.length).toBe(2);
  });
});
