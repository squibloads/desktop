// The pure half of check-packaged-build.mjs: where a packaged build is, whether its fuses match forge.config.js, and
// what its run and the control's say. tests/contract/packaged-build-check.test.js covers each.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const require = createRequire(import.meta.url);
const { FuseV1Options } = require("@electron/fuses");
// The package does not re-export its fuse states; it has no exports map, so its constants file can be loaded directly.
const { FuseState } = require("@electron/fuses/dist/constants");

// The dropped switches the check starts the build with, in the order debug-switches.js lists them. Each needs its own
// probe; --remote-debugging-pipe and --ignore-certificate-errors-spki-list go through the same drop and are left to
// the unit tier.
export const CHECKED_SWITCHES = ["remote-debugging-port", "log-net-log", "ssl-key-log-file", "ignore-certificate-errors"];

// The file to launch and the path @electron/fuses reads, for the one build `electron-forge package` or `make` left in
// outDir for this platform and architecture, in a folder named <name>-<platform>-<arch>. On macOS the fuses sit in
// the Electron Framework, which @electron/fuses finds from the bundle.
export function packagedApp(outDir, { platform, arch, executableName }) {
  const suffix = `-${platform}-${arch}`;
  const dirs = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => join(outDir, entry.name));
  if (dirs.length === 0) throw new Error(`no packaged build for ${platform}-${arch} in ${outDir}`);
  if (dirs.length > 1) throw new Error(`${dirs.length} packaged builds for ${platform}-${arch} in ${outDir}: ${dirs.join(", ")}`);
  const [dir] = dirs;
  if (platform === "darwin") {
    const bundles = readdirSync(dir).filter((name) => name.endsWith(".app"));
    if (bundles.length !== 1) throw new Error(`expected one .app in ${dir}, found ${bundles.length}`);
    const bundle = join(dir, bundles[0]);
    const launch = join(bundle, "Contents", "MacOS", executableName);
    if (!existsSync(launch)) throw new Error(`no ${executableName} in ${join(bundle, "Contents", "MacOS")}`);
    return { launch, fuses: bundle };
  }
  const launch = join(dir, platform === "win32" ? `${executableName}.exe` : executableName);
  if (!existsSync(launch)) throw new Error(`no ${basename(launch)} in ${dir}`);
  return { launch, fuses: launch };
}

const STATE_NAMES = {
  [FuseState.ENABLE]: "on",
  [FuseState.DISABLE]: "off",
  [FuseState.REMOVED]: "removed",
  [FuseState.INHERIT]: "inherit",
};

// Each fuse the plugin config sets that the binary's wire does not match, as "<fuse>: expected on, found off". The
// fuses the config leaves alone are not compared: their state is Electron's choice. A wire of another version is
// refused whole, since its fuses sit at other places.
export function fuseMismatches(wire, config) {
  if (String(wire.version) !== String(config.version)) {
    return [`fuse wire version: expected ${config.version}, found ${wire.version}`];
  }
  const mismatches = [];
  for (const [key, wanted] of Object.entries(config)) {
    if (!/^\d+$/.test(key)) continue;
    const expected = wanted ? "on" : "off";
    const found = wire[key] === undefined ? "missing" : STATE_NAMES[wire[key]] ?? `state ${wire[key]}`;
    if (found !== expected) mismatches.push(`${FuseV1Options[key]}: expected ${expected}, found ${found}`);
  }
  return mismatches;
}

// When a packaged run has shown enough to judge: two connections to the server, from the Server view and the health
// poll. By then the DevTools server and the net log would have started, and a handshake would have logged its keys
// and, under --ignore-certificate-errors, become a request.
export function packagedRunDone(state) {
  return state.connections >= 2;
}

// When the control run has shown every effect, so each probe is known to see its switch on this runner.
export function controlRunDone(state) {
  return state.devtoolsAnswered && state.netLogWritten && state.keyLogWritten && state.requestsReached >= 1;
}

// What is wrong with a run of the packaged build beside an unpackaged control, both started with the switches in
// CHECKED_SWITCHES. The packaged build must keep running, connect to the server, log each switch as ignored and show
// no effect of any. Running is not enough on its own: Electron keeps a main process that threw alive behind an error
// dialog, logging and connecting nothing after the throw. The control keeps every switch, so it must show each effect:
// if it does not, the probe for that switch is blind on this runner and would pass a build that keeps it.
export function judge({ packaged, control }) {
  const failures = [];
  if (!packaged.running) failures.push("packaged build: exited before the end of the run");
  if (!(packaged.connections >= 1)) {
    failures.push("packaged build: never connected to the self-signed server, so the certificate and key-log probes saw nothing");
  }
  if (packaged.devtoolsAnswered) failures.push("packaged build: DevTools answered on --remote-debugging-port");
  if (packaged.netLogWritten) failures.push("packaged build: --log-net-log wrote its file");
  if (packaged.keyLogWritten) failures.push("packaged build: --ssl-key-log-file wrote its file");
  if (packaged.requestsReached > 0) {
    const n = packaged.requestsReached;
    failures.push(`packaged build: ${n} request${n === 1 ? "" : "s"} reached the self-signed server under --ignore-certificate-errors`);
  }
  const unlogged = CHECKED_SWITCHES.filter((name) => !packaged.ignored.includes(name));
  if (unlogged.length > 0) {
    failures.push(`packaged build: did not log ignoring ${unlogged.map((name) => `--${name}`).join(", ")}`);
  }
  if (!control.running) failures.push("control: exited before the end of the run");
  if (!control.devtoolsAnswered) failures.push("control: DevTools never answered, so the port probe sees nothing");
  if (!control.netLogWritten) failures.push("control: --log-net-log wrote nothing, so the file probe sees nothing");
  if (!control.keyLogWritten) failures.push("control: --ssl-key-log-file wrote nothing, so no TLS handshake took place");
  if (!(control.requestsReached > 0)) {
    failures.push("control: no request reached the self-signed server, so the certificate probe sees nothing");
  }
  return failures;
}
