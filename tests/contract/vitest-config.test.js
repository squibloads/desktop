import { describe, it, expect, vi } from "vitest";
import config, { tierGlobs } from "../../vitest.config.mjs";
import { OrderedRandomSequencer } from "../helpers/ordered-random-sequencer.mjs";

// A seed that is silently ignored makes a replay run in a different order from
// the one the operator asked for, so the config must refuse it.
describe("vitest.config.mjs seed handling", () => {
  it("rejects VITEST_SEED when VITEST_SHUFFLE is not 1", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "42");
    expect(() => config()).toThrow("VITEST_SEED requires VITEST_SHUFFLE=1");
  });

  it("accepts an empty VITEST_SEED when shuffle is off", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "");
    expect(() => config()).not.toThrow();
  });
});

// Vitest's default sequencer orders files by project discovery timing, so a
// fixed seed would not replay the same file order. The repo sequencer is used
// on every project when shuffling, and the default is left alone otherwise.
describe("vitest.config.mjs sequencer", () => {
  it("uses the ordered sequencer on the root and every project when shuffling", () => {
    // config() prints the seed line when shuffling; keep it out of the test output.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("VITEST_SHUFFLE", "1");
    vi.stubEnv("VITEST_SEED", "123");
    const { test } = config();
    expect(test.sequence.sequencer).toBe(OrderedRandomSequencer);
    expect(test.projects.length).toBeGreaterThan(0);
    expect(test.projects.every((p) => p.test.sequence.sequencer === OrderedRandomSequencer)).toBe(true);
  });

  it("leaves the default sequencer in place when not shuffling", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "");
    const { test } = config();
    expect(test.sequence.sequencer).toBeUndefined();
  });
});

// An exported smoke-tier override on the developer's machine must not change a unit result,
// so the root and every project clear both variables for their run.
describe("vitest.config.mjs hermetic env", () => {
  // Failure: an exported TURNSTONE_PODMAN or TURNSTONE_LOCAL_CONSOLE_URL changes which binary or console the tests use, so the same suite passes or fails by the shell's state.
  it("clears both smoke-tier overrides on the root and on each of the three projects", () => {
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "");
    vi.stubEnv("TURNSTONE_E2E", "");
    const { test } = config();
    const cleared = { TURNSTONE_PODMAN: "", TURNSTONE_LOCAL_CONSOLE_URL: "" };

    expect(test.env).toEqual(cleared);
    expect(test.projects.map((p) => p.test.env)).toEqual([cleared, cleared, cleared]);
  });
});

// The e2e project opens Electron windows, so it must exist only when the run asks for it.
describe("vitest.config.mjs e2e project", () => {
  function projectNames() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("VITEST_SHUFFLE", "0");
    vi.stubEnv("VITEST_SEED", "");
    return config().test.projects.map((p) => p.test.name);
  }

  function e2eProject() {
    return config().test.projects.find((p) => p.test.name === "e2e").test;
  }

  it("lists the e2e tier in tierGlobs", () => {
    expect(tierGlobs.e2e).toBe("tests/e2e/**/*.test.js");
  });

  // Failure: a plain npx vitest run opens Electron windows on a developer machine or in the default CI jobs.
  it("has no e2e project when TURNSTONE_E2E is unset or not exactly 1", () => {
    vi.stubEnv("TURNSTONE_E2E", "");
    expect(projectNames()).toEqual(["unit", "contract", "renderer"]);
    vi.stubEnv("TURNSTONE_E2E", "true");
    expect(projectNames()).toEqual(["unit", "contract", "renderer"]);
  });

  // Failure: the smoke command runs without its project, so it passes having run zero Electron tests.
  it("has the e2e project, after the other three, when TURNSTONE_E2E is 1", () => {
    vi.stubEnv("TURNSTONE_E2E", "1");
    expect(projectNames()).toEqual(["unit", "contract", "renderer", "e2e"]);
  });

  // Failure: the Electron launch hits the default 10 s test timeout on a loaded runner and the smoke tier reports a broken app.
  it("gives the e2e project the launch timeouts, its glob, and the setup check", () => {
    vi.stubEnv("TURNSTONE_E2E", "1");
    vi.stubEnv("VITEST_MAX_WORKERS", "16");
    const e2e = e2eProject();
    expect(e2e.include).toEqual(["tests/e2e/**/*.test.js"]);
    expect(e2e.testTimeout).toBe(90000);
    expect(e2e.hookTimeout).toBe(60000);
    expect(e2e.setupFiles).toHaveLength(1);
    expect(e2e.setupFiles[0].split(String.fromCharCode(92)).join("/").endsWith("/tests/helpers/e2e-setup.js")).toBe(true);
    expect(e2e.env).toEqual({ TURNSTONE_PODMAN: "", TURNSTONE_LOCAL_CONSOLE_URL: "" });
  });

  // Failure: a run that asks for one worker still runs three Electron apps at once, which makes the smoke tier flaky on a small runner.
  it("caps the e2e project at three workers and never raises a lower configured count", () => {
    vi.stubEnv("TURNSTONE_E2E", "1");
    vi.stubEnv("VITEST_MAX_WORKERS", "16");
    expect(e2eProject().maxWorkers).toBe(3);
    vi.stubEnv("VITEST_MAX_WORKERS", "1");
    expect(e2eProject().maxWorkers).toBe(1);
  });
});
