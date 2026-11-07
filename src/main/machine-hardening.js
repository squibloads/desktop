// The machine side of ADR-05: the settings that keep the Windows host out of the Turnstone machine, put back on every
// Local start, and the checks that the gaps they close are closed. Nothing in the machine holds these settings in
// place, so a rewrite of wsl.conf or a new sudoers grant would silently undo the folder scoping.
//
// No electron or child_process here, so the rules run under plain Node in the unit tier. local-runtime.js runs the
// script inside the machine as root and reads its report back with parseMachineReport.

// /etc/wsl.conf as the app owns it, byte for byte the file hardened by hand in POC #1499, so an already correct
// machine is never rewritten. [user] is Podman's own. Each other section closes a bypass the POC proved:
// [automount] mounts only the fstab shares instead of every drive at /mnt/<letter>; [interop] keeps cmd.exe and the
// Windows PATH out; [boot] unregisters the WSLInterop handler, which [interop] alone leaves registered, so a Windows
// .exe dropped in a shared folder would still run on Windows.
const WSL_CONF = [
  "[user]",
  "default=user",
  "",
  "[automount]",
  "enabled=false",
  "mountFsTab=true",
  "",
  "[interop]",
  "enabled=false",
  "appendWindowsPath=false",
  "",
  "[boot]",
  'command="echo -1 > /proc/sys/fs/binfmt_misc/WSLInterop"',
  "",
].join("\n");

// WSL mounts its own driver folders into every distro over 9p. They are part of WSL, not a folder the user shared.
const WSL_OWN_MOUNTS = "/usr/lib/wsl/";

/**
 * The script run as root inside the machine. It puts the settings back, then reports what holds, one key=value line
 * per fact, and judges nothing: hardeningGaps decides. It writes only what differs, so a machine that holds every
 * setting is left untouched. The last line says it finished, so a report cut short is never read as a clean one.
 */
function machineScript() {
  const wslConf = Buffer.from(WSL_CONF, "utf8").toString("base64");
  return [
    "set -u",
    // wsl.conf is replaced only when it differs: the machine reads it only at boot, so a rewrite costs a restart.
    't=$(mktemp /etc/.turnstone-wsl.XXXXXX) || t=""',
    'if [ -z "$t" ]; then echo wslconf=failed',
    `elif ! printf %s ${wslConf} | base64 -d > "$t"; then rm -f "$t"; echo wslconf=failed`,
    'elif cmp -s "$t" /etc/wsl.conf; then rm -f "$t"; echo wslconf=ok',
    'elif chmod 0644 "$t" && mv "$t" /etc/wsl.conf; then echo wslconf=rewritten',
    'else rm -f "$t"; echo wslconf=failed; fi',
    // Passwordless sudo lets the machine user mount a whole drive past the fstab scoping. Each active NOPASSWD line
    // is commented out, and a file is replaced only once visudo accepts the result, so sudo is never left broken.
    "for f in /etc/sudoers /etc/sudoers.d/*; do",
    '  [ -f "$f" ] || continue',
    "  grep -Eq '^[[:space:]]*[^#[:space:]].*NOPASSWD' \"$f\" || continue",
    '  s=$(mktemp /etc/.turnstone-sudoers.XXXXXX) || { echo "sudoers=failed $f"; continue; }',
    "  if sed -E 's/^([[:space:]]*[^#[:space:]].*NOPASSWD.*)$/# turnstone-disabled: \\1/' \"$f\" > \"$s\" &&",
    '    visudo -cqf "$s" > /dev/null 2>&1 && chmod 0440 "$s" && mv "$s" "$f"; then echo "sudoers=fixed $f"',
    '  else rm -f "$s"; echo "sudoers=failed $f"; fi',
    "done",
    // The boot command's own step, also taken now, so a handler registered since boot is gone before the pod runs.
    'for e in /proc/sys/fs/binfmt_misc/WSLInterop*; do [ -e "$e" ] && echo -1 > "$e"; done 2> /dev/null',
    'for e in /proc/sys/fs/binfmt_misc/*; do [ -e "$e" ] || continue; n=${e##*/}',
    '  case "$n" in register|status) ;; *) echo "binfmt=$n" ;; esac',
    "done",
    // Asked as the machine user, uid 1000, the account the pod runs under. Root's answer would always be yes.
    'u=$(id -nu 1000 2> /dev/null) || u=""',
    'if [ -z "$u" ]; then echo sudo=nouser',
    'elif runuser -u "$u" -- sudo -n true > /dev/null 2>&1; then echo sudo=allowed',
    "else echo sudo=refused; fi",
    // Windows folders show as 9p (drvfs) mounts. Both files escape a space as \040, so a line splits cleanly.
    'while read -r src dst typ rest; do case "$typ" in 9p|drvfs|virtiofs) echo "mount=$src $dst" ;; esac; done < /proc/mounts',
    "while read -r src dst typ rest; do",
    "  case \"$src\" in ''|'#'*) continue ;; esac",
    '  [ "$typ" = drvfs ] && echo "fstab=$src $dst"',
    "done < /etc/fstab",
    "echo end=ok",
    "",
  ].join("\n");
}

/**
 * The script as the one argument handed to `podman machine ssh`: base64 and a pipe, so no quote, space-split word or
 * line break is left for Windows argument quoting or the machine's shell to change, and no carriage return reaches
 * the shell (POC #1499 lost scripts to CRLF).
 */
function machineCheckCommand() {
  return `printf %s ${Buffer.from(machineScript(), "utf8").toString("base64")} | base64 -d | sh`;
}

// "source target" from a mount or fstab line. Both fields are octal-escaped, so neither holds a space.
function pathPair(value) {
  const space = value.indexOf(" ");
  return space < 0
    ? { source: value, target: "" }
    : { source: value.slice(0, space), target: value.slice(space + 1) };
}

/** The script's report as facts. Lines it does not know, such as a login banner, are ignored. */
function parseMachineReport(text) {
  const report = { complete: false, wslconf: null, sudo: null, sudoers: [], binfmt: [], mounts: [], fstab: [] };
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "end") report.complete = value === "ok";
    else if (key === "wslconf") report.wslconf = value;
    else if (key === "sudo") report.sudo = value;
    else if (key === "sudoers") report.sudoers.push(pathPair(value));
    else if (key === "binfmt") report.binfmt.push(value);
    else if (key === "mount") report.mounts.push(pathPair(value));
    else if (key === "fstab") report.fstab.push(pathPair(value));
  }
  return report;
}

// A mount path as the user would write it: /proc/mounts and fstab write a backslash as \134 and a space as \040.
function readablePath(escaped) {
  return escaped.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * The gaps a report shows, as plain sentences for the error page, or [] when every setting holds. Anything the
 * report does not affirm is a gap: an unknown never reads as safe. A rewritten wsl.conf is a gap here because the
 * caller restarts the machine and checks again first, so a second rewrite means the file does not stay written.
 */
function hardeningGaps(report) {
  const gaps = [];
  if (report.wslconf === "rewritten") gaps.push("wsl.conf does not keep the app's settings after a restart");
  else if (report.wslconf !== "ok") gaps.push("wsl.conf could not be written");
  for (const { source: result, target: file } of report.sudoers) {
    if (result !== "fixed") gaps.push(`${file} grants sudo without a password and could not be changed`);
  }
  if (report.sudo === "allowed") gaps.push("the machine user can use sudo without a password");
  else if (report.sudo !== "refused") gaps.push("the machine user could not be checked for sudo");
  for (const name of report.binfmt) {
    if (name.startsWith("WSLInterop")) gaps.push(`Windows programs can still run inside the machine (${name} is registered)`);
  }
  for (const mount of report.mounts) {
    if (mount.target.startsWith(WSL_OWN_MOUNTS)) continue;
    const listed = report.fstab.some((line) => line.source === mount.source && line.target === mount.target);
    if (!listed) {
      gaps.push(
        `a Windows folder is mounted that /etc/fstab does not list: ${readablePath(mount.source)} at ${readablePath(mount.target)}`,
      );
    }
  }
  return gaps;
}

module.exports = { WSL_CONF, machineScript, machineCheckCommand, parseMachineReport, hardeningGaps };
