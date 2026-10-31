import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { LOOPBACK_HOSTS } = require("../../src/main/runtime-config.js");

// The renderer cannot require the main-process rule, so it keeps its own copy of the hosts.
// This pins the copy to the same list, so the form and the save cannot disagree.
describe("loopback hosts", () => {
  // Failure: the form accepts a host the save refuses, or refuses one the save accepts, so the two disagree.
  it("the renderer's copy lists the same hosts as the main process", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "renderer", "settings.js"), "utf8");
    // The literal ends at the first "];", so a "]" inside "[::1]" does not cut it short.
    const match = source.match(/const LOCAL_HOSTS = (\[.*?\]);/);

    expect(match, "LOCAL_HOSTS is declared in settings.js").not.toBeNull();
    expect(JSON.parse(match[1])).toEqual(LOOPBACK_HOSTS);
  });
});
