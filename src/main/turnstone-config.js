// Turnstone's config.toml for a new install (#1680). The secrets are made inside the Podman machine by a root script
// and never leave it: the app sends the same fixed script every time and reads back only "created", "kept" or
// "failed". The app cannot leak a value it never holds, and none sits on a command line, in stdin or in the app's log.
//
// No electron or child_process here, so the rules run under plain Node in the unit tier. local-runtime.js runs the
// script inside the machine as root and reads its report back with parseConfigReport; tests/script runs it as root
// in a real Linux shell.

// Where the hand-built pod (POC #1499) keeps its config, beside the data folder. #1681 mounts this file read-only.
const CONFIG_DIR = "/home/user/turnstone";
const CONFIG_PATH = `${CONFIG_DIR}/config.toml`;

// Rootless Podman maps container UID 0 to the machine user and container UIDs 1 and up onto the user's subordinate
// range, so the image's turnstone user (UID 1000) is the range's first UID + 999. The range is read when the script
// runs, because Podman assigns it when the machine is created.
const SERVER_UID_IN_CONTAINER = 1000;

// The non-secret settings, as the hand-built pod has them. Models come later, from the wizard (#1571).
const SETTINGS = ["[database]", 'backend = "sqlite"', 'path = "/data/turnstone.db"', "", "[log]", 'level = "info"', ""];

// Paths and the account name are pasted into a root script, so only plain characters pass.
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_NAME = /^[a-z_][a-z0-9_-]*$/;

function checked(value, pattern, what) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`unsafe ${what} for the config script: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The script run as root inside the machine. It creates config.toml only when it is missing, never rewrites one that
 * exists, and puts an existing file's owner and mode back. It reports one config= line and judges nothing; the last
 * line says it finished, so a report cut short is never read as a success. The options exist for tests/script, which
 * points the script at a temp folder; the app always uses the defaults.
 */
function configScript({ dir = CONFIG_DIR, subuidFile = "/etc/subuid", owner = "user" } = {}) {
  checked(dir, SAFE_PATH, "folder");
  checked(subuidFile, SAFE_PATH, "subuid file");
  checked(owner, SAFE_NAME, "account");
  return [
    "set -u",
    "umask 077",
    `d='${dir}'`,
    'f="$d/config.toml"',
    `s=$(awk -F: '$1 == "${owner}" { print $2; exit }' '${subuidFile}')`,
    "case \"$s\" in ''|*[!0-9]*) echo config=failed; echo end=ok; exit 0 ;; esac",
    `o=$((s + ${SERVER_UID_IN_CONTAINER - 1}))`,
    'if [ ! -d "$d" ]; then',
    `  mkdir -m 0700 "$d" && chown '${owner}:' "$d" || { echo config=failed; echo end=ok; exit 0; }`,
    "fi",
    // A run killed after the write and before the rename leaves its temp file; the next run removes it.
    'rm -f "$d"/.config.??????',
    // Root's chown and chmod follow links, and the folder belongs to the machine user, so a link planted at the path
    // could make root re-own another file. A link or a non-file is refused, never followed or replaced.
    'if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then',
    "  echo config=failed",
    'elif [ -f "$f" ]; then',
    '  chown "$o:$o" "$f" && chmod 0600 "$f" && echo config=kept || echo config=failed',
    'elif t=$(mktemp "$d/.config.XXXXXX"); then',
    // 32 random bytes each: 64 hex characters for jwt_secret, and a URL-safe base64 Fernet key. They pass only through
    // pipes and the shell's own printf, so no process's command line ever holds them.
    "  jwt=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')",
    "  mcp=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_')",
    "  if {",
    `    printf '[auth]\\njwt_secret = "%s"\\n\\n' "$jwt"`,
    `    printf '[security]\\nmcp_token_encryption_key = "%s"\\n\\n' "$mcp"`,
    "    cat <<'TOML'",
    ...SETTINGS,
    "TOML",
    // mktemp made the file 0600; the rename is all-or-nothing, so the file is whole or absent, never half written.
    '  } > "$t" && chown "$o:$o" "$t" && mv -T "$t" "$f"; then',
    "    echo config=created",
    "  else",
    '    rm -f "$t"; echo config=failed',
    "  fi",
    "else",
    "  echo config=failed",
    "fi",
    "echo end=ok",
    "",
  ].join("\n");
}

/** The script as the one argument handed to `podman machine ssh`, encoded as the machine check is, for the same reasons. */
function configCommand(options) {
  return `printf %s ${Buffer.from(configScript(options), "utf8").toString("base64")} | base64 -d | sh`;
}

/** The script's report: whether it finished, and what it said about the file. Unknown lines are ignored. */
function parseConfigReport(text) {
  const report = { complete: false, config: null };
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "end") report.complete = value === "ok";
    else if (key === "config") report.config = value;
  }
  return report;
}

module.exports = { CONFIG_PATH, configScript, configCommand, parseConfigReport };
