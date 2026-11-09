import { describe, it, expect } from "vitest";

const {
  CONFIG_PATH,
  configScript,
  configCommand,
  parseConfigReport,
} = require("../../src/main/turnstone-config.js");

describe("CONFIG_PATH", () => {
  // Failure: the file sits under a folder the machine user can change, so it can swap a path between root's check and
  // root's write and have root overwrite or re-own any file in the machine (review of #45). Or the app writes it
  // somewhere other than where #1681's mount reads it.
  it("is in a folder under /etc, which only root can change", () => {
    expect(CONFIG_PATH).toBe("/etc/turnstone/config.toml");
  });
});

describe("configCommand", () => {
  // Failure: the command carries a quote, a space-split script or a line break, and Windows argument quoting or the
  // machine's shell changes it on the way (POC #1499).
  it("is one line of base64 and a pipe, with nothing a shell or Windows quoting can change", () => {
    expect(configCommand()).toMatch(/^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
  });

  // Failure: the encoded script is not the one the tests read, so a reviewed script is not what reaches the machine.
  it("decodes to configScript()", () => {
    const encoded = configCommand().split(" ")[2];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(configScript());
  });

  // Failure: the folder or the subuid file the tests point the script at is ignored, so the script tier tests the
  // real paths instead of a temp folder.
  it("encodes the script for the paths it is given", () => {
    const options = { dir: "/tmp/t1/dir", subuidFile: "/tmp/t1/subuid", owner: "nobody" };
    const encoded = configCommand(options).split(" ")[2];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(configScript(options));
  });
});

describe("configScript", () => {
  // Failure: the app makes a secret and sends it into the machine, so the value sits in the app's memory and on a
  // command line (L-11). The script is fixed text: the same on every call, so nothing secret is in it.
  it("is the same text on every call, so no secret is made in the app", () => {
    expect(configScript()).toBe(configScript());
    expect(configScript()).not.toMatch(/[0-9a-f]{32}/);
  });

  // Failure: the values reach another program's arguments, where /proc/<pid>/cmdline shows them to any process.
  it("hands the values only to the shell's own printf", () => {
    const uses = configScript()
      .split("\n")
      .filter((line) => /\$(jwt|mcp)\b/.test(line))
      .map((line) => line.trim());
    expect(uses).toEqual([
      `printf '[auth]\\njwt_secret = "%s"\\n\\n' "$jwt"`,
      `printf '[security]\\nmcp_token_encryption_key = "%s"\\n\\n' "$mcp"`,
    ]);
  });

  // Failure: a secret comes from a weak or predictable source, or is too short for Turnstone (jwt_secret needs 32+).
  it("reads 32 bytes from /dev/urandom for each secret", () => {
    const reads = configScript().match(/head -c 32 \/dev\/urandom/g) || [];
    expect(reads).toHaveLength(2);
  });

  // Failure: a carriage return reaches the machine's shell and breaks every line it ends (POC #1499).
  it("has no carriage return", () => {
    expect(configScript()).not.toContain("\r");
  });

  // Failure: a script cut short reads as a success, because the failure it never reached is not in the report.
  it("ends by reporting that it finished", () => {
    expect(configScript().trimEnd().endsWith("echo end=ok")).toBe(true);
  });

  // Failure: the first file leaves out a setting the hand-built pod has, and the server starts with a different store.
  it("writes the hand-built pod's database and log settings", () => {
    const script = configScript();
    expect(script).toContain('[database]\nbackend = "sqlite"\npath = "/data/turnstone.db"\n');
    expect(script).toContain('[log]\nlevel = "info"\n');
  });

  // Failure: a path with a quote, a space or a shell character is pasted into a root script, and runs as code.
  it.each([["dir", "/tmp/a'b"], ["dir", "/tmp/a b"], ["subuidFile", "/etc/$(id)"], ["owner", "us;er"], ["dir", "tmp/rel"]])(
    "refuses an unsafe %s: %s",
    (key, value) => {
      expect(() => configScript({ [key]: value })).toThrow(/unsafe/);
    },
  );
});

describe("parseConfigReport", () => {
  // Failure: a report with no end line counts as complete, so a script cut off part way reads as a written file.
  it("is complete only with the end line", () => {
    expect(parseConfigReport("config=created\nend=ok\n")).toEqual({ complete: true, config: "created" });
    expect(parseConfigReport("config=created\n")).toEqual({ complete: false, config: "created" });
    expect(parseConfigReport("")).toEqual({ complete: false, config: null });
  });

  // Failure: a login banner or a carriage return from the ssh session breaks the parse, and a written file is refused.
  it("ignores lines it does not know and strips carriage returns", () => {
    expect(parseConfigReport("Welcome to the machine\r\nconfig=kept\r\nend=ok\r\n")).toEqual({
      complete: true,
      config: "kept",
    });
  });
});
