import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAIN = readFileSync(join(__dirname, "..", "..", "src", "main", "main.js"), "utf8");

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
  // Failure: a view or window that leaves the sandbox flag implicit runs its renderer on whatever the Electron default is. A later change to that default, or a copy of these options elsewhere, would then drop the sandbox without a visible change.
  it("sets sandbox: true in every web preferences block", () => {
    const blocks = prefsBlocks(MAIN);
    // The shell, the shared content view options, and Settings. A new block must be added to this count on purpose.
    expect(blocks.length).toBe(3);
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
});
