import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PRELOAD = join(fileURLToPath(new URL("../..", import.meta.url)), "src", "preload", "preload.js");
const source = readFileSync(PRELOAD, "utf8");

// Runs preload.js as Electron does, for a page at `protocol`. Returns the object
// the preload offered the page through contextBridge, or null when it offered none.
function exposedBy(protocol) {
  let exposed = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        if (name === "electronAPI") exposed = api;
      },
    },
    ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} },
  };
  const sandbox = {
    require: (id) => {
      if (id !== "electron") throw new Error(`unexpected require: ${id}`);
      return electron;
    },
    location: { protocol },
    process: { platform: "win32" },
  };
  vm.runInNewContext(source, sandbox);
  return exposed;
}

describe("preload exposure", () => {
  // Failure: a page loaded from a configured server or console gets the settings bridge, so it can point the app at another site.
  it.each(["https:", "http:"])("offers the bridge to no page served over %s", (protocol) => {
    expect(exposedBy(protocol)).toBeNull();
  });

  // Failure: the app's own pages lose the bridge, so Settings, the shell and the error pages stop working.
  it("offers the bridge to the app's own file pages", () => {
    const api = exposedBy("file:");

    expect(api).not.toBeNull();
    expect(typeof api.saveSettings).toBe("function");
  });
});
