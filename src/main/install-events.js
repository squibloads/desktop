const path = require("path");
const { isPackagedApp } = require("./runtime-config.js");

// Electron's exe declares itself Squirrel-aware (SquirrelAwareVersion 1 in its version resources). So on Windows,
// Squirrel's Update.exe makes no shortcuts for the app. It starts the app with one of these events as its first
// argument instead, waits for it (up to 15 seconds for install and update, 10 for the others), and leaves the shortcuts
// to the app. Each event maps to the Update.exe option the app answers it with. Obsolete goes to an older version that
// an update is about to delete, which only exits. --squirrel-firstrun is the ordinary first launch after an install, so
// it is not one of them.
const UPDATE_OPTIONS = {
  "--squirrel-install": "--createShortcut",
  "--squirrel-updated": "--createShortcut",
  "--squirrel-uninstall": "--removeShortcut",
  "--squirrel-obsolete": null,
};

// How long Update.exe may take before the app stops it and exits: under Squirrel's 10-second limit for an uninstall.
const UPDATE_EXE_LIMIT_MS = 8000;

// What a packaged Windows build started by Squirrel does instead of starting: null for an ordinary launch, else the
// event and the Update.exe call to make, if any, before it exits. Squirrel passes the event first, so only argv[1]
// counts. Update.exe sits in the folder above the one per version that holds the exe.
function installEventPlan(argv, execPath, { platform = process.platform, packaged = isPackagedApp() } = {}) {
  if (platform !== "win32" || !packaged) return null;
  const event = argv[1];
  if (!Object.hasOwn(UPDATE_OPTIONS, event)) return null;
  const option = UPDATE_OPTIONS[event];
  if (!option) return { event, update: null };
  return {
    event,
    update: {
      command: path.win32.resolve(path.win32.dirname(execPath), "..", "Update.exe"),
      args: [`${option}=${path.win32.basename(execPath)}`],
    },
  };
}

// Makes the plan's Update.exe call, waits for it to exit, then exits. The wait matters for an uninstall: Squirrel
// deletes the install folder as soon as the app exits, and --removeShortcut reads from it. Squirrel waits for Update.exe
// as well, through the console handles Electron leaves inheritable, and with no limit of its own. So one that runs past
// UPDATE_EXE_LIMIT_MS is stopped. Every outcome exits: shortcuts are not worth failing an install or leaving a
// windowless app behind. Squirrel discards the app's output, so the log lines help only a run started by hand.
function runInstallEvent(plan, { spawn, exit }) {
  if (!plan.update) {
    exit(0);
    return;
  }
  const { command, args } = plan.update;
  let done = false;
  let limit = null;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(limit);
    exit(0);
  };
  let child;
  try {
    child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  } catch (err) {
    console.error(`${plan.event}: could not run ${command}: ${err.message}`);
    finish();
    return;
  }
  limit = setTimeout(() => {
    console.error(`${plan.event}: ${command} still running after ${UPDATE_EXE_LIMIT_MS} ms; stopping it`);
    try {
      child.kill();
    } catch (err) {
      console.error(`${plan.event}: could not stop ${command}: ${err.message}`);
    }
    finish();
  }, UPDATE_EXE_LIMIT_MS);
  child.once("exit", (code) => {
    if (code !== 0 && !done) console.error(`${plan.event}: ${command} exited with ${code}`);
    finish();
  });
  child.once("error", (err) => {
    console.error(`${plan.event}: could not run ${command}: ${err.message}`);
    finish();
  });
}

module.exports = { installEventPlan, runInstallEvent };
