import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

const readme = read("README.md");
const settingsStore = read("src/main/settings-store.js");
const localRuntime = read("src/main/local-runtime.js");
const healthJs = read("src/main/health.js");

// The default for a key in the electron-store schema, read from the source text.
// A regex is used because settings-store.js does not export its schema.
function schemaDefault(key) {
  const m = new RegExp(`\\b${key}: \\{[^}]*?default: "([^"]*)"`).exec(settingsStore);
  return m ? m[1] : null;
}

// The first match of a README pattern, as its capture group, or null.
function readmeMatch(pattern) {
  const m = pattern.exec(readme);
  return m ? m[1] : null;
}

// The numeric default of a constructor parameter in local-runtime.js.
function runtimeDefault(name) {
  const m = new RegExp(`\\b${name} = (\\d+)`).exec(localRuntime);
  return m ? Number(m[1]) : null;
}

describe("README settings reference matches the code", () => {
  // Failure: a fresh install opens in a different mode than the README says, so the user sees the wrong views.
  it("Mode defaults to Both, which is schema mode both", () => {
    const readmeMode = readmeMatch(/^\| \*\*Mode\*\* \| ([^|]+?) \|/m);

    expect(readmeMode).toEqual("Both");
    expect(schemaDefault("mode")).toEqual("both");
  });

  // Failure: the Server URL default in the README differs from the one the app loads, so the Server view points at the wrong host.
  it("Server URL default equals the schema default", () => {
    const readmeServer = readmeMatch(/^\| \*\*Server URL\*\* \| `([^`]+)` \|/m);

    expect(readmeServer).toEqual("http://localhost:8080");
    expect(schemaDefault("serverUrl")).toEqual("http://localhost:8080");
  });

  // Failure: the Console URL default in the README differs from the one the app loads, so the Console view points at the wrong host.
  it("Console URL default equals the schema default", () => {
    const readmeConsole = readmeMatch(/^\| \*\*Console URL\*\* \| `([^`]+)` \|/m);

    expect(readmeConsole).toEqual("http://localhost:8090");
    expect(schemaDefault("consoleUrl")).toEqual("http://localhost:8090");
  });

  // Failure: the README says quit stops the pod by default, but the app leaves it running, or the reverse.
  it("When the app quits defaults to Stop Turnstone, which is schema quitBehavior stop", () => {
    const readmeQuit = readmeMatch(/^\| \*\*When the app quits\*\* \| ([^|]+?) \|/m);

    expect(readmeQuit).toEqual("Stop Turnstone");
    expect(schemaDefault("quitBehavior")).toEqual("stop");
  });

  // Failure: the README gives one Local Console address and the app uses another, so the Console opens on the wrong port.
  it("the Local Console address equals LOCAL_CONSOLE_URL and the local health default", () => {
    const constant = /const LOCAL_CONSOLE_URL = "([^"]*)"/.exec(settingsStore);
    const healthDefault = /healthUrl = "([^"]*)"/.exec(localRuntime);
    const readmeAddresses = [...readme.matchAll(/https?:\/\/127\.0\.0\.1:\d+/g)].map((m) => m[0]);
    const mismatched = readmeAddresses.filter((address) => address !== "http://127.0.0.1:8090");

    expect(constant[1]).toEqual("http://127.0.0.1:8090");
    expect(healthDefault[1]).toEqual("http://127.0.0.1:8090");
    expect(readmeAddresses.length > 0).toBe(true);
    expect(mismatched).toEqual([]);
  });
});

describe("README timing claims match the code", () => {
  // Failure: the README says startup waits 3 minutes for a node, but the app gives up sooner or later, and the Console opens at the wrong time.
  it("node wait up to 3 minutes equals nodeTimeoutMs 180000", () => {
    const readmeMinutes = readmeMatch(/until a node is registered, for up to (\d+) minutes/);
    const readmeMs = Number(readmeMinutes) * 60000;
    const codeMs = runtimeDefault("nodeTimeoutMs");

    expect(readmeMinutes).toEqual("3");
    expect(readmeMs).toEqual(codeMs);
    expect(codeMs).toEqual(180000);
  });

  // Failure: the README says the console wait is 2 minutes, but the app's health window is a different length, so the error page appears at the wrong time.
  it("console wait up to 2 minutes equals healthTimeoutMs 120000", () => {
    const readmeMinutes = readmeMatch(/checks `\/health` once a second for up to (\d+) minutes/);
    const readmeMs = Number(readmeMinutes) * 60000;
    const codeMs = runtimeDefault("healthTimeoutMs");

    expect(readmeMinutes).toEqual("2");
    expect(readmeMs).toEqual(codeMs);
    expect(codeMs).toEqual(120000);
  });

  // Failure: the README says the app checks once a second, but it polls at a different rate, so the wait is slower or faster than documented.
  it("the once-a-second checks equal healthIntervalMs 1000", () => {
    const readmeSeconds = /The app checks once a second until a node is registered/.test(readme) ? 1 : null;
    const codeMs = runtimeDefault("healthIntervalMs");

    expect(readmeSeconds).toEqual(1);
    expect(readmeSeconds * 1000).toEqual(codeMs);
    expect(codeMs).toEqual(1000);
  });

  // Failure: the README says each service is checked every 5 seconds, but the status poller runs at another interval, so the health dots lag or flicker.
  // The poller's interval is in src/main/health.js, not main.js.
  it("the README health poll of every 5 seconds equals the HealthPoller interval 5000", () => {
    const readmeSeconds = readmeMatch(/The app checks each service every (\d+) seconds/);
    const codeMs = Number(/setInterval\(\(\) => this\.poll\(\),\s*(\d+)\)/.exec(healthJs)[1]);

    expect(readmeSeconds).toEqual("5");
    expect(Number(readmeSeconds) * 1000).toEqual(codeMs);
    expect(codeMs).toEqual(5000);
  });

  // Failure: the README says quitting can wait 2 minutes for the pod to stop, but the stop call is cut off at a different time, or the stop does not go through the runner that has the timeout.
  it("the quit wait of up to 2 minutes equals the podman timeout 120000 on the pod stop path", () => {
    const readmeMinutes = readmeMatch(/Quit can wait up to (\d+) minutes while the pod stops/);
    const timeoutMatch = /\{ windowsHide: true, timeout: (\d+) \}/.exec(localRuntime);
    const codeMs = Number(timeoutMatch[1]);
    const stopUsesRunner = /this\._podman\(podArgs\(\["pod", "stop", POD\]\)/.test(localRuntime);
    const runnerDefault = /run = runPodman,/.test(localRuntime);

    expect(readmeMinutes).toEqual("2");
    expect(Number(readmeMinutes) * 60000).toEqual(codeMs);
    expect(codeMs).toEqual(120000);
    expect(stopUsesRunner).toBe(true);
    expect(runnerDefault).toBe(true);
  });

  // Failure: the regexes used above match nothing on a sample, so a README or source edit that breaks them goes unnoticed.
  it("detector control: the schema, README and timing extractors read a known sample", () => {
    const schemaSample = 'const schema = {\n  mode: { type: "string", default: "both" }, // x\n  quitBehavior: { type: "string", enum: ["stop", "keep"], default: "stop" },\n};';
    const readmeSample = "The app checks once a second until a node is registered, for up to 3 minutes.";
    const runtimeSample = "    nodeTimeoutMs = 180000,\n    healthIntervalMs = 1000,";

    expect(new RegExp(`\\bmode: \\{[^}]*?default: "([^"]*)"`).exec(schemaSample)[1]).toEqual("both");
    expect(new RegExp(`\\bquitBehavior: \\{[^}]*?default: "([^"]*)"`).exec(schemaSample)[1]).toEqual("stop");
    expect(/until a node is registered, for up to (\d+) minutes/.exec(readmeSample)[1]).toEqual("3");
    expect(/\bnodeTimeoutMs = (\d+)/.exec(runtimeSample)[1]).toEqual("180000");
    expect(/\bhealthIntervalMs = (\d+)/.exec(runtimeSample)[1]).toEqual("1000");
  });
});
