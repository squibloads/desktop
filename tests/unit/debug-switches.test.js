import { afterEach, describe, it, expect } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { switchesToDrop } = require("../../src/main/debug-switches.js");

// A command line holding the given switches, as app.commandLine answers hasSwitch.
const commandLine = (...switches) => ({ hasSwitch: (name) => switches.includes(name) });

// Every switch a packaged build drops.
const DROPPED = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "log-net-log",
  "ssl-key-log-file",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
];

describe("switchesToDrop", () => {
  // Failure: a packaged build keeps a switch that lets whoever starts it with an argument reach the signed-in views:
  // Chrome DevTools over its pages, its traffic or TLS keys written to a file they choose, or certificate checks off so
  // a proxy of theirs can stand in for the server.
  it.each(DROPPED.map((name) => [name]))("drops --%s from a packaged build", (name) => {
    expect(switchesToDrop(commandLine(name), true)).toEqual([name]);
  });

  // Failure: a packaged build started with several of them keeps all but the first.
  it("drops every one of them it was started with", () => {
    expect(switchesToDrop(commandLine(...DROPPED), true)).toEqual(DROPPED);
  });

  // Failure: a packaged build drops a switch it was not started with, or a network setting a user may need, such as a
  // proxy, which still has to pass the certificate checks.
  it("drops nothing else from a packaged build", () => {
    expect(switchesToDrop(commandLine(), true)).toEqual([]);
    const kept = ["remote-allow-origins", "net-log-capture-mode", "proxy-server", "proxy-bypass-list", "host-resolver-rules", "lang", "no-sandbox"];
    expect(switchesToDrop(commandLine(...kept), true)).toEqual([]);
  });

  // Failure: an unpackaged run loses the port Playwright passes, so the smoke tier cannot drive the app, or a developer
  // loses the net log they asked for.
  it("drops nothing from an unpackaged run", () => {
    expect(switchesToDrop(commandLine(...DROPPED), false)).toEqual([]);
  });

  // Failure: the unit tier, which runs from the checkout, counts as packaged.
  it("treats this checkout as unpackaged when the caller does not say", () => {
    expect(switchesToDrop(commandLine("remote-debugging-port"))).toEqual([]);
  });

  describe("for a copy of the module inside app.asar", () => {
    let root;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    // Failure: the rule never asks whether the app is packaged, so main.js, which passes nothing, keeps the switches
    // in a release.
    it("drops the switches when the caller does not say", () => {
      root = mkdtempSync(join(tmpdir(), "debug-switches-"));
      const dir = join(root, "resources", "app.asar", "src", "main");
      mkdirSync(dir, { recursive: true });
      for (const file of ["debug-switches.js", "runtime-config.js"]) {
        copyFileSync(require.resolve(`../../src/main/${file}`), join(dir, file));
      }
      const packaged = createRequire(join(dir, "index.js"))("./debug-switches.js");

      expect(packaged.switchesToDrop(commandLine(...DROPPED))).toEqual(DROPPED);
    });
  });
});
