import { describe, it, expect } from "vitest";

const { createRedirectRefusals } = require("../../src/main/redirect-refusals.js");

const TARGET = "https://other.example.com/login";

describe("redirect refusals", () => {
  // Failure: a refused redirect is not remembered, so its failed load reads as an unreachable server.
  it("matches the address that was refused in that view", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    expect(refusals.matches(7, TARGET)).toBe(true);
  });

  // Failure: a failure matches before any refusal was recorded, so an ordinary outage reads as a refused redirect.
  it("matches nothing before a refusal is recorded", () => {
    const refusals = createRedirectRefusals();
    expect(refusals.matches(7, TARGET)).toBe(false);
    expect(refusals.matches(7, undefined)).toBe(false);
  });

  // Failure: a failure of another address reads as the refused redirect, hiding the real error.
  it("does not match a different address", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    expect(refusals.matches(7, "https://other.example.com/")).toBe(false);
  });

  // Failure: a refusal in one view is shown in the other view.
  it("does not match in another view", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    expect(refusals.matches(9, TARGET)).toBe(false);
  });

  // Failure: a refusal outlives the navigation that caused it, so a later outage of the same address reads as a refused redirect.
  it("is superseded by a navigation that starts in the same view", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    refusals.navigationStarted(7);
    expect(refusals.matches(7, TARGET)).toBe(false);
  });

  // Failure: a navigation in one view clears the refusal of the other view.
  it("keeps another view's refusal when a navigation starts elsewhere", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    refusals.navigationStarted(9);
    expect(refusals.matches(7, TARGET)).toBe(true);
  });

  // Failure: the first failure event consumes the refusal, so a repeated event shows the generic error page over the refusal.
  it("keeps the refusal for a repeated failure of the same load", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    expect(refusals.matches(7, TARGET)).toBe(true);
    expect(refusals.matches(7, TARGET)).toBe(true);
  });

  // Failure: an earlier refusal survives a later one in the same view, so a failure of the earlier address reads as refused.
  it("replaces the earlier refusal in the same view", () => {
    const refusals = createRedirectRefusals();
    refusals.refuse(7, TARGET);
    refusals.refuse(7, "https://third.example.com/");
    expect(refusals.matches(7, TARGET)).toBe(false);
    expect(refusals.matches(7, "https://third.example.com/")).toBe(true);
  });
});
