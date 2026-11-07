import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const MAIN_DIR = join(__dirname, "..", "..", "src", "main");
const MAIN = readFileSync(join(MAIN_DIR, "main.js"), "utf8");

// The Electron classes that make a renderer. BaseWindow has no web contents of its own, so it is not one.
const RENDERER_CLASSES = ["BrowserWindow", "WebContentsView", "BrowserView"];

// Each node of the syntax tree.
function* walk(node) {
  yield node;
  for (const value of Object.values(node)) {
    for (const child of [value].flat()) {
      if (child && typeof child.type === "string") yield* walk(child);
    }
  }
}

/**
 * Each window or view a source constructs, as its class and what it passes as webPreferences: "literal" for an
 * object written in place, the name of a variable that holds one, or null when it passes none and so runs on
 * Electron's defaults. The source is parsed, so a comment or a string never counts.
 */
function constructions(source) {
  const found = [];
  for (const node of walk(parse(source, { ecmaVersion: "latest", sourceType: "script" }))) {
    if (node.type !== "NewExpression") continue;
    const { callee } = node;
    const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" ? callee.property.name : null;
    if (!RENDERER_CLASSES.includes(name)) continue;
    const options = node.arguments[0];
    const prefs =
      options?.type === "ObjectExpression"
        ? options.properties.find((prop) => prop.type === "Property" && !prop.computed && prop.key.name === "webPreferences")
        : undefined;
    let passed = null;
    if (prefs?.value.type === "ObjectExpression") passed = "literal";
    else if (prefs?.value.type === "Identifier") passed = prefs.value.name;
    else if (prefs) passed = "other";
    found.push({ name, prefs: passed });
  }
  return found;
}

// The object literal that follows each web-preferences declaration, braces included.
function prefsBlocks(source) {
  const starts = [...source.matchAll(/webPreferences:\s*\{|const contentViewPrefs = \{/g)];
  return starts.map((match) => {
    const open = source.indexOf("{", match.index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error("unbalanced braces in web preferences");
  });
}

// The block's code with line comments removed, so a commented-out flag cannot satisfy the pin.
function code(block) {
  return block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Every value the block assigns to a key. A second key, a spread or a duplicate would add to this list.
function valuesOf(block, key) {
  return [...code(block).matchAll(new RegExp(`\\b${key}\\s*:\\s*(\\w+)`, "g"))].map((match) => match[1]);
}

describe("renderer sandbox", () => {
  // Failure: a window or view is built in another module, or without web preferences, so the pins below never see
  // it and its renderer runs on whatever the Electron default is.
  it("builds every window and view in main.js, each with web preferences the pins below read", () => {
    // Recursive, so a module in a folder added under src/main is read too.
    for (const file of readdirSync(MAIN_DIR, { recursive: true }).filter((name) => name.endsWith(".js") && name !== "main.js")) {
      expect(constructions(readFileSync(join(MAIN_DIR, file), "utf8")), file).toEqual([]);
    }
    // The main window, the shell, the server and console views on the shared options, and Settings, in that order.
    expect(constructions(MAIN)).toEqual([
      { name: "BrowserWindow", prefs: "literal" },
      { name: "WebContentsView", prefs: "literal" },
      { name: "WebContentsView", prefs: "contentViewPrefs" },
      { name: "WebContentsView", prefs: "contentViewPrefs" },
      { name: "BrowserWindow", prefs: "literal" },
    ]);
  });

  // Failure: the check above misses a construction written as a plain or a dotted new, or counts one in a comment,
  // so it proves nothing. An aliased class or Reflect.construct is not found; nothing in src/main writes either.
  it("finds a window or view built with new, by name or through a module, and not in a comment or a string", () => {
    expect(constructions("new BrowserWindow({ width: 1 });")).toEqual([{ name: "BrowserWindow", prefs: null }]);
    expect(constructions("new BrowserWindow();")).toEqual([{ name: "BrowserWindow", prefs: null }]);
    expect(constructions("new electron.WebContentsView({ webPreferences: prefs });")).toEqual([
      { name: "WebContentsView", prefs: "prefs" },
    ]);
    expect(constructions("new BrowserView({ webPreferences: { sandbox: true } });")).toEqual([
      { name: "BrowserView", prefs: "literal" },
    ]);
    expect(constructions("new BrowserWindow({ webPreferences: make() });")).toEqual([{ name: "BrowserWindow", prefs: "other" }]);
    expect(constructions('// new BrowserWindow()\nconst text = "new WebContentsView()";\nnew BaseWindow();')).toEqual([]);
  });

  // Failure: a view or window that leaves the sandbox flag implicit runs its renderer on whatever the Electron default is. A later change to that default, or a copy of these options elsewhere, would then drop the sandbox without a visible change.
  it("sets sandbox: true in every web preferences block", () => {
    const blocks = prefsBlocks(MAIN);
    // The main window, the shell, the shared content view options, and Settings. A new block must be added to this count on purpose.
    expect(blocks.length).toBe(4);
    // Assigning the flag after construction would bypass every block above.
    expect(MAIN).not.toMatch(/(?:\.\s*sandbox|\[\s*["']sandbox["']\s*\])\s*=/);
    for (const block of blocks) {
      // A spread can carry a false flag that no literal in the block shows.
      expect(code(block)).not.toMatch(/\.\.\./);
      expect(valuesOf(block, "sandbox")).toEqual(["true"]);
    }
  });

  // Failure: the sandbox pin is present but a node integration flag turns the renderer back into a Node process, so the pin protects nothing.
  it("keeps node integration off in every web preferences block", () => {
    expect(MAIN).not.toMatch(/(?:\.\s*nodeIntegration|\[\s*["']nodeIntegration["']\s*\])\s*=/);
    for (const block of prefsBlocks(MAIN)) {
      expect(code(block)).not.toMatch(/\.\.\./);
      expect(valuesOf(block, "nodeIntegration")).toEqual(["false"]);
    }
  });

  // Failure: with context isolation off, the preload's scripts and the page share one JavaScript world, so a page
  // can reach the bridge's internals and Electron's IPC directly, past the checks the bridge makes.
  it("keeps context isolation on in every web preferences block", () => {
    expect(MAIN).not.toMatch(/(?:\.\s*contextIsolation|\[\s*["']contextIsolation["']\s*\])\s*=/);
    for (const block of prefsBlocks(MAIN)) {
      expect(code(block)).not.toMatch(/\.\.\./);
      expect(valuesOf(block, "contextIsolation")).toEqual(["true"]);
    }
  });

  // Failure: a block turns the webview tag on, so a page in that renderer builds a view of its own inside the app, with
  // preferences none of these pins read and no window-open rule of the app's choosing.
  it("never turns the webview tag on", () => {
    expect(MAIN).not.toMatch(/(?:\.\s*webviewTag|\[\s*["']webviewTag["']\s*\])\s*=/);
    for (const block of prefsBlocks(MAIN)) {
      expect(valuesOf(block, "webviewTag").filter((value) => value !== "false")).toEqual([]);
    }
  });
});
