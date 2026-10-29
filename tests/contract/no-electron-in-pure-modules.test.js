import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// These modules hold decisions and must load under plain Node, so tests can run
// without the electron package or its binary. A top-level require of electron
// would break that. Lazy requires inside a function are allowed.
const MAIN_DIR = join(__dirname, "..", "..", "src", "main");

const PURE_MODULES = [
  "tray-status.js",
  "menu-template.js",
  "view-rules.js",
  "layout.js",
  "ipc-guards.js",
  "load-failure.js",
  "recovery.js",
  "quit-policy.js",
  "settings-save.js",
  "settings-window.js",
  "notifications.js",
  "runtime-config.js",
];

// A line starting at column 0 with a require or import of "electron". Indented
// lines are inside a function, so a lazy require is not flagged.
const TOP_LEVEL_ELECTRON = /(require\(\s*["']electron["']\s*\)|from\s+["']electron["'])/;

function topLevelElectronLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => /^\S/.test(line) && TOP_LEVEL_ELECTRON.test(line));
}

describe("pure modules", () => {
  // Failure: a top-level require("electron") in a pure module makes its tests need the electron binary.
  it("have no top-level require or import of electron", () => {
    const offenders = {};
    for (const name of PURE_MODULES) {
      const path = join(MAIN_DIR, name);
      // A listed module that is missing or renamed must fail, not shrink the guard.
      expect(existsSync(path), `${name} exists`).toBe(true);
      const hits = topLevelElectronLines(readFileSync(path, "utf8"));
      if (hits.length > 0) offenders[name] = hits;
    }

    expect(offenders).toEqual({});
  });

  // Failure: the detector above silently matches nothing, so the guard passes whatever a module contains.
  it("detects a top-level electron require, so the check above can fail", () => {
    const sample = 'const { Notification } = require("electron");\nmodule.exports = {};\n';

    expect(topLevelElectronLines(sample)).toEqual(['const { Notification } = require("electron");']);
  });

  // Failure: the lazy require that keeps notifications.js loadable under Node is removed, or moved to the top.
  it("keeps notifications.js requiring electron only inside a function", () => {
    const source = readFileSync(join(MAIN_DIR, "notifications.js"), "utf8");
    const lines = source.split(/\r?\n/).filter((line) => TOP_LEVEL_ELECTRON.test(line));

    expect(lines.length).toEqual(1);
    expect(lines[0]).toEqual('    const Notification = this._Notification ?? require("electron").Notification;');
  });
});
