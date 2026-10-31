import { describe, it, expect } from "vitest";
import { join } from "node:path";

const { FuseV1Options, FuseVersion } = require("@electron/fuses");

const FORGE_CONFIG = join(__dirname, "..", "..", "forge.config.js");

describe("Electron fuses in a packaged build", () => {
  // Failure: a release keeps Electron's defaults, so the app binary can be started as plain Node with
  // ELECTRON_RUN_AS_NODE, take NODE_OPTIONS, or open the Node inspector with --inspect; or it loads its code from
  // somewhere other than its own app.asar, or from an app.asar that no longer matches its packaged hash. A second
  // fuses entry would override the first, since Forge runs plugins in order.
  it("are flipped by one Forge fuses plugin entry", () => {
    const { plugins } = require(FORGE_CONFIG);
    const entries = plugins.filter((plugin) => plugin.name === "@electron-forge/plugin-fuses");

    expect(entries.length).toBe(1);
    expect(entries[0].config).toEqual({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
  });

  // Failure: the plugin's name is misspelt in both the config and this test, so every PR passes and only a tag build
  // fails, when Forge cannot load the plugin.
  it("name a plugin that is installed", () => {
    expect(() => require.resolve("@electron-forge/plugin-fuses")).not.toThrow();
  });

  // Failure: asar is turned off, so a release built with OnlyLoadAppFromAsar finds no app.asar and cannot start.
  it("are paired with an app packed into app.asar", () => {
    const { packagerConfig } = require(FORGE_CONFIG);

    expect(packagerConfig.asar).toBeTruthy();
  });
});
