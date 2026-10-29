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

// The first capture group of `pattern` in `text`. A missing match fails with `what` named,
// so a refactor that moves or rewords the text is reported by name, not as a TypeError.
function capture(pattern, text, what) {
  const m = pattern.exec(text);
  expect(m, `${what} was not found`).not.toBeNull();
  return m[1];
}

// The default for a key in the electron-store schema, read from the source text.
// A regex is used because settings-store.js does not export its schema.
function schemaDefault(key) {
  return capture(new RegExp(`\\b${key}: \\{[^}]*?default: "([^"]*)"`), settingsStore, `schema default for ${key}`);
}

// The first capture group of a README pattern.
function readmeMatch(pattern) {
  return capture(pattern, readme, `README.md match for ${pattern}`);
}

// The numeric default of a constructor parameter in local-runtime.js.
function runtimeDefault(name) {
  return Number(capture(new RegExp(`\\b${name} = (\\d+)`), localRuntime, `${name} default in local-runtime.js`));
}

// Every AbortSignal.timeout(N) argument in a source file, in order.
function abortTimeouts(source) {
  return [...source.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]));
}

// Each row of the README mode table as { mode, notifications }. The table starts at its header
// and ends at the first line that is not a table row.
function modeNotifications(text) {
  const start = text.indexOf("| Mode | What the window shows");
  if (start === -1) return [];
  const rows = [];
  for (const line of text.slice(start).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim());
    rows.push({ mode: cells[1].replace(/\*\*/g, ""), notifications: cells[4] });
  }
  return rows;
}

// The README mode labels and the settings-store mode values they stand for.
const MODE_KEYS = {
  "Server Only": "server",
  "Console Only": "console",
  Both: "both",
  Local: "local",
};

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
    const constant = capture(/const LOCAL_CONSOLE_URL = "([^"]*)"/, settingsStore, "LOCAL_CONSOLE_URL");
    const healthDefault = capture(/healthUrl = "([^"]*)"/, localRuntime, "healthUrl default");
    const readmeAddresses = [...readme.matchAll(/https?:\/\/127\.0\.0\.1:\d+/g)].map((m) => m[0]);
    const mismatched = readmeAddresses.filter((address) => address !== "http://127.0.0.1:8090");

    expect(constant).toEqual("http://127.0.0.1:8090");
    expect(healthDefault).toEqual("http://127.0.0.1:8090");
    expect(readmeAddresses.length > 0).toBe(true);
    expect(mismatched).toEqual([]);
  });

  // Failure: the README's Notifications column disagrees with settings.hasServer, so a mode is documented as silent while the app notifies in it, or the reverse.
  it("the Notifications column matches the modes for which settings.hasServer is true", () => {
    const hasServerBody = capture(/get hasServer\(\) \{\s*return ([^;]+);/, settingsStore, "get hasServer() body");
    const serverModes = [...hasServerBody.matchAll(/this\.mode === "(\w+)"/g)].map((m) => m[1]);
    const actual = Object.fromEntries(modeNotifications(readme).map((r) => [r.mode, r.notifications]));
    const expected = Object.fromEntries(
      Object.entries(MODE_KEYS).map(([label, key]) => [label, serverModes.includes(key) ? "Yes" : "No"]),
    );

    expect(serverModes).toEqual(["server", "both"]);
    expect(actual.Local).toEqual("No");
    expect(actual).toEqual(expected);
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

  // Failure: the README says the app checks once a second, but the poll interval in code changes, so the documented wait is wrong.
  it("the README's once-a-second wording matches healthIntervalMs 1000", () => {
    const sentence = readmeMatch(/(The app checks once a second until a node is registered)/);
    const codeMs = runtimeDefault("healthIntervalMs");

    expect(/once a second/.test(sentence)).toBe(true);
    expect(codeMs).toEqual(1000);
  });

  // Failure: the README says each service is checked every 5 seconds, but the status poller runs at another interval, so the health dots lag or flicker.
  // The poller's interval is in src/main/health.js, not main.js.
  it("the README health poll of every 5 seconds equals the HealthPoller interval 5000", () => {
    const readmeSeconds = readmeMatch(/The app checks each service every (\d+) seconds/);
    const codeMs = Number(capture(/setInterval\(\(\) => this\.poll\(\),\s*(\d+)\)/, healthJs, "HealthPoller setInterval"));

    expect(readmeSeconds).toEqual("5");
    expect(Number(readmeSeconds) * 1000).toEqual(codeMs);
    expect(codeMs).toEqual(5000);
  });

  // Failure: the README says a health check gives up after 3 seconds, but the status poll or the Local probe uses another limit, so a slow Console is shown as down in one place and up in another.
  it("the README's no-answer limit of 3 seconds equals the AbortSignal.timeout in health.js and local-runtime.js", () => {
    const readmeSeconds = readmeMatch(/no answer within (\d+) seconds/);
    const readmeMs = Number(readmeSeconds) * 1000;

    expect(readmeSeconds).toEqual("3");
    expect(readmeMs).toEqual(3000);
    expect(abortTimeouts(healthJs)).toEqual([3000]);
    expect(abortTimeouts(localRuntime)).toEqual([3000]);
  });

  // Failure: the README says quitting can wait 2 minutes for the pod to stop, but the stop call is cut off at a different time, or the stop does not go through the runner that has the timeout.
  it("the quit wait of up to 2 minutes equals the podman timeout 120000 on the pod stop path", () => {
    const readmeMinutes = readmeMatch(/Quit can wait up to (\d+) minutes while the pod stops/);
    const codeMs = Number(capture(/\{ windowsHide: true, timeout: (\d+) \}/, localRuntime, "podman runner timeout"));
    const stopUsesRunner = /this\._podman\(podArgs\(\["pod", "stop", POD\]\)/.test(localRuntime);
    const runnerDefault = /run = runPodman,/.test(localRuntime);

    expect(readmeMinutes).toEqual("2");
    expect(Number(readmeMinutes) * 60000).toEqual(codeMs);
    expect(codeMs).toEqual(120000);
    expect(stopUsesRunner).toBe(true);
    expect(runnerDefault).toBe(true);
  });

  // Failure: the podman names differ between the constants and the README, so the manual fix the README gives targets a machine, pod or connection the app does not use.
  it("MACHINE, POD and PODMAN_CONNECTION are all turnstone, and the README commands match the args the app builds", () => {
    const names = {
      MACHINE: capture(/const MACHINE = "([^"]*)"/, localRuntime, "MACHINE constant"),
      POD: capture(/const POD = "([^"]*)"/, localRuntime, "POD constant"),
      PODMAN_CONNECTION: capture(/const PODMAN_CONNECTION = "([^"]*)"/, localRuntime, "PODMAN_CONNECTION constant"),
    };
    const shapes = [
      /this\._podman\(\["machine", "start", MACHINE\]/.test(localRuntime),
      /podArgs\(\["pod", "start", POD\]\)/.test(localRuntime),
      /podArgs\(\["pod", "stop", POD\]\)/.test(localRuntime),
      /return \["--connection", PODMAN_CONNECTION, \.\.\.args\];/.test(localRuntime),
    ];
    const built = [
      ["podman", "machine", "start", names.MACHINE].join(" "),
      ["podman", "--connection", names.PODMAN_CONNECTION, "pod", "start", names.POD].join(" "),
      ["podman", "--connection", names.PODMAN_CONNECTION, "pod", "stop", names.POD].join(" "),
    ];
    const missingFromReadme = built.filter((command) => !readme.includes(command));

    expect(names).toEqual({ MACHINE: "turnstone", POD: "turnstone", PODMAN_CONNECTION: "turnstone" });
    expect(shapes).toEqual([true, true, true, true]);
    expect(built).toEqual([
      "podman machine start turnstone",
      "podman --connection turnstone pod start turnstone",
      "podman --connection turnstone pod stop turnstone",
    ]);
    expect(missingFromReadme).toEqual([]);
  });

  // Failure: the regexes used above match nothing on a sample, so a README or source edit that breaks them goes unnoticed.
  it("detector control: the schema, README and timing extractors read a known sample", () => {
    const schemaSample = 'const schema = {\n  mode: { type: "string", default: "both" }, // x\n  quitBehavior: { type: "string", enum: ["stop", "keep"], default: "stop" },\n};';
    const readmeSample = "The app checks once a second until a node is registered, for up to 3 minutes.";
    const runtimeSample = "    nodeTimeoutMs = 180000,\n    healthIntervalMs = 1000,";

    expect(capture(new RegExp(`\\bmode: \\{[^}]*?default: "([^"]*)"`), schemaSample, "mode sample")).toEqual("both");
    expect(capture(new RegExp(`\\bquitBehavior: \\{[^}]*?default: "([^"]*)"`), schemaSample, "quitBehavior sample")).toEqual("stop");
    expect(capture(/until a node is registered, for up to (\d+) minutes/, readmeSample, "README sample")).toEqual("3");
    expect(capture(/\bnodeTimeoutMs = (\d+)/, runtimeSample, "nodeTimeoutMs sample")).toEqual("180000");
    expect(capture(/\bhealthIntervalMs = (\d+)/, runtimeSample, "healthIntervalMs sample")).toEqual("1000");
  });

  // Failure: the 3-second and mode-table extractors match nothing on a sample, so a change to either source goes unnoticed.
  it("detector control: the timeout and mode-table extractors read a known sample", () => {
    const timeoutSample = "const a = await fetch(u, { signal: AbortSignal.timeout(3000) });\nconst b = AbortSignal.timeout(30000);";
    const modeSample = [
      "| Mode | What the window shows | Health dots | Notifications | Typical use |",
      "|---|---|---|---|---|",
      "| **Server Only** | Server view, no tabs | SRV | Yes | A single-node deployment |",
      "| **Local** | Console. | CON | No | Running Turnstone on this PC |",
      "",
      "| **Other** | x | y | Yes | z |",
    ].join("\n");

    expect(abortTimeouts(timeoutSample)).toEqual([3000, 30000]);
    expect(modeNotifications(modeSample)).toEqual([
      { mode: "Server Only", notifications: "Yes" },
      { mode: "Local", notifications: "No" },
    ]);
  });
});
