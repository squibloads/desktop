// Application menu structure, kept free of electron so the layout and the
// accelerators can be tested under plain Node. menu.js supplies the platform,
// the app name and the actions, then builds the real Menu.

// Server and Console tabs only exist in "both" mode, so the shortcuts are
// omitted in single-view modes where switching would have nothing to switch to.
function buildMenuTemplate({ isMac, mode, appName, actions }) {
  const showTabs = mode === "both";

  return [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: actions.openSettings,
              },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(!isMac
          ? [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: actions.openSettings,
              },
              { type: "separator" },
            ]
          : []),
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...(showTabs
          ? [
              {
                label: "Server",
                accelerator: "CmdOrCtrl+1",
                click: () => actions.switchTab("server"),
              },
              {
                label: "Console",
                accelerator: "CmdOrCtrl+2",
                click: () => actions.switchTab("console"),
              },
              { type: "separator" },
            ]
          : []),
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: actions.reloadActiveView,
        },
        {
          label: "Toggle Developer Tools",
          accelerator: "CmdOrCtrl+Shift+I",
          click: actions.toggleDevTools,
        },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },
  ];
}

module.exports = { buildMenuTemplate };
