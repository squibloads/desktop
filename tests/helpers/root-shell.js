import { spawnSync } from "node:child_process";

// The script tier runs scripts the app hands to the Podman machine as root, in a real Linux shell, because the unit
// tier runs under Node on Windows with no dependable sh or chown. TURNSTONE_SCRIPT_SHELL names the shell: a JSON array
// of strings, the program first, to which the tier appends one argument, a shell command line. For example:
//   ["podman","machine","ssh","--username","root","turnstone"]   the Turnstone machine, from Windows
//   ["sudo","sh","-c"]                                            a Linux runner
// A missing or malformed value throws and names the variable, so the tier can never pass by skipping.

/** The program and its leading arguments, from TURNSTONE_SCRIPT_SHELL. */
export function rootShell(raw = process.env.TURNSTONE_SCRIPT_SHELL) {
  let parsed;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((s) => typeof s === "string" && s !== "")) {
    throw new Error(
      `TURNSTONE_SCRIPT_SHELL must be a JSON array of non-empty strings naming a root shell, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * Runs `script` as root in that shell and returns { status, stdout, stderr }. The script travels as base64 in one
 * argument, as the app sends its own, so no quoting or carriage return can change it on the way.
 */
export function runAsRoot(script) {
  const [file, ...prefix] = rootShell();
  const command = `printf %s ${Buffer.from(script, "utf8").toString("base64")} | base64 -d | sh`;
  const result = spawnSync(file, [...prefix, command], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The `key=value` lines of an output, as an object. Lines without `=` are ignored. */
export function facts(stdout) {
  const out = {};
  for (const raw of String(stdout).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}
