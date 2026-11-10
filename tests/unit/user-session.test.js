import { describe, it, expect } from "vitest";

const {
  sessionScript,
  sessionCommand,
  parseSessionReport,
  sessionReady,
  sessionChanging,
  sessionDown,
  parseDistroList,
  otherDistros,
  sessionFailureDetail,
} = require("../../src/main/user-session.js");

describe("sessionCommand", () => {
  // Failure: the command carries a quote, a space-split script or a line break, and Windows argument quoting or the
  // machine's shell changes it on the way (POC #1499).
  it("is one line of base64 and a pipe, for the check and for the start", () => {
    for (const start of [false, true]) {
      expect(sessionCommand({ start })).toMatch(/^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    }
  });

  // Failure: the encoded script is not the one the tests read, so a reviewed script is not what reaches the machine,
  // or the options the script tier passes are dropped.
  it("decodes to sessionScript() for the options it is given", () => {
    for (const options of [undefined, { start: true }, { user: "nobody", runDir: "/tmp/t1/run" }]) {
      const encoded = sessionCommand(options).split(" ")[2];
      expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(sessionScript(options));
    }
  });
});

describe("sessionScript", () => {
  // Failure: the check starts the session on its own; or a start runs twice and a second failure counts against
  // systemd's start limit.
  it("starts the session only when asked, and then once", () => {
    expect(sessionScript()).not.toMatch(/systemctl start/);
    expect(sessionScript({ start: true }).match(/systemctl start "user@\$u\.service"/g)).toHaveLength(1);
  });

  // Failure: the session found down comes up between that check and this call, and a restart stops it, ending whatever
  // it started in the meantime (CodeRabbit, PR 46). systemctl start leaves an active unit alone, so systemd itself makes
  // the decision at the moment of the call.
  it("never restarts the session, in either form", () => {
    for (const options of [undefined, { start: true }]) {
      expect(sessionScript(options)).not.toMatch(/restart|try-restart|reload-or-restart|stop/);
    }
  });

  // Failure: the script reads the session or the socket of another account than the one the pod runs under, or a path
  // other than the one the turnstone connection's URI names.
  it("reads the session and the socket of the machine user's own UID", () => {
    const script = sessionScript();
    expect(script).toContain("u=$(id -u 'user' 2> /dev/null)");
    expect(script).toContain('systemctl is-active "user@$u.service"');
    expect(script).toContain("r='/run/user'");
    expect(script).toContain('[ -S "$r/$u/podman/podman.sock" ]');
  });

  // Failure: a carriage return reaches the machine's shell and breaks every line it ends (POC #1499).
  it("has no carriage return", () => {
    expect(sessionScript()).not.toContain("\r");
    expect(sessionScript({ start: true })).not.toContain("\r");
  });

  // Failure: a script cut short reads as a session that is up, because the failure it never reached is not reported.
  it("ends by reporting that it finished", () => {
    expect(sessionScript().trimEnd().endsWith("echo end=ok")).toBe(true);
    expect(sessionScript({ start: true }).trimEnd().endsWith("echo end=ok")).toBe(true);
  });

  // Failure: a path or an account name with a quote or a shell character is pasted into a root script, and runs as code.
  it.each([["user", "us'er"], ["user", "us;er"], ["user", "User"], ["runDir", "/tmp/a b"], ["runDir", "run/user"]])(
    "refuses an unsafe %s: %s",
    (key, value) => {
      expect(() => sessionScript({ [key]: value })).toThrow(/unsafe/);
    },
  );
});

describe("parseSessionReport", () => {
  // Failure: a report with no end line counts as complete, so a check cut off part way reads as a session that is up.
  it("is complete only with the end line", () => {
    expect(parseSessionReport("uid=1000\nsession=active\nsocket=yes\nend=ok\n")).toEqual({
      complete: true,
      uid: "1000",
      session: "active",
      socket: "yes",
      start: null,
    });
    expect(parseSessionReport("uid=1000\nsession=active\nsocket=yes\n").complete).toBe(false);
    expect(parseSessionReport("")).toEqual({ complete: false, uid: null, session: null, socket: null, start: null });
  });

  // Failure: a login banner or a carriage return from the ssh session breaks the parse, and a working session is
  // refused.
  it("ignores lines it does not know, strips carriage returns and reads the start", () => {
    expect(
      parseSessionReport("Welcome to the machine\r\nuid=1000\r\nstart=failed\r\nsession=failed\r\nsocket=no\r\nend=ok\r\n"),
    ).toEqual({ complete: true, uid: "1000", session: "failed", socket: "no", start: "failed" });
  });
});

describe("session states", () => {
  // Failure: a session still starting is read as failed; a failed one is waited on until
  // the timeout; or a session with no socket is called ready and the first pod call meets "connect failed".
  it.each([
    ["active", "yes", { ready: true, changing: false, down: false }],
    ["active", "no", { ready: false, changing: true, down: false }],
    ["activating", "no", { ready: false, changing: true, down: false }],
    ["reloading", "yes", { ready: false, changing: true, down: false }],
    ["deactivating", "no", { ready: false, changing: true, down: false }],
    ["refreshing", "yes", { ready: false, changing: true, down: false }],
    ["failed", "no", { ready: false, changing: false, down: true }],
    ["inactive", "no", { ready: false, changing: false, down: true }],
    ["nouser", null, { ready: false, changing: false, down: false }],
    ["unknown", "no", { ready: false, changing: false, down: false }],
    ["maintenance", "no", { ready: false, changing: false, down: false }],
  ])("session=%s socket=%s", (session, socket, expected) => {
    const report = { complete: true, uid: "1000", session, socket, start: null };
    expect({
      ready: sessionReady(report),
      changing: sessionChanging(report),
      down: sessionDown(report),
    }).toEqual(expected);
  });
});

describe("parseDistroList", () => {
  // Failure: wsl.exe's UTF-16 output is read as UTF-8, so every name comes back with a NUL between its letters and
  // Turnstone's own distribution is listed as another one.
  it("reads wsl.exe's UTF-16LE output, with or without a byte-order mark", () => {
    const text = "podman-turnstone\r\nUbuntu-26.04\r\n";
    expect(parseDistroList(Buffer.from(text, "utf16le"))).toEqual(["podman-turnstone", "Ubuntu-26.04"]);
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(parseDistroList(bom)).toEqual(["podman-turnstone", "Ubuntu-26.04"]);
  });

  // Failure: WSL_UTF8=1 output, which the app asks for, is read as UTF-16 and turned into nonsense.
  it("reads UTF-8 output, from a buffer or a string", () => {
    expect(parseDistroList(Buffer.from("podman-turnstone\r\npodman-machine-default\r\n", "utf8"))).toEqual([
      "podman-turnstone",
      "podman-machine-default",
    ]);
    expect(parseDistroList("Ubuntu\n")).toEqual(["Ubuntu"]);
  });

  // Failure: a blank line or trailing space becomes a distribution with an empty or padded name.
  it("drops blank lines and trims each name", () => {
    expect(parseDistroList(Buffer.from("\r\n  Ubuntu  \r\n\r\n", "utf8"))).toEqual(["Ubuntu"]);
    expect(parseDistroList(Buffer.alloc(0))).toEqual([]);
  });
});

describe("otherDistros", () => {
  // Failure: the error tells the user to stop Turnstone's own machine, which would fix nothing.
  it("leaves out Turnstone's own distribution, whatever its case", () => {
    expect(otherDistros(["podman-turnstone", "podman-machine-default", "Ubuntu-26.04"], "podman-turnstone")).toEqual([
      "podman-machine-default",
      "Ubuntu-26.04",
    ]);
    expect(otherDistros(["PODMAN-TURNSTONE"], "podman-turnstone")).toEqual([]);
  });
});

describe("sessionFailureDetail", () => {
  const failed = { complete: true, uid: "1000", session: "failed", socket: "no", start: "failed" };

  // Failure: the user is told the session failed but not which other distribution to close, so they cannot act on it.
  it("names the other running distributions and says how to stop one", () => {
    expect(
      sessionFailureDetail({ report: failed, started: true, others: ["podman-machine-default", "Ubuntu-26.04"] }),
    ).toBe(
      "user@1000.service is failed, also after starting it again. Other WSL distributions are running: podman-machine-default, " +
        "Ubuntu-26.04. Another Podman machine, or a distribution with a newer systemd, can hold the session this machine " +
        "needs: stop the one you do not need, for example with `wsl --terminate podman-machine-default`, then press Retry.",
    );
  });

  // Failure: with nothing else running, the detail still blames another distribution and sends the user looking for one.
  it("says when no other distribution is running", () => {
    expect(sessionFailureDetail({ report: failed, started: true, others: [] })).toBe(
      "user@1000.service is failed, also after starting it again. No other WSL distribution is running.",
    );
  });

  // Failure: a list that could not be read is shown as "nothing else is running", which may be false.
  it("says when the running distributions could not be listed", () => {
    expect(sessionFailureDetail({ report: failed, started: true, listError: "spawn wsl.exe ENOENT" })).toBe(
      "user@1000.service is failed, also after starting it again. The running WSL distributions could not be listed: " +
        "spawn wsl.exe ENOENT.",
    );
  });

  // Failure: a session still starting at the deadline is reported as failed, or as started again when it never was.
  it("says how long a session that never finished starting was waited on", () => {
    const report = { complete: true, uid: "1000", session: "activating", socket: "no", start: null };
    expect(sessionFailureDetail({ report, waitedMs: 60000, others: [] })).toBe(
      "user@1000.service was still activating after 60 s. No other WSL distribution is running.",
    );
  });

  // Failure: a running session whose socket never appeared is reported as failed, so the user hunts for a collision.
  it("says when the session runs but its Podman socket never appeared", () => {
    const report = { complete: true, uid: "1000", session: "active", socket: "no", start: null };
    expect(sessionFailureDetail({ report, waitedMs: 60000, others: [] })).toBe(
      "user@1000.service is running, but its Podman socket did not appear within 60 s. " +
        "No other WSL distribution is running.",
    );
  });

  // Failure: a machine without its user is reported as a session to start again.
  it("says when the machine has no user account", () => {
    const report = { complete: true, uid: null, session: "nouser", socket: null, start: null };
    expect(sessionFailureDetail({ report, others: [] })).toBe(
      "the machine has no account named user, so it has no user session. No other WSL distribution is running.",
    );
  });

  // Failure: a session in a state the rules do not know is described as started again.
  it("names any other state as systemd gave it, without claiming a second start", () => {
    const report = { complete: true, uid: "1000", session: "maintenance", socket: "no", start: null };
    expect(sessionFailureDetail({ report, others: [] })).toBe(
      "user@1000.service is maintenance. No other WSL distribution is running.",
    );
  });
});
