import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const RENDERER_DIR = join(root, "src", "renderer");

function readSources() {
  const renderer = readdirSync(RENDERER_DIR)
    .filter((name) => /\.(js|html)$/.test(name))
    .map((name) => readFileSync(join(RENDERER_DIR, name), "utf8"))
    .join("\n");
  return {
    preload: readFileSync(join(root, "src", "preload", "preload.js"), "utf8"),
    main: readFileSync(join(root, "src", "main", "main.js"), "utf8"),
    renderer,
  };
}

// Unique channel names matched by the first capture group, sorted for a stable report.
function channelsMatching(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
}

// Requests and one-way messages the preload sends to main.
const preloadRequests = (text) => channelsMatching(text, /ipcRenderer\.(?:invoke|send)\(\s*"([^"]+)"/g);
// Channels the preload listens on; main must send them to a window.
const preloadListens = (text) => channelsMatching(text, /ipcRenderer\.on\(\s*"([^"]+)"/g);
// Channels main answers or receives.
const mainHandlers = (text) => channelsMatching(text, /ipcMain\.(?:handle|on)\(\s*"([^"]+)"/g);
// Channels main pushes to a window, through webContents.send or a window's send.
const mainSends = (text) => channelsMatching(text, /\.send\(\s*"([^"]+)"/g);

// The channel name in quotes, so "turnstone:window-close" does not match "turnstone:window-closed".
function mentions(text, channel) {
  return text.includes(`"${channel}"`) || text.includes(`'${channel}'`);
}

// Returns one message per broken link. An empty list means every channel the
// preload uses has a main-process end, and every main channel has a caller.
function findProblems({ preload, main, renderer }) {
  const handled = mainHandlers(main);
  const sent = mainSends(main);
  const problems = [];
  for (const channel of preloadRequests(preload)) {
    if (!handled.includes(channel)) {
      problems.push(`preload sends "${channel}" but main.js registers no ipcMain.handle/on for it`);
    }
  }
  for (const channel of preloadListens(preload)) {
    if (!sent.includes(channel)) {
      problems.push(`preload listens on "${channel}" but main.js sends it to no window`);
    }
  }
  for (const channel of [...handled, ...sent]) {
    if (!mentions(preload, channel) && !mentions(renderer, channel)) {
      problems.push(`main.js uses "${channel}" but neither preload.js nor src/renderer names it`);
    }
  }
  return problems;
}

const sources = readSources();

describe("IPC channel contract", () => {
  // Failure: the sanity check passes because the pattern matches nothing, and a renamed channel goes unnoticed.
  // The literal lists pin what the extraction must find in the real files.
  it("finds the request channels the preload sends", () => {
    expect(preloadRequests(sources.preload)).toEqual([
      "turnstone:get-settings",
      "turnstone:open-settings",
      "turnstone:retry-local",
      "turnstone:save-settings",
      "turnstone:settings-resize",
      "turnstone:switch-tab",
      "turnstone:window-close",
      "turnstone:window-maximize",
      "turnstone:window-minimize",
    ]);
  });

  // Failure: a listener that matches nothing is never checked, so a health or stage update can stop reaching the page.
  it("finds the channels the preload listens on", () => {
    expect(preloadListens(sources.preload)).toEqual(["turnstone:health-update", "turnstone:local-progress"]);
  });

  // Failure: a handler that is registered under a different name than the preload uses is never matched, so a button does nothing.
  it("finds the handlers and listeners main registers", () => {
    expect(mainHandlers(sources.main)).toEqual([
      "turnstone:get-settings",
      "turnstone:open-settings",
      "turnstone:retry-local",
      "turnstone:save-settings",
      "turnstone:settings-resize",
      "turnstone:switch-tab",
      "turnstone:window-close",
      "turnstone:window-maximize",
      "turnstone:window-minimize",
    ]);
  });

  // Failure: a stage or health push that main sends under a different name never reaches the page.
  it("finds the channels main pushes to a window", () => {
    expect(mainSends(sources.main)).toEqual(["turnstone:health-update", "turnstone:local-progress"]);
  });

  // Failure: a button in the page sends a channel main never handles, so clicking it does nothing and no error is shown.
  it("the real preload and main agree on every channel", () => {
    expect(findProblems(sources), JSON.stringify({
      requests: preloadRequests(sources.preload),
      listens: preloadListens(sources.preload),
      handlers: mainHandlers(sources.main),
      sends: mainSends(sources.main),
    })).toEqual([]);
  });

  // Failure: a window-close button stops working after its handler is renamed, and the check above goes blind.
  it("reports a preload request whose main handler was removed", () => {
    const main = sources.main.replace('ipcMain.on("turnstone:window-close"', 'ipcMain.on("turnstone:window-shut"');
    expect(findProblems({ ...sources, main })).toEqual([
      'preload sends "turnstone:window-close" but main.js registers no ipcMain.handle/on for it',
      'main.js uses "turnstone:window-shut" but neither preload.js nor src/renderer names it',
    ]);
  });

  // Failure: a new button is added to the preload before its handler exists and the mismatch ships.
  it("reports a preload request with no main handler", () => {
    const preload = sources.preload.replace(
      'windowClose: () => ipcRenderer.send("turnstone:window-close"),',
      'windowClose: () => ipcRenderer.send("turnstone:window-close"),\n  windowShut: () => ipcRenderer.send("turnstone:window-shut"),',
    );
    expect(findProblems({ ...sources, preload })).toEqual([
      'preload sends "turnstone:window-shut" but main.js registers no ipcMain.handle/on for it',
    ]);
  });

  // Failure: the health indicator freezes because main pushes to a channel the preload no longer listens to.
  it("reports a preload listener that main no longer sends to", () => {
    const main = sources.main.replace(
      'shellView.webContents.send("turnstone:health-update", status)',
      'shellView.webContents.send("turnstone:health-updated", status)',
    );
    expect(findProblems({ ...sources, main })).toEqual([
      'preload listens on "turnstone:health-update" but main.js sends it to no window',
      'main.js uses "turnstone:health-updated" but neither preload.js nor src/renderer names it',
    ]);
  });
});
