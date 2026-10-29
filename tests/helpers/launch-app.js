// Launches the real app under Playwright's Electron support, with a fake Podman and
// a fake Console. Each launch gets its own user-data directory holding the seeded
// settings and the fake Podman's state and log, so files can run in parallel.
//
// Call launchApp inside a test and closeEverything in afterEach: a failed assertion must
// not leave an Electron process or a fake Console running into the next test.

import { _electron as electron } from "playwright-core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { checkPodmanOverride, checkSeededSettings, pathWithoutPodman } from "./safe-path.js";

// path.resolve drops the trailing separator: a trailing backslash escapes the closing quote in
// Electron's Windows argv parsing and glues the next argument onto the app path.
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FAKE_PODMAN = fileURLToPath(new URL("./fake-podman.js", import.meta.url));

// Bounds app.close(). The normal path resolves when the process exits. The guard sits well under
// the 60 s hookTimeout (vitest.config.mjs), so a hung quit fails its own test, and its process tree
// is killed, instead of timing out the afterEach hook and leaving Electron running.
const QUIT_GUARD_MS = 25_000;
// How long the kill path waits for the app process to be gone before it reports it still running.
const KILL_WAIT_MS = 5_000;

const DEFAULT_PODMAN_STATE = { machine: "running", pod: "Running", failStart: false, failStop: false };

// Handles of apps still running, so closeAllApps can end them after a failed assertion.
const live = new Set();
// Fake consoles started by the test files, so closeEverything stops them even when an app close throws.
const consoles = new Set();

// One closed loopback port per process, for launches that name no consolePort. The app's own
// default, 8090, can be a live Console on the developer's machine. The port is bound, released,
// and left with no listener. Race: another process can take it between the release and the
// app's first connect, which would show an unexpected console rather than pass silently.
let reservedClosedPortPromise = null;
function reservedClosedPort() {
  reservedClosedPortPromise ??= new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
  return reservedClosedPortPromise;
}

export function urlIs(url) {
  return (window) => window.url() === url;
}

export function urlEndsWith(suffix) {
  return (window) => window.url().split("?")[0].endsWith(suffix);
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else, so it is still alive.
    return err.code === "EPERM";
  }
}

// Kills the app and every process it started. Electron forks GPU, renderer and utility processes,
// and killing only the parent leaves them running.
function killTree(child) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  // A child that leads its own process group takes the whole group with one signal.
  let leadsGroup = false;
  try {
    process.kill(-pid, 0);
    leadsGroup = true;
  } catch {
    leadsGroup = false;
  }
  if (leadsGroup) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return;
  }
  // Children first: once the parent dies they are reparented to init, and pkill -P no longer finds them.
  spawnSync("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" });
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// Waits until the app process has exited and its pid no longer exists. This is a deadline poll on
// process state, not a timing assertion.
async function waitForGone(child) {
  const deadline = Date.now() + KILL_WAIT_MS;
  while (Date.now() < deadline) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (exited && (child.pid === undefined || !pidAlive(child.pid))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`app process ${child.pid} still running ${KILL_WAIT_MS} ms after the kill`);
}

async function quitWithGuard(app) {
  let guard;
  const hung = new Promise((_, reject) => {
    guard = setTimeout(
      () => reject(new Error(`app did not exit within ${QUIT_GUARD_MS} ms`)),
      QUIT_GUARD_MS,
    );
  });
  try {
    await Promise.race([app.close(), hung]);
  } catch (err) {
    const child = app.process();
    killTree(child);
    await waitForGone(child);
    throw err;
  } finally {
    clearTimeout(guard);
  }
}

// Registers a fake console for closeEverything to stop. Returns it, so a test can register at once.
export function registerConsole(fake) {
  consoles.add(fake);
  return fake;
}

export async function launchApp({ settings = {}, podmanState = {}, env = {}, consolePort } = {}) {
  const settingsProblem = checkSeededSettings(settings);
  if (settingsProblem) throw new Error(`launchApp refused: ${settingsProblem}`);
  // Resolved before the temp dir exists, so a failed port reservation leaves nothing behind.
  const consoleUrl = `http://127.0.0.1:${consolePort ?? (await reservedClosedPort())}`;
  const userDataDir = mkdtempSync(join(tmpdir(), "turnstone-e2e-"));
  const statePath = join(userDataDir, "podman-state.json");
  const logPath = join(userDataDir, "podman.log");
  // hasLaunched defaults to true so the first-run Settings window does not open over the test.
  writeFileSync(
    join(userDataDir, "turnstone-desktop.json"),
    JSON.stringify({ hasLaunched: true, ...settings }),
  );
  writeFileSync(statePath, JSON.stringify({ ...DEFAULT_PODMAN_STATE, ...podmanState }));
  writeFileSync(logPath, "");

  const childEnv = {
    ...process.env,
    ...env,
    // The override runs this test runner's node on fake-podman.js. checkPodmanOverride below
    // refuses to launch if it is ever lost or changed.
    TURNSTONE_PODMAN: JSON.stringify([process.execPath, FAKE_PODMAN]),
    TURNSTONE_LOCAL_CONSOLE_URL: consoleUrl,
    FAKE_PODMAN_STATE: statePath,
    FAKE_PODMAN_LOG: logPath,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Second guard, for the case where the override is lost: the child's PATH drops every directory
  // holding a podman executable, so the app cannot find a real podman. Windows keys the variable
  // as "Path" in some environments, so the key is found without regard to case, and only one copy
  // is kept.
  const pathKeys = Object.keys(childEnv).filter((key) => key.toUpperCase() === "PATH");
  const pathKey = pathKeys[0] ?? "PATH";
  const originalPath = childEnv[pathKey] ?? "";
  for (const key of pathKeys) delete childEnv[key];
  childEnv[pathKey] = pathWithoutPodman(originalPath);
  // Linux CI containers cannot create the Chromium sandbox.
  const args = [REPO_ROOT, `--user-data-dir=${userDataDir}`];
  if (process.env.CI) args.push("--no-sandbox");

  let app;
  try {
    const podmanProblem = checkPodmanOverride(childEnv.TURNSTONE_PODMAN, process.execPath);
    if (podmanProblem) throw new Error(`refusing to launch the app: ${podmanProblem}`);
    app = await electron.launch({ args, env: childEnv, timeout: 60_000 });
    await app.firstWindow();
  } catch (err) {
    if (app) await quitWithGuard(app).catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw err;
  }

  let finalLog = null;
  let closed = false;
  // The app's own output, kept for the failure message: a view that never loads is otherwise a
  // bare timeout, and the cause is usually one line the main process printed.
  let appOutput = "";
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on("data", (chunk) => {
      appOutput = (appOutput + chunk).slice(-4000);
    });
  }

  async function findPage(predicate, { description = "window", timeoutMs = 30_000 } = {}) {
    let found = null;
    await vi.waitFor(
      async () => {
        found = app.windows().find(predicate) ?? null;
        if (!found) {
          const open = app.windows().map((w) => w.url()).join(", ") || "none";
          // What the main process itself holds: a view it loaded that Playwright never reported
          // shows here and not in the list above.
          const inMain = await app
            .evaluate(({ webContents }) => webContents.getAllWebContents().map((c) => c.getURL()))
            .then((urls) => urls.join(", ") || "none")
            .catch((err) => `unreadable (${err.message})`);
          throw new Error(
            `no ${description}; open windows: ${open}
main process pages: ${inMain}
podman calls: ${JSON.stringify(readLines(logPath))}
app output:
${appOutput || "(none)"}`,
          );
        }
      },
      { timeout: timeoutMs, interval: 200 },
    );
    return found;
  }

  async function close() {
    if (closed) return;
    closed = true;
    live.delete(handle);
    try {
      await quitWithGuard(app);
    } finally {
      // Read after the quit, so a stop the quit issued is in the log, then remove the directory.
      finalLog ??= readLines(logPath);
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }

  const handle = {
    app,
    userDataDir,
    findPage,
    close,
    windowUrls: () => app.windows().map((w) => w.url()),
    // After close(), returns the log as it was when the directory was removed.
    readPodmanLog: () => finalLog ?? readLines(logPath),
    setPodmanState(patch) {
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      writeFileSync(statePath, JSON.stringify({ ...current, ...patch }));
    },
    async clickMenuItem(label) {
      await app.evaluate(
        ({ Menu }, wanted) => {
          const search = (items) => {
            for (const item of items) {
              if (item.label === wanted && typeof item.click === "function") return item;
              if (item.submenu) {
                const found = search(item.submenu.items);
                if (found) return found;
              }
            }
            return null;
          };
          const item = search(Menu.getApplicationMenu().items);
          if (!item) throw new Error(`menu item "${wanted}" not found`);
          item.click();
        },
        label,
      );
    },
  };

  live.add(handle);
  return handle;
}

// Closes every app the test left open, then stops every registered fake console. The consoles are
// stopped even when an app close throws, so a failed quit cannot leave a console listening.
export async function closeEverything() {
  let firstError = null;
  try {
    await closeAllApps();
  } catch (err) {
    firstError = err;
  }
  for (const fake of [...consoles]) {
    try {
      await fake.stop();
    } catch (err) {
      firstError ??= err;
    }
  }
  consoles.clear();
  if (firstError) throw firstError;
}

export async function closeAllApps() {
  let firstError = null;
  for (const handle of [...live]) {
    try {
      await handle.close();
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
}
