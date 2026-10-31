// Checks the build `electron-forge package` or `make` left in Forge's output folder, on the OS that built it. The
// release workflow runs it before uploading anything (npm run test:packaged). It fails, exit code 1, when:
// - a fuse forge.config.js sets is not set in the binary;
// - the packaged build, started with each switch in CHECKED_SWITCHES, never reaches the local server, or shows any
//   effect of a switch;
// - an unpackaged control started the same way does not show every effect, which means a probe is blind on this
//   runner.
// Each run uses a throwaway profile whose Server view and health poll go to a local self-signed HTTPS server. On Linux
// both runs get --no-sandbox, as the smoke tier does on CI.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKED_SWITCHES, controlRunDone, fuseMismatches, judge, packagedApp, packagedRunDone } from "./packaged-build.mjs";
import { selfSignedCert } from "./self-signed-cert.js";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../..", import.meta.url));
const { getCurrentFuseWire } = require("@electron/fuses");
const forge = require(join(root, "forge.config.js"));

// A run lasts until its target is met (packagedRunDone or controlRunDone), then SETTLE_MS more, so a late effect can
// still show; or until CAP_MS, for a slow start. The packaged run is judged on what it showed by then.
const CAP_MS = 60000;
const SETTLE_MS = 3000;
const POLL_MS = 500;
// The variables that would change what a run shows: SSLKEYLOGFILE writes keys whatever the switches say.
const CLEARED_ENV = ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "SSLKEYLOGFILE", "TURNSTONE_PODMAN", "TURNSTONE_LOCAL_CONSOLE_URL"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// A port nothing listens on at the moment of asking.
async function freePort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// Ends the process and everything it started: Chromium's helpers would otherwise outlive it and hold the profile.
function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// Whether Chromium's DevTools server answers on port: a 200 naming the browser, not just any listener there.
async function devtoolsAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    const body = await response.json();
    return typeof body.Browser === "string";
  } catch {
    return false;
  }
}

const written = (file) => existsSync(file) && statSync(file).size > 0;

// One run of command with args, every switch in CHECKED_SWITCHES and a profile that opens the Server view at site,
// until done(state) holds or CAP_MS passes.
async function run(label, command, args, { scratch, site, counter, done }) {
  const profile = mkdtempSync(join(scratch, `${label}-profile-`));
  writeFileSync(join(profile, "turnstone-desktop.json"), JSON.stringify({ hasLaunched: true, mode: "server", serverUrl: site }));
  const netLog = join(scratch, `${label}-net-log.json`);
  const keyLog = join(scratch, `${label}-key-log.txt`);
  const port = await freePort();
  const switches = {
    "remote-debugging-port": `--remote-debugging-port=${port}`,
    "log-net-log": `--log-net-log=${netLog}`,
    "ssl-key-log-file": `--ssl-key-log-file=${keyLog}`,
    "ignore-certificate-errors": "--ignore-certificate-errors",
  };
  const env = { ...process.env };
  for (const name of CLEARED_ENV) delete env[name];
  const start = { requests: counter.requests, connections: counter.connections };
  const startedAt = Date.now();
  const child = spawn(
    command,
    [
      ...args,
      ...CHECKED_SWITCHES.map((name) => switches[name]),
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${profile}`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exit = null;
  const exited = new Promise((settle) => child.once("exit", (code, signal) => settle((exit = { code, signal }))));
  child.once("error", (err) => (exit = { error: err.message }));

  const state = { connections: 0, devtoolsAnswered: false, netLogWritten: false, keyLogWritten: false, requestsReached: 0 };
  const measure = () => {
    state.netLogWritten = written(netLog);
    state.keyLogWritten = written(keyLog);
    state.requestsReached = counter.requests - start.requests;
    state.connections = counter.connections - start.connections;
  };
  let doneAt = null;
  while (exit === null && Date.now() - startedAt < CAP_MS) {
    if (await devtoolsAnswers(port)) state.devtoolsAnswered = true;
    measure();
    if (doneAt === null && done(state)) doneAt = Date.now();
    if (doneAt !== null && Date.now() - doneAt >= SETTLE_MS) break;
    await sleep(POLL_MS);
  }
  const running = exit === null;
  measure();
  killTree(child);
  await Promise.race([exited, sleep(10000)]);
  // A helper the kill missed could hold the pipes open and keep this process from exiting.
  child.stdout.destroy();
  child.stderr.destroy();

  return {
    running,
    // Only an exit of its own: one after the kill is the kill's.
    exitBeforeEnd: running ? null : exit,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    reachedTarget: doneAt !== null,
    ...state,
    ignored: [...output.matchAll(/Ignored --([a-z-]+): a packaged build does not accept it\./g)].map((match) => match[1]),
    output: output.slice(-2000),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "turnstone-packaged-check-"));
const counter = { requests: 0, connections: 0 };
const { cert, key } = selfSignedCert();
const server = https.createServer({ cert, key }, (request, response) => {
  counter.requests += 1;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok", nodes: 1, workstreams: 0 }));
});
// Every TCP connection counts, refused certificate or not: it shows the app got as far as opening one.
server.on("connection", () => {
  counter.connections += 1;
});
// A refused certificate ends the handshake with an error on the server side too; that is the expected outcome.
server.on("tlsClientError", () => {});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const site = `https://127.0.0.1:${server.address().port}`;

let report;
try {
  const app = packagedApp(resolve(root, forge.outDir ?? "out"), {
    platform: process.platform,
    arch: process.arch,
    executableName: forge.packagerConfig.executableName,
  });
  const fuseEntry = forge.plugins.filter((plugin) => plugin.name === "@electron-forge/plugin-fuses");
  if (fuseEntry.length !== 1) throw new Error(`expected one fuses plugin entry in forge.config.js, found ${fuseEntry.length}`);
  const fuses = fuseMismatches(await getCurrentFuseWire(app.fuses), fuseEntry[0].config);
  const packaged = await run("packaged", app.launch, [], { scratch, site, counter, done: packagedRunDone });
  const control = await run("control", require("electron"), [root], { scratch, site, counter, done: controlRunDone });
  const failures = [...fuses.map((mismatch) => `fuses: ${mismatch}`), ...judge({ packaged, control })];
  report = { app, failures, packaged, control };
} finally {
  server.closeAllConnections();
  server.close();
}

// The report comes first: a cleanup that fails, as a file Windows still holds can, must not hide the result.
console.log(JSON.stringify(report, null, 2));
if (report.failures.length > 0) {
  console.error(`Packaged build check failed:\n- ${report.failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Packaged build check passed: fuses as forge.config.js sets them; ${CHECKED_SWITCHES.map((name) => `--${name}`).join(", ")} dropped.`);
}
try {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (err) {
  console.warn(`Could not remove ${scratch}: ${err.message}`);
}
