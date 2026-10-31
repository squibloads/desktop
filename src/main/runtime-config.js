// Two environment overrides for the opt-in smoke tier. Both are off unless set, and a
// packaged build ignores them.
// A malformed value throws instead of falling back: a silent fallback would let a
// smoke test pass against the real podman or the real console.
// No electron require here, so the rules run under plain Node in the unit tier.

const DEFAULT_LOCAL_CONSOLE_URL = "http://127.0.0.1:8090";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

// Whether this module runs from a packaged build. The overrides are a test hook, and a release has no use for one.
// They are not a way in that this closes: whoever can set the user's environment can still put another podman first
// on PATH.
//
// Forge packs the app into app.asar (forge.config.js, kept by tests/contract/packaging.test.js), so a release runs
// this file from inside it, while npm start and the smoke tier run it from the checkout. Electron's app.isPackaged is
// not used: it turns true for any ELECTRON_FORCE_IS_PACKAGED, which a developer's shell would pass to the smoke tier,
// and it needs electron, which a utility process or plain Node may not have.
function isPackagedApp(filename = __filename) {
  return /[\\/]app\.asar(\.unpacked)?[\\/]/.test(filename);
}

function podmanCommand(env = process.env, packaged = isPackagedApp()) {
  const raw = packaged ? undefined : env.TURNSTONE_PODMAN;
  if (raw === undefined || raw === "") return { file: "podman", prefixArgs: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TURNSTONE_PODMAN must be a JSON array of non-empty strings (the value is not valid JSON)");
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((item) => typeof item === "string" && item.length > 0);
  if (!valid) {
    throw new Error('TURNSTONE_PODMAN must be a JSON array of non-empty strings, for example ["node","fake-podman.js"]');
  }
  const [file, ...prefixArgs] = parsed;
  return { file, prefixArgs };
}

// Returns the origin only. The error never repeats the value, because it may carry a password.
function localConsoleUrl(env = process.env, packaged = isPackagedApp()) {
  const raw = packaged ? undefined : env.TURNSTONE_LOCAL_CONSOLE_URL;
  if (raw === undefined || raw === "") return DEFAULT_LOCAL_CONSOLE_URL;
  const fail = (reason) => new Error(`TURNSTONE_LOCAL_CONSOLE_URL ${reason}`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail("must be an absolute http:// URL");
  }
  if (url.protocol !== "http:") throw fail("must use the http: scheme");
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw fail("must name 127.0.0.1, localhost or [::1]");
  }
  if (url.username !== "" || url.password !== "") throw fail("must not contain credentials");
  return url.origin;
}

// Startup check for both overrides, run in every mode before anything reads them. Returns the
// first problem as a message, or null. The message never carries the value, only the variable's name.
function firstConfigError(env = process.env, packaged = isPackagedApp()) {
  try {
    podmanCommand(env, packaged);
  } catch (err) {
    return err.message;
  }
  try {
    localConsoleUrl(env, packaged);
  } catch (err) {
    return err.message;
  }
  return null;
}

module.exports = {
  DEFAULT_LOCAL_CONSOLE_URL,
  LOOPBACK_HOSTS,
  isPackagedApp,
  podmanCommand,
  localConsoleUrl,
  firstConfigError,
};
