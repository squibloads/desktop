// Free disk space where the Podman machine's disk grows, for the check before a download (NFR-04). On Windows the
// machine is a WSL distribution whose disk file sits under the user's home, so the drive that matters is that one,
// whichever drive the app is installed on.
//
// No electron require, so the tests run it as is.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Podman's machine folder, where each machine's disk file lives. It need not exist yet. Podman keeps its data under
 * XDG_DATA_HOME when that is set, on Windows too, and under ~/.local/share otherwise, so the check follows the same
 * rule and reads the drive the machine actually grows on.
 */
function podmanDataDir(home = os.homedir(), env = process.env) {
  const dataHome = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  return path.join(dataHome, "containers", "podman", "machine");
}

/**
 * Bytes free to this user on the drive holding dir. dir need not exist: the nearest folder above it that does is
 * read, since a first run checks before Podman has made its folders. A read that fails throws; it is never taken as
 * enough space.
 */
function freeDiskBytes(dir, { statfs = fs.statfsSync } = {}) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stats = statfs(probe);
  return Number(stats.bavail) * Number(stats.bsize);
}

module.exports = { freeDiskBytes, podmanDataDir };
