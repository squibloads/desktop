// Loads a renderer page the way the browser does: the real HTML, the real
// script file, and a fake of the contextBridge object from src/preload/preload.js.
//
// The fake is exposed as window.electronAPI, the name preload.js uses and the
// name every renderer script reads. Its keys are exactly the keys preload.js
// exposes; tests/contract/renderer-bridge.test.js checks that. Test-only controls
// (emitting health or stage events) live on a separate `hub`, so the object a
// page sees carries nothing production does not.
//
// Nothing here reaches the network: jsdom fetches no subresources, and the
// page's <script src> tag is removed so the only script that runs is the file
// this helper evaluates, after the DOM exists, as an end-of-body script would.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";

// Read from the file path, not `new URL(...)`: the jsdom environment replaces the URL
// global, and fileURLToPath rejects its objects.
const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer");

const COLOUR_SCHEME_LIGHT = "(prefers-color-scheme: light)";

const DEFAULT_SETTINGS = {
  mode: "both",
  serverUrl: "http://server.example.test:8080",
  consoleUrl: "http://console.example.test:8090",
  quitBehavior: "stop",
  activeTab: "server",
};

// Functions that take a callback return an unsubscribe function, as preload.js does.
// A subscriber is tracked so the hub can deliver to it, and removed on unsubscribe.
function subscribable(set) {
  return vi.fn((callback) => {
    const handler = (value) => callback(value);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  });
}

/**
 * Builds the fake bridge. `api` is what the page sees; `hub` is test-side only.
 * Settings and save results are plain data, so a test states them literally.
 */
export function createFakeBridge({
  platform = "win32",
  settings = DEFAULT_SETTINGS,
  saveResult = { ok: true },
} = {}) {
  const healthHandlers = new Set();
  const progressHandlers = new Set();

  const api = {
    platform,
    getSettings: vi.fn(() => Promise.resolve({ ...settings })),
    saveSettings: vi.fn(() => Promise.resolve(saveResult)),
    resizeSettings: vi.fn(),
    switchTab: vi.fn(),
    onHealthUpdate: subscribable(healthHandlers),
    onLocalProgress: subscribable(progressHandlers),
    retryLocal: vi.fn(),
    openSettings: vi.fn(),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
  };

  // Delivers to subscribers attached right now. An event with no subscriber is
  // dropped, as ipcRenderer drops a message nobody listens for.
  const hub = {
    emitHealth(status) {
      for (const handler of [...healthHandlers]) handler(status);
    },
    emitLocalProgress(stage) {
      for (const handler of [...progressHandlers]) handler(stage);
    },
    healthSubscribers: () => healthHandlers.size,
    progressSubscribers: () => progressHandlers.size,
  };

  return { api, hub };
}

// The one <script src="..."> tag a renderer page carries, with the file it names.
function scriptFileOf(source) {
  const match = /<script\s+src="([^"]+)"\s*><\/script>/.exec(source);
  if (!match) throw new Error("renderer page has no <script src> tag");
  return match[1];
}

const openWindows = [];

/**
 * Opens `src/renderer/<name>.html` in a fresh jsdom window and runs its script.
 *
 * Options:
 *   api        a bridge from createFakeBridge (default: a fresh one)
 *   prefersLight  the value the matchMedia stub reports for prefers-color-scheme: light at load
 *   query      an object written to the URL's query string, as loadFile's query option
 *
 * Returns { window, document, api, hub, jsdomErrors, closeCalls, resizeObservers,
 * triggerResize, setPrefersLight }. window.close is a spy, so a page closing its own
 * window only records the call. jsdomErrors collects what jsdom reports as not
 * implemented, such as a navigation it declines to perform. setPrefersLight(bool)
 * changes what the colour-scheme query reports and fires its `change` listeners,
 * as the OS theme switching while the window is open does.
 */
export function loadPage(name, { api, hub, prefersLight = false, query } = {}) {
  const bridge = api ? { api, hub } : createFakeBridge();
  const source = readFileSync(join(RENDERER_DIR, `${name}.html`), "utf8");
  const scriptFile = scriptFileOf(source);
  const html = source.replace(/<script\s+src="[^"]*"\s*><\/script>/g, "");
  const search = query ? `?${new URLSearchParams(query).toString()}` : "";

  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => jsdomErrors.push(error.message));

  const dom = new JSDOM(html, {
    url: `http://localhost/${name}.html${search}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const win = dom.window;
  openWindows.push({ win, realClose: win.close.bind(win) });

  // jsdom has no matchMedia or ResizeObserver. The stubs keep the real logic:
  // matchMedia answers only the colour-scheme query the pages ask, and its `change`
  // listeners are kept so setPrefersLight can fire them. ResizeObserver keeps its
  // callback so a test can fire a resize.
  let lightNow = prefersLight;
  const changeListeners = new Set();
  win.matchMedia = (query) => ({
    get matches() {
      return query === COLOUR_SCHEME_LIGHT ? lightNow : false;
    },
    media: query,
    addEventListener(type, listener) {
      if (type === "change" && query === COLOUR_SCHEME_LIGHT) changeListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change" && query === COLOUR_SCHEME_LIGHT) changeListeners.delete(listener);
    },
  });
  const setPrefersLight = (value) => {
    lightNow = value;
    for (const listener of [...changeListeners]) {
      listener({ matches: value, media: COLOUR_SCHEME_LIGHT });
    }
  };

  // A real ResizeObserver also calls back once on observe(). This stub does not:
  // the settings page reports its height on every callback, and its resize test
  // asserts the exact list of heights reported. Firing on observe would add a
  // load-time call to that list, so each test fires the resize it checks.
  const resizeObservers = [];
  win.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      resizeObservers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
    }
  };
  const triggerResize = () => {
    for (const observer of resizeObservers) observer.callback([]);
  };

  win.electronAPI = bridge.api;
  const closeSpy = vi.spyOn(win, "close").mockImplementation(() => {});

  // The script is evaluated in the window, after the parser has built the DOM,
  // which is the timing of an end-of-body <script src>.
  win.eval(readFileSync(join(RENDERER_DIR, scriptFile), "utf8"));

  return {
    window: win,
    document: win.document,
    api: bridge.api,
    hub: bridge.hub,
    jsdomErrors,
    closeCalls: () => closeSpy.mock.calls.length,
    resizeObservers,
    triggerResize,
    setPrefersLight,
  };
}

/** Closes every window opened by loadPage. Call it in afterEach. */
export function closeAllPages() {
  for (const { win, realClose } of openWindows.splice(0)) realClose();
}
