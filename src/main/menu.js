const { Menu, app } = require("electron");
const { buildMenuTemplate } = require("./menu-template.js");

function setupMenu(actions) {
  const template = buildMenuTemplate({
    isMac: process.platform === "darwin",
    mode: actions.mode,
    appName: app.name,
    actions,
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { setupMenu };
