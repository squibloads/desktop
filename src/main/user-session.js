// The machine user's systemd session (#1690). Rootless Podman serves its API from that session, user@<uid>.service, and
// every pod call reaches it over ssh at /run/user/<uid>/podman/podman.sock. All WSL 2 distributions share one cgroup
// tree, so when another one already runs a session for the same UID (another Podman machine, whose user is also UID
// 1000, or a distribution with a newer systemd), the second session to start fails with "Failed to spawn executor:
// Device or resource busy" and the API never comes up (#1686). Once the other has stopped, a restart fixes it in place.
//
// No electron or child_process here, so the rules run under plain Node in the unit tier. local-runtime.js runs the
// script inside the machine as root, reads its report with parseSessionReport, and lists the running distributions
// with wsl.exe; tests/script runs the script as root in a real Linux shell.

// The account `podman machine init --username` creates, which the pod runs under.
const MACHINE_USER = "user";
// Where systemd puts each logged-in UID's runtime folder, and with it Podman's socket.
const RUN_DIR = "/run/user";

// Paths and the account name are pasted into a root script, so only plain characters pass.
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_NAME = /^[a-z_][a-z0-9_-]*$/;

// systemd states on the way somewhere, which are waited out rather than acted on.
const CHANGING = new Set(["activating", "deactivating", "reloading", "refreshing"]);
// States in which nothing of the session is running, so a restart cannot end anything that is.
const DOWN = new Set(["failed", "inactive"]);

function checked(value, pattern, what) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`unsafe ${what} for the session script: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The script run as root inside the machine. It reports the session's state and whether Podman's socket is there, and
 * judges nothing. With restart, it first restarts the session once and waits for systemd's answer, which the session
 * unit's own start timeout bounds (45 s on the machine image). systemctl is-active exits non-zero for every state but
 * active, so its output is kept whatever its exit. The last line says it finished, so a report cut short is never read
 * as a session that is up. The options exist for tests/script; the app always uses the defaults.
 */
function sessionScript({ restart = false, user = MACHINE_USER, runDir = RUN_DIR } = {}) {
  checked(user, SAFE_NAME, "account");
  checked(runDir, SAFE_PATH, "folder");
  return [
    "set -u",
    `r='${runDir}'`,
    `u=$(id -u '${user}' 2> /dev/null) || u=""`,
    "case \"$u\" in ''|*[!0-9]*) echo session=nouser; echo end=ok; exit 0 ;; esac",
    'echo "uid=$u"',
    ...(restart
      ? ['if systemctl restart "user@$u.service" > /dev/null 2>&1; then echo restart=ok; else echo restart=failed; fi']
      : []),
    's=$(systemctl is-active "user@$u.service" 2> /dev/null) || :',
    'echo "session=${s:-unknown}"',
    'if [ -S "$r/$u/podman/podman.sock" ]; then echo socket=yes; else echo socket=no; fi',
    "echo end=ok",
    "",
  ].join("\n");
}

/** The script as the one argument handed to `podman machine ssh`, encoded as the machine check is, for the same reasons. */
function sessionCommand(options) {
  return `printf %s ${Buffer.from(sessionScript(options), "utf8").toString("base64")} | base64 -d | sh`;
}

/** The script's report. Unknown lines, such as a login banner, are ignored. */
function parseSessionReport(text) {
  const report = { complete: false, uid: null, session: null, socket: null, restart: null };
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "end") report.complete = value === "ok";
    else if (key === "uid" || key === "session" || key === "socket" || key === "restart") report[key] = value;
  }
  return report;
}

/** Up, with the socket the pod calls go through. */
function sessionReady(report) {
  return report.session === "active" && report.socket === "yes";
}

/** On its way somewhere: systemd is moving it between states, or it is up and its socket is not there yet. */
function sessionChanging(report) {
  return CHANGING.has(report.session) || (report.session === "active" && report.socket !== "yes");
}

/** Not running at all, the only case a restart is for: restarting a running session would end the pod running in it. */
function sessionDown(report) {
  return DOWN.has(report.session);
}

/**
 * The names `wsl.exe --list --running --quiet` printed. wsl.exe writes UTF-16LE unless WSL_UTF8=1 is set, and the
 * app sets it, but either decodes: a UTF-8 name never holds a NUL byte, and a UTF-16LE one always does.
 */
function parseDistroList(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(String(output), "utf8");
  const text = bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8");
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** The running distributions other than Turnstone's own. WSL compares distribution names without regard to case. */
function otherDistros(names, own) {
  const ownName = own.toLowerCase();
  return names.filter((name) => name.toLowerCase() !== ownName);
}

// What the session's state means, in one clause.
function describeSession(report, restarted, waitedMs) {
  const unit = report.uid ? `user@${report.uid}.service` : "the machine user's session";
  const seconds = Math.round((waitedMs ?? 0) / 1000);
  if (report.session === "nouser") return `the machine has no account named ${MACHINE_USER}, so it has no user session`;
  if (report.session === "active") return `${unit} is running, but its Podman socket did not appear within ${seconds} s`;
  if (CHANGING.has(report.session)) return `${unit} was still ${report.session} after ${seconds} s`;
  return `${unit} is ${report.session ?? "unknown"}${restarted ? ", also after a restart" : ""}`;
}

// What the running distributions say about the cause, in one or two sentences.
function describeDistros(others, listError) {
  if (listError != null) return `The running WSL distributions could not be listed: ${listError}.`;
  if (!others || others.length === 0) return "No other WSL distribution is running.";
  return (
    `Other WSL distributions are running: ${others.join(", ")}. Another Podman machine, or a distribution with a newer ` +
    "systemd, can hold the session this machine needs: stop the one you do not need, for example with " +
    `\`wsl --terminate ${others[0]}\`, then press Retry.`
  );
}

/**
 * The error detail for a session that did not come up: its state, then the other running distributions, which are the
 * usual cause and the one the user can act on. With none running it says so, so the user does not go looking for one.
 */
function sessionFailureDetail({ report, restarted = false, waitedMs, others = null, listError = null }) {
  return `${describeSession(report, restarted, waitedMs)}. ${describeDistros(others, listError)}`;
}

module.exports = {
  sessionScript,
  sessionCommand,
  parseSessionReport,
  sessionReady,
  sessionChanging,
  sessionDown,
  parseDistroList,
  otherDistros,
  sessionFailureDetail,
};
