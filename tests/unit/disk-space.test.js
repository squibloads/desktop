import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { freeDiskBytes, podmanDataDir } = require("../../src/main/disk-space.js");

describe("freeDiskBytes", () => {
  // Failure: the check throws for the machine folder before Podman has made it, so a first run cannot check at all.
  it("reads the free space of the nearest folder that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "turnstone-disk-"));
    try {
      const bytes = freeDiskBytes(join(dir, "not", "made", "yet"));
      expect(Number.isFinite(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Failure: a read that fails comes back as a number, so a full disk passes the check on a guess.
  it("throws when the free space cannot be read", () => {
    expect(() => freeDiskBytes(join(tmpdir(), "x"), { statfs: () => { throw new Error("EIO"); } })).toThrow("EIO");
  });

  // Failure: the free space is counted in the wrong unit, so the 5 GB check passes with far less.
  it("counts the blocks available to this user, times the block size", () => {
    expect(freeDiskBytes(tmpdir(), { statfs: () => ({ bavail: 3, bfree: 99, bsize: 4096 }) })).toBe(3 * 4096);
  });
});

describe("podmanDataDir", () => {
  // Failure: the check reads another drive than the one the machine's disk grows on.
  it("is Podman's machine folder under the user's home", () => {
    expect(podmanDataDir("C:\\Users\\joe").replace(/\\/g, "/")).toBe("C:/Users/joe/.local/share/containers/podman/machine");
  });
});
