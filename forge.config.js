module.exports = {
  packagerConfig: {
    name: "Turnstone",
    executableName: "turnstone-desktop",
    icon: "./src/icons/icon",
    asar: true,
    appBundleId: "com.turnstone.desktop",
    appCategoryType: "public.app-category.developer-tools",
  },
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
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
      config: { name: "turnstone-desktop" },
    },
    // Linux — AppImage (single file, chmod +x and run)
    {
      name: "electron-forge-maker-appimage",
      platforms: ["linux"],
      config: {},
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
