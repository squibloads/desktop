import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { runAsRoot, facts } from "../helpers/root-shell.js";

const { configScript } = require("../../src/main/turnstone-config.js");

// Each case runs as root in its own folder under /tmp, which the shell removes on exit. The script under test is the
// one the app sends, pointed at that folder and at a subuid file the case writes: user's range starts at 200000, so
// the server's account (container UID 1000) is 200999; nobody's starts at 300000.
const SUBUID = "other:100000:65536\\nuser:200000:65536\\nnobody:300000:65536\\n";

// Prints facts about a config file without printing a secret: mode and owner, the file's hash, and each secret's
// hash, length and alphabet.
const FACTS = String.raw`
facts() {
  f=$1; p=$2
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    echo "$p.stat=$(stat -c '%a %u' "$f")"
    echo "$p.sha=$(sha256sum < "$f" | cut -c1-64)"
    j=$(sed -n 's/^jwt_secret = "\(.*\)"$/\1/p' "$f")
    m=$(sed -n 's/^mcp_token_encryption_key = "\(.*\)"$/\1/p' "$f")
    echo "$p.jwt.len=$(printf %s "$j" | wc -c | tr -d ' ')"
    echo "$p.jwt.sha=$(printf %s "$j" | sha256sum | cut -c1-64)"
    case "$j" in ''|*[!0-9a-f]*) echo "$p.jwt.hex=no" ;; *) echo "$p.jwt.hex=yes" ;; esac
    echo "$p.mcp.len=$(printf %s "$m" | wc -c | tr -d ' ')"
    echo "$p.mcp.sha=$(printf %s "$m" | sha256sum | cut -c1-64)"
    case "$m" in ''|*[!A-Za-z0-9_=-]*) echo "$p.mcp.urlsafe=no" ;; *) echo "$p.mcp.urlsafe=yes" ;; esac
    echo "$p.database=$(grep -c '^backend = "sqlite"$' "$f")"
  else
    echo "$p.exists=no"
  fi
}
temps() { echo "$2.temps=$(ls -A "$1" | grep -c '^\.config\.')"; }
`;

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function workspace() {
  return `/tmp/turnstone-config-test-${randomBytes(6).toString("hex")}`;
}

// Writes the config script for these options to $base/<name>.sh.
function install(base, name, options) {
  const script = configScript({ subuidFile: `${base}/subuid`, ...options });
  return `printf %s ${b64(script)} | base64 -d > "${base}/${name}.sh"`;
}

// Runs a case's lines after the shared setup and returns the facts it printed.
function run(base, lines) {
  const script = [
    "set -u",
    `base=${base}`,
    'mkdir "$base" || exit 3',
    "trap 'rm -rf \"$base\"' EXIT",
    `printf '${SUBUID}' > "$base/subuid"`,
    FACTS,
    ...lines,
  ].join("\n");
  const result = runAsRoot(script);
  expect(result.status, result.stderr).toBe(0);
  return facts(result.stdout);
}

describe("the config script, as root in Linux", () => {
  // Failure: the file is missing a secret, holds one Turnstone rejects, is readable by other accounts, or belongs to an
  // account the server cannot read it as.
  it("creates the file with two secrets Turnstone accepts, owned by the server's account, mode 0600", () => {
    const base = workspace();
    const f = run(base, [
      'mkdir -m 0700 "$base/dir"',
      install(base, "a", { dir: `${base}/dir` }),
      'sh "$base/a.sh" | sed "s/^/a.report./"',
      'facts "$base/dir/config.toml" a',
      'temps "$base/dir" a',
    ]);
    expect(f["a.report.config"]).toBe("created");
    expect(f["a.report.end"]).toBe("ok");
    expect(f["a.stat"]).toBe("600 200999");
    expect([f["a.jwt.len"], f["a.jwt.hex"]]).toEqual(["64", "yes"]);
    expect([f["a.mcp.len"], f["a.mcp.urlsafe"]]).toEqual(["44", "yes"]);
    expect(f["a.database"]).toBe("1");
    expect(f["a.temps"]).toBe("0");
  });

  // Failure: two installs share a secret, so a token signed by one is accepted by the other.
  it("gives two installs different secrets", () => {
    const base = workspace();
    const f = run(base, [
      'mkdir -m 0700 "$base/one" "$base/two"',
      install(base, "a", { dir: `${base}/one` }),
      install(base, "b", { dir: `${base}/two` }),
      'sh "$base/a.sh" | sed "s/^/a.report./"',
      'sh "$base/b.sh" | sed "s/^/b.report./"',
      'facts "$base/one/config.toml" a',
      'facts "$base/two/config.toml" b',
    ]);
    expect([f["a.report.config"], f["b.report.config"]]).toEqual(["created", "created"]);
    expect(f["a.jwt.sha"]).not.toBe(f["b.jwt.sha"]);
    expect(f["a.mcp.sha"]).not.toBe(f["b.mcp.sha"]);
  });

  // Failure: a start rewrites the file, so every sign-in and every token encrypted with the old key stops working; or
  // a file whose owner or mode drifted is left readable by other accounts.
  it("keeps an existing file byte for byte and puts its owner and mode back", () => {
    const base = workspace();
    const f = run(base, [
      'mkdir -m 0700 "$base/dir"',
      `printf 'keep me\\n' > "$base/dir/config.toml"`,
      'chmod 0644 "$base/dir/config.toml"',
      'chown 0:0 "$base/dir/config.toml"',
      'echo "before.sha=$(sha256sum < "$base/dir/config.toml" | cut -c1-64)"',
      install(base, "a", { dir: `${base}/dir` }),
      'sh "$base/a.sh" | sed "s/^/a.report./"',
      'facts "$base/dir/config.toml" a',
    ]);
    expect(f["a.report.config"]).toBe("kept");
    expect(f["a.report.end"]).toBe("ok");
    expect(f["a.sha"]).toBe(f["before.sha"]);
    expect(f["a.stat"]).toBe("600 200999");
  });

  // Failure: a run killed part way leaves a half-written config.toml, which the next run keeps as if it were whole.
  it("leaves no config.toml when a write is killed, and the next run cleans up and creates it", () => {
    const base = workspace();
    // A chown that kills the script when it reaches the temp file: after the write, before the rename.
    const fakeChown = String.raw`#!/bin/sh\ncase "$2" in */.config.*) kill -9 $PPID ;; esac\nexec %s "$@"\n`;
    const f = run(base, [
      'mkdir -m 0700 "$base/dir" "$base/bin"',
      `printf '${fakeChown}' "$(command -v chown)" > "$base/bin/chown"`,
      'chmod 0755 "$base/bin/chown"',
      install(base, "a", { dir: `${base}/dir` }),
      'PATH="$base/bin:$PATH" sh "$base/a.sh" | sed "s/^/first.report./"',
      'facts "$base/dir/config.toml" first',
      'temps "$base/dir" first',
      'sh "$base/a.sh" | sed "s/^/second.report./"',
      'facts "$base/dir/config.toml" second',
      'temps "$base/dir" second',
    ]);
    expect(f["first.report.end"]).toBeUndefined();
    expect(f["first.exists"]).toBe("no");
    expect(f["first.temps"]).toBe("1");
    expect(f["second.report.config"]).toBe("created");
    expect(f["second.stat"]).toBe("600 200999");
    expect(f["second.temps"]).toBe("0");
  });

  // Failure: root follows a link planted in the machine user's folder and re-owns another file, or replaces a
  // directory at the file's path.
  it("refuses a link or a directory at the file's path, and touches neither", () => {
    const base = workspace();
    const f = run(base, [
      'mkdir -m 0700 "$base/dir" "$base/dir2"',
      `printf 'target\\n' > "$base/target"`,
      'chmod 0644 "$base/target"',
      'ln -s "$base/target" "$base/dir/config.toml"',
      'mkdir "$base/dir2/config.toml"',
      install(base, "a", { dir: `${base}/dir` }),
      install(base, "b", { dir: `${base}/dir2` }),
      'sh "$base/a.sh" | sed "s/^/link.report./"',
      'sh "$base/b.sh" | sed "s/^/folder.report./"',
      'echo "link.target=$(stat -c \'%a %u\' "$base/target")"',
      'echo "link.still=$([ -L "$base/dir/config.toml" ] && echo yes || echo no)"',
      'echo "folder.still=$([ -d "$base/dir2/config.toml" ] && echo yes || echo no)"',
    ]);
    expect([f["link.report.config"], f["link.report.end"]]).toEqual(["failed", "ok"]);
    expect(f["link.target"]).toBe("644 0");
    expect(f["link.still"]).toBe("yes");
    expect([f["folder.report.config"], f["folder.report.end"]]).toEqual(["failed", "ok"]);
    expect(f["folder.still"]).toBe("yes");
  });

  // Failure: the machine user swaps its folder for a link, and root writes, re-owns or deletes files in the link's
  // target instead.
  it("refuses a link at the folder's path, and writes nothing in its target", () => {
    const base = workspace();
    const f = run(base, [
      'mkdir -m 0755 "$base/empty" "$base/full"',
      `printf 'root file\\n' > "$base/full/config.toml"`,
      'chmod 0644 "$base/full/config.toml"',
      `printf 'stale\\n' > "$base/full/.config.abcdef"`,
      'ln -s "$base/empty" "$base/dir"',
      'ln -s "$base/full" "$base/dir2"',
      install(base, "a", { dir: `${base}/dir` }),
      install(base, "b", { dir: `${base}/dir2` }),
      'sh "$base/a.sh" | sed "s/^/empty.report./"',
      'sh "$base/b.sh" | sed "s/^/full.report./"',
      'echo "empty.entries=$(ls -A "$base/empty" | wc -l | tr -d \' \')"',
      'echo "full.config=$(stat -c \'%a %u\' "$base/full/config.toml")"',
      'echo "full.stale=$([ -f "$base/full/.config.abcdef" ] && echo yes || echo no)"',
    ]);
    expect([f["empty.report.config"], f["empty.report.end"]]).toEqual(["failed", "ok"]);
    expect(f["empty.entries"]).toBe("0");
    expect([f["full.report.config"], f["full.report.end"]]).toEqual(["failed", "ok"]);
    expect(f["full.config"]).toBe("644 0");
    expect(f["full.stale"]).toBe("yes");
  });

  // Failure: a machine without the folder gets no config, or a folder other accounts can enter.
  it("creates a missing folder for the machine user, mode 0700", () => {
    const base = workspace();
    const f = run(base, [
      install(base, "a", { dir: `${base}/newdir`, owner: "nobody" }),
      'sh "$base/a.sh" | sed "s/^/a.report./"',
      'echo "dir.stat=$(stat -c \'%a %U\' "$base/newdir")"',
      'facts "$base/newdir/config.toml" a',
    ]);
    expect(f["a.report.config"]).toBe("created");
    expect(f["dir.stat"]).toBe("700 nobody");
    expect(f["a.stat"]).toBe("600 300999");
  });

  // Failure: with no subuid range the script guesses an owner, and the server cannot read its own config.
  it("writes nothing when the user has no subuid range", () => {
    const base = workspace();
    const f = run(base, [
      'mkdir -m 0700 "$base/dir"',
      install(base, "a", { dir: `${base}/dir`, owner: "ghost" }),
      'sh "$base/a.sh" | sed "s/^/a.report./"',
      'facts "$base/dir/config.toml" a',
    ]);
    expect([f["a.report.config"], f["a.report.end"]]).toEqual(["failed", "ok"]);
    expect(f["a.exists"]).toBe("no");
  });
});
