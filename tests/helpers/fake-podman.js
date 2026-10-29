// Stands in for the podman binary. It implements only the calls local-runtime.js
// makes, and keeps the machine and pod state in a JSON file so a test can change
// them while the app is running.
//
// The app runs it as `node fake-podman.js <args>`, because TURNSTONE_PODMAN is a
// JSON array that names this file. Two environment variables are required:
//   FAKE_PODMAN_STATE  state file: { machine, pod, failStart, failStop }
//   FAKE_PODMAN_LOG    receives one line per call, the arguments joined with spaces
//
// machine: "running" | "stopped" | "missing" | "list-fails"
// pod:     "Running" | "Exited" | "missing"
// failStart makes `machine start` and `pod start` exit 1; failStop does the same for `pod stop`.
//
// Node runs this file directly, so it stays CommonJS with no dependencies.

const fs = require("fs");

const MACHINE = "turnstone";
const POD = "turnstone";

function fail(message) {
  console.error(message);
  process.exit(1);
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

// local-runtime.js puts --connection turnstone before pod subcommands; machine calls have none.
const podCall = args[0] === "--connection" && args[1] === "turnstone" ? args.slice(2).join(" ") : null;

if (line === "machine list --format json") {
  if (state.machine === "list-fails") fail("Error: machine list unavailable");
  const machines =
    state.machine === "missing" ? [] : [{ Name: MACHINE, Running: state.machine === "running" }];
  console.log(JSON.stringify(machines));
} else if (line === `machine start ${MACHINE}`) {
  if (state.failStart) fail("Error: machine start failed");
  if (state.machine === "missing") fail(`Error: machine ${MACHINE} does not exist`);
  state.machine = "running";
  save();
  console.log(`Starting machine "${MACHINE}"`);
} else if (podCall === `pod inspect ${POD} --format {{.State}}`) {
  if (state.pod === "missing") fail(`Error: no such pod ${POD}`);
  console.log(state.pod);
} else if (podCall === `pod start ${POD}`) {
  if (state.failStart) fail("Error: pod start failed");
  if (state.pod === "missing") fail(`Error: no such pod ${POD}`);
  state.pod = "Running";
  save();
  console.log(POD);
} else if (podCall === `pod stop ${POD}`) {
  if (state.failStop) fail("Error: pod stop failed");
  if (state.pod === "missing") fail(`Error: no such pod ${POD}`);
  state.pod = "Exited";
  save();
  console.log(POD);
} else {
  fail(`fake-podman: unexpected call: ${line}`);
}
