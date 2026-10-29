import { vi } from "vitest";

// Fixed origin, so nothing in a failure message depends on the wall clock.
const BASE_MS = 1_700_000_000_000;

/**
 * Replaces Date.now with a counter that advances by `step` ms on every read.
 *
 * The code under test computes deadlines from Date.now(). On the real clock a
 * deadline expires after a load-dependent number of polls, so a test that
 * counts polls flakes. Here a loop that reads the clock once per pass with a
 * timeout of N * step ms makes exactly N polls before the deadline. Callers
 * assert that count.
 *
 * vi.spyOn is restored by the `restoreMocks` option in vitest.config.mjs.
 */
export function installSteppedClock({ step = 1 } = {}) {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`installSteppedClock: step must be a positive integer, got ${step}`);
  }
  let now = BASE_MS;
  const spy = vi.spyOn(Date, "now");
  spy.mockImplementation(() => {
    const current = now;
    now += step;
    return current;
  });
  return spy;
}
