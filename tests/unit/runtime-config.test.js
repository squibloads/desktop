import { afterEach, describe, it, expect } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { podmanCommand, localConsoleUrl, firstConfigError, isPackagedApp } = require("../../src/main/runtime-config.js");

// Every call passes its environment explicitly, so the shell that runs the suite cannot change a result.
// Returns the message of the error the function throws, or "" when it returns normally.
function messageOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  return "";
}

describe("podmanCommand", () => {
  // Failure: a machine with no override runs something other than podman, so Local mode fails for every user who never set the variable.
  it("runs plain podman with no leading arguments when the variable is unset", () => {
    expect(podmanCommand({})).toEqual({ file: "podman", prefixArgs: [] });
  });

  // Failure: a blank variable is read as a malformed override, so a shell that exports an empty value breaks Local mode.
  it("treats an empty value as unset", () => {
    expect(podmanCommand({ TURNSTONE_PODMAN: "" })).toEqual({ file: "podman", prefixArgs: [] });
  });

  // Failure: a valid override is split wrongly, so the smoke tier runs the real podman or passes the fake script in the wrong position.
  it("takes the first element as the executable and the rest as leading arguments", () => {
    expect(podmanCommand({ TURNSTONE_PODMAN: '["C:\\\\node.exe","C:\\\\fake-podman.js"]' })).toEqual({
      file: "C:\\node.exe",
      prefixArgs: ["C:\\fake-podman.js"],
    });
  });

  // Failure: a one-element array is rejected, so a fake that is itself the executable cannot be used.
  it("accepts a one-element array with no leading arguments", () => {
    expect(podmanCommand({ TURNSTONE_PODMAN: '["podman-fake"]' })).toEqual({ file: "podman-fake", prefixArgs: [] });
  });

  // Failure: a malformed override falls back to plain podman, so a smoke test passes against the real binary without its fake.
  it.each([
    ["not json"],
    ['{"0":"podman"}'],
    ['"podman"'],
    ["null"],
    ["[]"],
    ['[""]'],
    ['["podman",""]'],
    ["[1]"],
    ['["podman",2]'],
    ["[null]"],
    ['[["podman"]]'],
  ])("rejects TURNSTONE_PODMAN=%s by naming the variable", (value) => {
    expect(() => podmanCommand({ TURNSTONE_PODMAN: value })).toThrow(/TURNSTONE_PODMAN/);
  });
});

describe("localConsoleUrl", () => {
  // Failure: the Local Console address moves away from the README's 127.0.0.1:8090, so a fresh install opens the wrong port.
  it("returns the README address when the variable is unset or empty", () => {
    expect(localConsoleUrl({})).toBe("http://127.0.0.1:8090");
    expect(localConsoleUrl({ TURNSTONE_LOCAL_CONSOLE_URL: "" })).toBe("http://127.0.0.1:8090");
  });

  // Failure: a valid loopback override is ignored, or is returned with its path, so the smoke tier cannot point Local mode at its fake console.
  it.each([
    ["http://127.0.0.1:9191", "http://127.0.0.1:9191"],
    ["http://localhost:8091/", "http://localhost:8091"],
    ["http://[::1]:8092", "http://[::1]:8092"],
    ["http://127.0.0.1:9191/console?x=1#top", "http://127.0.0.1:9191"],
    ["http://127.0.0.1", "http://127.0.0.1"],
  ])("accepts TURNSTONE_LOCAL_CONSOLE_URL=%s and returns the origin %s", (value, origin) => {
    expect(localConsoleUrl({ TURNSTONE_LOCAL_CONSOLE_URL: value })).toBe(origin);
  });

  // Failure: a non-loopback or non-http address is accepted, so Local mode sends its health checks and console view to another host.
  it.each([
    ["https://127.0.0.1:8090"],
    ["ftp://127.0.0.1:8090"],
    ["http://example.com:8090"],
    ["http://127.0.0.2:8090"],
    ["http://0.0.0.0:8090"],
    ["http://127.0.0.1.example.com:8090"],
    ["http://user:pass@127.0.0.1:8090"],
    ["http://user@127.0.0.1:8090"],
    ["127.0.0.1:8090"],
    ["not a url"],
  ])("rejects TURNSTONE_LOCAL_CONSOLE_URL=%s by naming the variable", (value) => {
    expect(() => localConsoleUrl({ TURNSTONE_LOCAL_CONSOLE_URL: value })).toThrow(/TURNSTONE_LOCAL_CONSOLE_URL/);
  });

  // Failure: the error echoes the rejected URL, so a password typed into the override is written to the log.
  it("names the variable and never echoes a credential in the error", () => {
    const message = messageOf(() =>
      localConsoleUrl({ TURNSTONE_LOCAL_CONSOLE_URL: "http://admin:hunter2@127.0.0.1:8090" }),
    );

    expect(message).toContain("TURNSTONE_LOCAL_CONSOLE_URL");
    expect(message).not.toContain("hunter2");
  });

  // Failure: a host that only starts with a loopback name is accepted, so Local mode sends its health checks to a machine other than this PC.
  it("rejects a host that only starts with localhost", () => {
    expect(() => localConsoleUrl({ TURNSTONE_LOCAL_CONSOLE_URL: "http://localhost.evil.example:8090" })).toThrow(
      /TURNSTONE_LOCAL_CONSOLE_URL/,
    );
  });

  // Failure: the host-check error echoes the rejected value, so the password in its userinfo is written to the log.
  it("does not echo the value or its password when the host check fails", () => {
    const value = "http://user:pw@evil.example";
    const message = messageOf(() => localConsoleUrl({ TURNSTONE_LOCAL_CONSOLE_URL: value }));

    expect(message).toContain("TURNSTONE_LOCAL_CONSOLE_URL");
    expect(message).not.toContain("pw");
    expect(message).not.toContain(value);
  });
});

describe("podmanCommand error messages", () => {
  // Failure: a malformed TURNSTONE_PODMAN is echoed into the log, so a token or path typed into the variable is written out.
  it.each([["SECRET123 not json"], ['["SECRET123",2]'], ['{"SECRET123":1}'], ['"SECRET123"'], ['["SECRET123",""]']])(
    "does not repeat the raw value in the error for the bad value %s",
    (value) => {
      const message = messageOf(() => podmanCommand({ TURNSTONE_PODMAN: value }));

      expect(message).toContain("TURNSTONE_PODMAN");
      expect(message).not.toContain("SECRET123");
    },
  );
});

describe("firstConfigError", () => {
  // Failure: a machine with no overrides is reported as misconfigured, so the app refuses to start for every user who set neither variable.
  it("returns null when neither variable is set or both are empty", () => {
    expect(firstConfigError({})).toBeNull();
    expect(firstConfigError({ TURNSTONE_PODMAN: "", TURNSTONE_LOCAL_CONSOLE_URL: "" })).toBeNull();
  });

  // Failure: a correct pair of overrides is reported as an error, so the smoke tier cannot start at all.
  it("returns null when both variables are valid", () => {
    expect(
      firstConfigError({ TURNSTONE_PODMAN: '["node","fake-podman.js"]', TURNSTONE_LOCAL_CONSOLE_URL: "http://127.0.0.1:9191" }),
    ).toBeNull();
  });

  // Failure: a bad podman override is not checked at startup, so the app starts and only fails later, inside Local mode.
  it("reports a bad TURNSTONE_PODMAN when the console value is good", () => {
    expect(firstConfigError({ TURNSTONE_PODMAN: "not json", TURNSTONE_LOCAL_CONSOLE_URL: "http://127.0.0.1:9191" })).toMatch(
      /^TURNSTONE_PODMAN /,
    );
  });

  // Failure: a bad console override is not checked at startup, so the app starts with a console address it will refuse to use.
  it("reports a bad TURNSTONE_LOCAL_CONSOLE_URL when the podman value is good", () => {
    expect(firstConfigError({ TURNSTONE_PODMAN: '["node","fake-podman.js"]', TURNSTONE_LOCAL_CONSOLE_URL: "http://example.com" })).toMatch(
      /^TURNSTONE_LOCAL_CONSOLE_URL /,
    );
  });

  // Failure: with both values bad, the message names the console variable, so the developer fixes the wrong one first.
  it("reports the podman error first when both values are bad", () => {
    expect(firstConfigError({ TURNSTONE_PODMAN: "not json", TURNSTONE_LOCAL_CONSOLE_URL: "http://example.com" })).toMatch(
      /^TURNSTONE_PODMAN /,
    );
  });

  // Failure: the dialog receives an object or a differently worded message, so the user sees text that does not name the variable.
  it("returns the thrown message as a plain string", () => {
    expect(firstConfigError({ TURNSTONE_LOCAL_CONSOLE_URL: "ftp://127.0.0.1" })).toBe(
      "TURNSTONE_LOCAL_CONSOLE_URL must use the http: scheme",
    );
  });
});

describe("a packaged build", () => {
  const OVERRIDES = { TURNSTONE_PODMAN: '["other-program.exe"]', TURNSTONE_LOCAL_CONSOLE_URL: "http://127.0.0.1:9191" };

  // Failure: a release reads TURNSTONE_PODMAN, so whoever can set the user's environment swaps podman for any program;
  // or it reads TURNSTONE_LOCAL_CONSOLE_URL and moves Local mode to another port.
  it("ignores both overrides, and runs podman against the README address", () => {
    expect(podmanCommand(OVERRIDES, true)).toEqual({ file: "podman", prefixArgs: [] });
    expect(localConsoleUrl(OVERRIDES, true)).toBe("http://127.0.0.1:8090");
  });

  // Failure: a malformed override stops a release at start, though the release never reads it.
  it("starts with malformed values, which it never reads", () => {
    expect(firstConfigError({ TURNSTONE_PODMAN: "not json", TURNSTONE_LOCAL_CONSOLE_URL: "http://example.com" }, true)).toBeNull();
  });

  // Failure: an unpackaged run, as the smoke tier is, ignores the overrides too, so it reaches the real podman.
  it("is the only kind of run that ignores them", () => {
    expect(podmanCommand(OVERRIDES, false)).toEqual({ file: "other-program.exe", prefixArgs: [] });
    expect(localConsoleUrl(OVERRIDES, false)).toBe("http://127.0.0.1:9191");
  });
});

describe("isPackagedApp", () => {
  // Failure: a release, which runs this module from inside app.asar on every platform Forge builds for, reads the
  // overrides.
  it.each([
    ["C:\\Users\\u\\AppData\\Local\\turnstone_desktop\\app-0.1.1\\resources\\app.asar\\src\\main\\runtime-config.js"],
    ["/usr/lib/turnstone-desktop/resources/app.asar/src/main/runtime-config.js"],
    ["/Applications/Turnstone.app/Contents/Resources/app.asar/src/main/runtime-config.js"],
    ["/tmp/.mount_TurnstXYZ/resources/app.asar.unpacked/src/main/runtime-config.js"],
  ])("is true for a file inside app.asar: %s", (filename) => {
    expect(isPackagedApp(filename)).toBe(true);
  });

  // Failure: a checkout, which npm start and the smoke tier run from, counts as packaged, so the smoke tier ignores its
  // fakes and reaches the real podman; or a directory whose name only contains app.asar does.
  it.each([
    ["E:\\Git_repos\\turnstone-desktop\\src\\main\\runtime-config.js"],
    ["/home/u/myapp.asar/src/main/runtime-config.js"],
    ["/home/u/app.asar-notes/src/main/runtime-config.js"],
  ])("is false for a file outside app.asar: %s", (filename) => {
    expect(isPackagedApp(filename)).toBe(false);
  });

  // Failure: the unit tier, which runs this module from the checkout, counts as packaged, so the override tests above
  // stop reading the overrides.
  it("is false for this module in the checkout", () => {
    expect(isPackagedApp()).toBe(false);
  });

  describe("for a copy of the module inside app.asar", () => {
    let root;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    // Failure: a function reads the overrides unless its caller says the app is packaged, and the app's callers never
    // say so, so a release still reads them.
    it("is what every function asks when its caller does not say", () => {
      root = mkdtempSync(join(tmpdir(), "runtime-config-"));
      const dir = join(root, "resources", "app.asar", "src", "main");
      mkdirSync(dir, { recursive: true });
      copyFileSync(require.resolve("../../src/main/runtime-config.js"), join(dir, "runtime-config.js"));
      const packaged = createRequire(join(dir, "index.js"))("./runtime-config.js");
      const env = { TURNSTONE_PODMAN: "not json", TURNSTONE_LOCAL_CONSOLE_URL: "http://example.com" };

      expect(packaged.isPackagedApp()).toBe(true);
      expect(packaged.podmanCommand(env)).toEqual({ file: "podman", prefixArgs: [] });
      expect(packaged.localConsoleUrl(env)).toBe("http://127.0.0.1:8090");
      expect(packaged.firstConfigError(env)).toBeNull();
    });
  });
});
