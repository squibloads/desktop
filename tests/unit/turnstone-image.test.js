import { describe, it, expect } from "vitest";

const { TURNSTONE_IMAGE, pinnedImageRef } = require("../../src/main/turnstone-image.js");

const DIGEST_1_9_1 = "sha256:c98762f1c339986d84c255476d0fe188466bb13da1ccee695612ec3a83660d12";

describe("the pinned Turnstone image", () => {
  // Failure: a release ships a different Turnstone than the one it was tested with (ADR-03; 1.9.1 per Joe, 2026-11-07).
  it("pins 1.9.1 on ghcr by the registry's index digest", () => {
    expect(TURNSTONE_IMAGE).toEqual({
      repository: "ghcr.io/turnstonelabs/turnstone",
      version: "1.9.1",
      digest: DIGEST_1_9_1,
    });
  });

  // Failure: the image is pulled by tag, so a moved tag swaps in a different image unnoticed (threat D-2).
  it("is pulled by digest, never by tag", () => {
    expect(pinnedImageRef()).toBe(`ghcr.io/turnstonelabs/turnstone@${DIGEST_1_9_1}`);
    expect(pinnedImageRef()).not.toContain(":1.9.1");
  });

  // Failure: a typo in the digest only shows up as a failed pull on a user's PC.
  it("has a well-formed sha256 digest", () => {
    expect(TURNSTONE_IMAGE.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // Failure: some code changes the pin at runtime, and the pull and the digest check disagree about what was pinned.
  it("cannot be changed at runtime", () => {
    expect(Object.isFrozen(TURNSTONE_IMAGE)).toBe(true);
  });
});
