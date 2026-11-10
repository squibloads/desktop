import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { runAsRoot, facts } from "../helpers/root-shell.js";

const { sessionScript } = require("../../src/main/user-session.js");

// Each case runs as root in its own folder under /tmp, which the shell removes on exit. A stub systemctl first on PATH
// plays the session, so no case touches the machine's real one. It logs each call and answers is-active from a state
// file the way systemctl does (the state on stdout, exit 0 only for active). It plays start the way systemd does too: a
// start leaves a session that is already active alone, and brings a down one up only when the case left a start-ok
// file. Any other subcommand, restart among them, exits 2. The account is nobody (UID 65534) and the socket folder is
// the case's own.
const STUB = String.raw`#!/bin/sh
echo "$*" >> "$STUB_DIR/calls"
case "$1" in
  is-active) s=$(cat "$STUB_DIR/state"); echo "$s"; [ "$s" = active ] ;;
  start)
    [ "$(cat "$STUB_DIR/state")" = active ] && exit 0
    if [ -f "$STUB_DIR/start-ok" ]; then echo active > "$STUB_DIR/state"; else echo failed > "$STUB_DIR/state"; exit 1; fi ;;
  *) exit 2 ;;
esac
`;

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function workspace() {
  return `/tmp/turnstone-session-test-${randomBytes(6).toString("hex")}`;
}

// Runs the session script for these options with the stub in place, after a case's setup lines, and returns its report
// plus the stub's calls joined by ";".
function run(base, options, setup = []) {
  const script = sessionScript({ user: "nobody", runDir: `${base}/run`, ...options });
  const result = runAsRoot(
    [
      "set -u",
      `base=${base}`,
      'mkdir "$base" "$base/bin" || exit 3',
      "trap 'rm -rf \"$base\"' EXIT",
      `printf %s ${b64(STUB)} | base64 -d > "$base/bin/systemctl"`,
      'chmod 0755 "$base/bin/systemctl"',
      "echo failed > \"$base/state\"",
      ...setup,
      `printf %s ${b64(script)} | base64 -d > "$base/s.sh"`,
      'STUB_DIR="$base" PATH="$base/bin:$PATH" sh "$base/s.sh"',
      'echo "calls=$(tr \'\\n\' \';\' 2> /dev/null < "$base/calls")"',
    ].join("\n"),
  );
  expect(result.status, result.stderr).toBe(0);
  return facts(result.stdout);
}

describe("the session script, as root in Linux", () => {
  // Failure: systemctl's non-zero exit for a failed unit loses its answer, so a failed session reads as "unknown" and is
  // never started again; or the check starts it on its own.
  it("reports a failed session as failed, with no socket, and only asks", () => {
    const f = run(workspace(), {});
    expect(f).toEqual({ uid: "65534", session: "failed", socket: "no", end: "ok", calls: "is-active user@65534.service;" });
  });

  // Failure: the start's failure is lost, or it is not followed by a fresh read, so the report shows the state from
  // before the start.
  it("starts once when asked, then reports that the start failed and the state after it", () => {
    const f = run(workspace(), { start: true });
    expect(f).toEqual({
      uid: "65534",
      start: "failed",
      session: "failed",
      socket: "no",
      end: "ok",
      calls: "start user@65534.service;is-active user@65534.service;",
    });
  });

  // Failure: a start that worked is reported as failed, so a session that recovered is refused.
  it("reports a start that worked, and the session it brought up", () => {
    const base = workspace();
    const f = run(base, { start: true }, ['touch "$base/start-ok"']);
    expect([f.start, f.session, f.end]).toEqual(["ok", "active", "ok"]);
  });

  // Failure: a session that came up between the check that found it down and the call that brings it up is restarted,
  // which ends whatever it started in the meantime (CodeRabbit, PR 46). systemctl start leaves an active unit alone.
  it("sends start, never restart, so a session that came up meanwhile is left running", () => {
    const base = workspace();
    const f = run(base, { start: true }, ['echo active > "$base/state"']);
    expect(f).toEqual({
      uid: "65534",
      start: "ok",
      session: "active",
      socket: "no",
      end: "ok",
      calls: "start user@65534.service;is-active user@65534.service;",
    });
  });

  // Failure: any file at the socket's path counts, so a stale plain file reads as a listening API.
  it("says socket=yes only for a socket at the user's path, not a plain file", () => {
    const sock = '"$base/run/65534/podman/podman.sock"';
    const file = run(workspace(), {}, ['mkdir -p "$base/run/65534/podman"', `: > ${sock}`]);
    expect(file.socket).toBe("no");
    const socket = run(workspace(), {}, [
      'mkdir -p "$base/run/65534/podman"',
      `python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' ${sock}`,
    ]);
    expect(socket.socket).toBe("yes");
  });

  // Failure: a machine without the account is asked about a session for an empty UID, or one is started for it.
  it("reports nouser and calls no systemctl when the account does not exist", () => {
    const f = run(workspace(), { user: "turnstone-no-such-user", start: true });
    expect(f).toEqual({ session: "nouser", end: "ok", calls: "" });
  });
});
