import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const ROOT = join(__dirname, "..", "..");
const MAIN_DIR = join(ROOT, "src", "main");

// The functions that read the smoke-test overrides. Each decides for itself whether the app is packaged when its
// caller passes nothing, and a release must leave that decision to it.
const OVERRIDE_READERS = ["podmanCommand", "localConsoleUrl", "firstConfigError"];

// Each node of the syntax tree.
function* walk(node) {
  yield node;
  for (const value of Object.values(node)) {
    for (const child of [value].flat()) {
      if (child && typeof child.type === "string") yield* walk(child);
    }
  }
}

// Calls to an override reader that pass it arguments, as "line: name(n args)".
function readerCallsWithArguments(source) {
  const found = [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, locations: true });
  for (const node of walk(tree)) {
    if (node.type !== "CallExpression") continue;
    const { callee } = node;
    const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" ? callee.property.name : null;
    if (OVERRIDE_READERS.includes(name) && node.arguments.length > 0) {
      found.push(`${node.loc.start.line}: ${name}(${node.arguments.length} args)`);
    }
  }
  return found;
}

describe("packaging", () => {
  // Failure: the app is packaged without app.asar, so a release runs runtime-config.js from a plain directory, counts as
  // unpackaged, and reads the smoke-test overrides.
  it("packs the app into app.asar", () => {
    const { packagerConfig } = require(join(ROOT, "forge.config.js"));

    expect(packagerConfig.asar).toBeTruthy();
  });

  // Failure: a caller passes its own environment or "unpackaged" to an override reader, so a release reads the
  // overrides whatever runtime-config.js decides.
  it("lets every override reader decide for itself whether the app is packaged", () => {
    const calls = {};
    for (const name of readdirSync(MAIN_DIR).filter((file) => file.endsWith(".js") && file !== "runtime-config.js")) {
      const found = readerCallsWithArguments(readFileSync(join(MAIN_DIR, name), "utf8"));
      if (found.length > 0) calls[name] = found;
    }

    expect(calls).toEqual({});
  });

  // Failure: the check above misses a call with arguments, or flags one without, so it proves nothing.
  it("finds a call to an override reader that passes arguments, and nothing else", () => {
    expect(readerCallsWithArguments("podmanCommand(process.env, false);")).toEqual(["1: podmanCommand(2 args)"]);
    expect(readerCallsWithArguments("config.localConsoleUrl(env);")).toEqual(["1: localConsoleUrl(1 args)"]);
    expect(readerCallsWithArguments("const e = firstConfigError({});")).toEqual(["1: firstConfigError(1 args)"]);
    expect(readerCallsWithArguments("podmanCommand(); localConsoleUrl(); firstConfigError(); other(1);")).toEqual([]);
  });
});
