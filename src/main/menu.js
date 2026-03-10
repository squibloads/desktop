const { Menu, app } = require("electron");

function setupMenu(actions) {
  const isMac = process.platform === "darwin";
  const showTabs = actions.mode === "both";

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings\u2026",
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
                label: "Settings\u2026",
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

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { setupMenu };
