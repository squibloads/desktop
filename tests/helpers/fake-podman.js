// Stands in for the podman binary. It implements only the five calls local-runtime.js makes,
// each matched as its exact argv, and keeps the machine and pod state in a JSON file so a test
// can change them while the app is running.
//
// The app runs it as `node fake-podman.js <args>`, because TURNSTONE_PODMAN is a JSON array that
// names this file. Environment variables:
//   FAKE_PODMAN_STATE          state file: { machine, pod, failStart, failStop }
//   FAKE_PODMAN_LOG            receives one line per call, the arguments joined with spaces
//   FAKE_PODMAN_STOP_DELAY_MS  optional, default 0: `pod stop` takes this long, then logs `pod stop done`
//
// machine: "running" | "stopped" | "missing" | "list-fails"
// pod:     "Running" | "Exited" | "missing"
// failStart makes `machine start` and `pod start` exit 1; failStop does the same for `pod stop`.
//
// Any other call exits 1, so a new podman call in the app fails the test that makes it instead of
// passing silently.
//
// Node runs this file directly, so it stays CommonJS with no dependencies.

const fs = require("fs");

const MACHINE = "turnstone";
const POD = "turnstone";
const CONNECTION = "turnstone";

// The five calls, as the argv local-runtime.js passes them. Matched element by element, so the same
// words split differently are not one of these calls.
const MACHINE_LIST = ["machine", "list", "--format", "json"];
const MACHINE_START = ["machine", "start", MACHINE];
const POD_INSPECT = ["--connection", CONNECTION, "pod", "inspect", POD, "--format", "{{.State}}"];
const POD_START = ["--connection", CONNECTION, "pod", "start", POD];
const POD_STOP = ["--connection", CONNECTION, "pod", "stop", POD];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sameArgv(actual, expected) {
  return actual.length === expected.length && expected.every((arg, i) => actual[i] === arg);
}

// Blocks this process without a timer: podman taking time to stop the pod is modelled by a plain wait.
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopDelayMs() {
  const raw = process.env.FAKE_PODMAN_STOP_DELAY_MS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`fake-podman: FAKE_PODMAN_STOP_DELAY_MS must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

const args = process.argv.slice(2);
const line = args.join(" ");
// Logged before anything else, so a failing or unknown call still shows up in the log.
fs.appendFileSync(process.env.FAKE_PODMAN_LOG, `${line}\n`);

const statePath = process.env.FAKE_PODMAN_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

function save() {
  fs.writeFileSync(statePath, JSON.stringify(state));
}

if (sameArgv(args, MACHINE_LIST)) {
  if (state.machine === "list-fails") fail("Error: machine list unavailable");
  const machines =
    state.machine === "missing" ? [] : [{ Name: MACHINE, Running: state.machine === "running" }];
  console.log(JSON.stringify(machines));
} else if (sameArgv(args, MACHINE_START)) {
  if (state.failStart) fail("Error: machine start failed");
  if (state.machine === "missing") fail(`Error: machine ${MACHINE} does not exist`);
  state.machine = "running";
  save();
  console.log(`Starting machine "${MACHINE}"`);
} else if (sameArgv(args, POD_INSPECT)) {
  if (state.pod === "missing") fail(`Error: no such pod ${POD}`);
  console.log(state.pod);
} else if (sameArgv(args, POD_START)) {
  if (state.failStart) fail("Error: pod start failed");
  if (state.pod === "missing") fail(`Error: no such pod ${POD}`);
  state.pod = "Running";
  save();
  console.log(POD);
} else if (sameArgv(args, POD_STOP)) {
  if (state.failStop) fail("Error: pod stop failed");
  if (state.pod === "missing") fail(`Error: no such pod ${POD}`);
  sleepSync(stopDelayMs());
  state.pod = "Exited";
  save();
  // Written after the state change and before exit, so a test that waits for the app to quit can
  // see that the stop finished, not only that it started.
  fs.appendFileSync(process.env.FAKE_PODMAN_LOG, "pod stop done\n");
  console.log(POD);
} else {
  fail(`fake-podman: unexpected call: ${line}`);
}
