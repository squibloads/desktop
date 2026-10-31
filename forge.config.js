const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  packagerConfig: {
    name: "Turnstone",
    executableName: "turnstone-desktop",
    asar: true,
    appBundleId: "com.turnstone.desktop",
    appCategoryType: "public.app-category.developer-tools",
  },
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    // Electron's fuses, flipped in the packaged binary. The app never runs itself as Node, takes no Node options and
    // needs no Node inspector, so a release turns those off: otherwise the binary can be started as plain Node
    // (ELECTRON_RUN_AS_NODE) or with the inspector (--inspect). Chromium's --remote-debugging-port is not a fuse, so
    // this does not cover it. The app also loads only its own app.asar, checked against the hash stored at packaging
    // on Windows and macOS (Electron does not check it on Linux). No build is signed yet, so that hash can be rewritten
    // along with app.asar: today it catches a damaged archive, not a deliberate edit.
    // Left at Electron's defaults: cookie encryption (one-way, and on macOS it needs the Keychain, which waits for
    // signing) and the file:// privileges the app's own pages are served with.
    // tests/contract/fuses.test.js keeps these settings.
    {
      name: "@electron-forge/plugin-fuses",
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      },
    },
  ],
  makers: [
    // macOS — single .dmg disk image
    {
      name: "@electron-forge/maker-dmg",
      config: { format: "ULFO" },
    },
    // macOS — .zip fallback (for Sparkle/Squirrel auto-update)
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    // Windows — single Setup.exe (auto-installs to %LOCALAPPDATA%, no admin)
    {
      name: "@electron-forge/maker-squirrel",
      config: { name: "turnstone-desktop", authors: "Turnstone Labs" },
    },
    // Linux — AppImage (single file, chmod +x and run)
    {
      name: "@reforged/maker-appimage",
      platforms: ["linux"],
    },
    // Linux — .deb package for Debian/Ubuntu
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          maintainer: "Turnstone",
          homepage: "https://github.com/turnstonelabs/turnstone",
        },
      },
    },
  ],
};
