import { describe, it, expect } from "vitest";

const { podmanCommand, localConsoleUrl } = require("../../src/main/runtime-config.js");

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
});
