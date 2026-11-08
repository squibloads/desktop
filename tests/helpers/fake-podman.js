// Stands in for the podman binary. It implements only the ten calls local-runtime.js makes,
// each matched as its exact argv, and keeps the machine and pod state in a JSON file so a test
// can change them while the app is running.
//
// The app runs it as `node fake-podman.js <args>`, because TURNSTONE_PODMAN is a JSON array that
// names this file. Environment variables:
//   FAKE_PODMAN_STATE          state file: { machine, pod, failStart, failStop, failInit, hardening, podmanVersion }
//   FAKE_PODMAN_LOG            receives one line per call, the arguments joined with spaces
//   FAKE_PODMAN_STOP_DELAY_MS  optional, default 0: `pod stop` takes this long, then logs `pod stop done`
//
// machine:   "running" | "stopped" | "missing" | "list-fails"
// pod:       "Running" | "Exited" | "missing"
// hardening: "ok" (the default when absent) | "gap" | "fails". The machine check run as root answers
//            a hardened machine, a machine whose user has passwordless sudo, or exits 1. The script it
//            is given is not run: machine-hardening.test.js and a real machine cover what it does.
// failStart makes `machine start` and `pod start` exit 1; failStop does the same for `pod stop`.
// failInit makes `machine init` exit 1 after leaving a half-made machine, as an interrupted create can.
// podmanVersion is what `version` reports, "6.1.4" when absent.
//
// Any other call exits 1, so a new podman call in the app fails the test that makes it instead of
// passing silently.
//
// Node runs this file directly, so it stays CommonJS with no dependencies.

const fs = require("fs");

const MACHINE = "turnstone";
const POD = "turnstone";
const CONNECTION = "turnstone";

// The ten calls, as the argv local-runtime.js passes them. Matched element by element, so the same
// words split differently are not one of these calls. The machine check is this prefix and then
// exactly one argument, the encoded script.
const VERSION = ["version", "--format", "{{.Client.Version}}"];
const MACHINE_INIT = ["machine", "init", MACHINE, "--username", "user"];
const MACHINE_RM = ["machine", "rm", "--force", MACHINE];
const MACHINE_LIST = ["machine", "list", "--format", "json"];
const MACHINE_START = ["machine", "start", MACHINE];
const MACHINE_STOP = ["machine", "stop", MACHINE];
const MACHINE_CHECK = ["machine", "ssh", "--username", "root", MACHINE];
const HARDENING_REPORTS = {
  ok: "wslconf=ok\nsudo=refused\nend=ok\n",
  gap: "wslconf=ok\nsudo=allowed\nend=ok\n",
};
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

if (sameArgv(args, VERSION)) {
  console.log(state.podmanVersion ?? "6.1.4");
} else if (sameArgv(args, MACHINE_INIT)) {
  if (state.machine !== "missing") fail(`Error: machine "${MACHINE}" already exists`);
  state.machine = "stopped";
  save();
  if (state.failInit) fail("Error: could not download the machine image: connection reset");
  console.log(`Machine init complete`);
} else if (sameArgv(args, MACHINE_RM)) {
  state.machine = "missing";
  save();
  console.log(`Machine "${MACHINE}" removed`);
} else if (sameArgv(args, MACHINE_LIST)) {
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
} else if (sameArgv(args, MACHINE_STOP)) {
  if (state.machine === "missing") fail(`Error: machine ${MACHINE} does not exist`);
  state.machine = "stopped";
  save();
  console.log(`Machine "${MACHINE}" stopped successfully`);
} else if (args.length === MACHINE_CHECK.length + 1 && sameArgv(args.slice(0, -1), MACHINE_CHECK)) {
  const hardening = state.hardening ?? "ok";
  if (hardening === "fails") fail("Error: ssh: connect to host localhost: Connection refused");
  if (!(hardening in HARDENING_REPORTS)) fail(`fake-podman: unknown hardening state "${hardening}"`);
  process.stdout.write(HARDENING_REPORTS[hardening]);
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
