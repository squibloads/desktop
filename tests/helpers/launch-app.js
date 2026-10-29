// Launches the real app under Playwright's Electron support, with a fake Podman and
// a fake Console. Each launch gets its own user-data directory holding the seeded
// settings and the fake Podman's state and log, so files can run in parallel.
//
// Call launchApp inside a test and closeAllApps in afterEach: a failed assertion must
// not leave an Electron process running into the next test.

import { _electron as electron } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

import { resolve } from "node:path";

// path.resolve drops the trailing separator: a trailing backslash escapes the closing quote in
// Electron's Windows argv parsing and glues the next argument onto the app path.
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FAKE_PODMAN = fileURLToPath(new URL("./fake-podman.js", import.meta.url));

// Bounds app.close(). The normal path resolves when the process exits; this only keeps a
// hung quit from hanging the whole run.
const QUIT_GUARD_MS = 60_000;

const DEFAULT_PODMAN_STATE = { machine: "running", pod: "Running", failStart: false, failStop: false };

// Handles of apps still running, so closeAllApps can end them after a failed assertion.
const live = new Set();

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
    app.process().kill();
    throw err;
  } finally {
    clearTimeout(guard);
  }
}

export async function launchApp({ settings = {}, podmanState = {}, env = {}, consolePort } = {}) {
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
    TURNSTONE_PODMAN: JSON.stringify([process.execPath, FAKE_PODMAN]),
    // Empty means unset: the app then uses its default address.
    TURNSTONE_LOCAL_CONSOLE_URL: consolePort === undefined ? "" : `http://127.0.0.1:${consolePort}`,
    FAKE_PODMAN_STATE: statePath,
    FAKE_PODMAN_LOG: logPath,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Linux CI containers cannot create the Chromium sandbox.
  const args = [REPO_ROOT, `--user-data-dir=${userDataDir}`];
  if (process.env.CI) args.push("--no-sandbox");

  let app;
  try {
    app = await electron.launch({ args, env: childEnv, timeout: 60_000 });
    await app.firstWindow();
  } catch (err) {
    if (app) await quitWithGuard(app).catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw err;
  }

  let finalLog = null;
  let closed = false;

  async function findPage(predicate, { description = "window", timeoutMs = 30_000 } = {}) {
    let found = null;
    await vi.waitFor(
      () => {
        found = app.windows().find(predicate) ?? null;
        if (!found) {
          const open = app.windows().map((w) => w.url()).join(", ") || "none";
          throw new Error(`no ${description}; open windows: ${open}`);
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
