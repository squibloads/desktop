import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBridge } from "../helpers/load-page.js";

const PRELOAD = join(fileURLToPath(new URL("../..", import.meta.url)), "src", "preload", "preload.js");

// Splits JavaScript into identifier, string and punctuation tokens. Whitespace and
// comments are dropped. Anything it cannot read throws, so the key parser below never
// skips syntax it does not understand. Regular expression literals are not handled;
// preload.js has none, and one would be misread as punctuation.
function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new Error(`unterminated block comment at offset ${i}`);
      i = end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const end = stringEnd(source, i);
      tokens.push({ type: "string", value: source.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))[0];
      tokens.push({ type: "id", value: word });
      i += word.length;
    } else if (/[0-9]/.test(c)) {
      const num = /^[0-9][\w.]*/.exec(source.slice(i))[0];
      tokens.push({ type: "num", value: num });
      i += num.length;
    } else {
      tokens.push({ type: "punct", value: c });
      i += 1;
    }
  }
  return tokens;
}

// The index of the closing quote of the string literal that opens at `start`.
function stringEnd(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
    } else if (source[i] === quote) {
      if (quote === "`" && source.slice(start, i).includes("${")) {
        throw new Error("template literals with ${} are not supported by this parser");
      }
      return i;
    }
  }
  throw new Error(`unterminated string literal at offset ${start}`);
}

// The top-level keys of the object literal passed to contextBridge.exposeInMainWorld("electronAPI", {...}),
// in source order. Keys may be identifiers or quoted strings, and may be shorthand (`name,`) or methods
// (`name() {}`). A spread or any other syntax at a key position throws.
function exposedKeys(source) {
  const tokens = tokenize(source);
  const start = tokens.findIndex(
    (t, i) =>
      t.type === "id" &&
      t.value === "exposeInMainWorld" &&
      tokens[i + 1]?.value === "(" &&
      tokens[i + 2]?.type === "string" &&
      tokens[i + 2].value === "electronAPI" &&
      tokens[i + 3]?.value === "," &&
      tokens[i + 4]?.value === "{",
  );
  if (start === -1) throw new Error('no exposeInMainWorld("electronAPI", {...}) call found');

  const open = start + 4;
  const keys = [];
  let depth = 0;
  let expectKey = false;
  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (i === open) {
      depth = 1;
      expectKey = true;
      continue;
    }
    if (depth === 1 && expectKey) {
      if (t.type === "punct" && t.value === "}") break;
      if (t.type !== "id" && t.type !== "string") {
        throw new Error(`unsupported syntax at a key position: ${JSON.stringify(t)}`);
      }
      keys.push(t.value);
      expectKey = false;
      continue;
    }
    if (t.type !== "punct") continue;
    if ("([{".includes(t.value)) {
      depth += 1;
    } else if (")]}".includes(t.value)) {
      depth -= 1;
      if (depth === 0) break;
    } else if (t.value === "," && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}

// The keys the renderer pages see, sorted. preload.js and createFakeBridge must both match this list.
const EXPOSED = [
  "getSettings",
  "onHealthUpdate",
  "onLocalProgress",
  "openSettings",
  "platform",
  "resizeSettings",
  "retryLocal",
  "saveSettings",
  "switchTab",
  "windowClose",
  "windowMaximize",
  "windowMinimize",
];

describe("renderer bridge keys", () => {
  // Failure: a page calls a bridge method the fake does not have, so its test passes while the real app throws,
  // or preload.js exposes a method the fake lacks, so no test covers it.
  it("the fake bridge and preload.js expose exactly the same keys", () => {
    const fakeKeys = Object.keys(createFakeBridge().api).sort();
    const preloadKeys = exposedKeys(readFileSync(PRELOAD, "utf8")).sort();

    expect(fakeKeys).toEqual(EXPOSED);
    expect(preloadKeys).toEqual(EXPOSED);
  });

  // Detector control: the parser reads a source with multi-line text, comments, strings that hold commas and
  // braces, a method, a shorthand and a nested object, and returns only the top-level keys in order.
  it("reads the top-level keys of a multi-line exposeInMainWorld call, skipping comments and string contents", () => {
    const sample = [
      'const { contextBridge, ipcRenderer } = require("electron");',
      "// a comment that names a key: fake, and a stray brace {",
      'contextBridge.exposeInMainWorld("electronAPI", {',
      "  /* block comment, with alpha: 9 and a comma, */",
      "  alpha: 1,",
      '  "beta-quoted": (x) => ipcRenderer.invoke("a,b{c", x),',
      "  gamma(a, b) {",
      "    return [a, b, { inner: 2 }];",
      "  },",
      "  delta,",
      "  epsilon: { nested: 1, other: 2 },",
      "});",
    ].join("\n");

    const sampleKeys = exposedKeys(sample);

    expect(sampleKeys).toEqual(["alpha", "beta-quoted", "gamma", "delta", "epsilon"]);
  });

  // Failure: the parser silently reads nothing from a file it does not recognise, so the key check passes on an empty list.
  it("throws when the call is missing rather than returning no keys", () => {
    expect(() => exposedKeys("const x = 1;")).toThrow('no exposeInMainWorld("electronAPI", {...}) call found');
  });

  // Failing-mutation check, in memory: a key added to preload.js is seen by the parser, and the comparison
  // with the fake's keys no longer holds. The on-disk version of this check is run by hand during the mutation pass.
  it("sees a key added to preload.js, so the comparison would fail", () => {
    const source = readFileSync(PRELOAD, "utf8");
    const mutated = source.replace("platform: process.platform,", "platform: process.platform,\n  extraKey: () => null,");
    const changed = mutated !== source;

    const mutatedKeys = exposedKeys(mutated);

    expect(changed).toBe(true);
    expect(mutatedKeys).toContain("extraKey");
    expect(mutatedKeys).not.toEqual(EXPOSED);
  });
});
