const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const { trayIconName, buildTrayMenuTemplate } = require("./tray-status.js");

const ICONS_DIR = path.join(__dirname, "../icons");

function loadIcon(name) {
  return nativeImage.createFromPath(path.join(ICONS_DIR, `tray-${name}.png`));
}

class TurnStoneTray {
  constructor(actions) {
    this.actions = actions;
    this.tray = null;
    this.serverStatus = "unknown";
    this.consoleStatus = "unknown";
  }

  create() {
    this.tray = new Tray(loadIcon("gray"));
    this.tray.setToolTip("Turnstone");
    this._rebuildMenu();
    this.tray.on("click", this.actions.showWindow);
  }

  updateStatus(server, console_) {
    this.serverStatus = server;
    this.consoleStatus = console_;
    this._rebuildMenu();
    this.tray.setImage(loadIcon(trayIconName(server, console_)));
  }

  _rebuildMenu() {
    const items = buildTrayMenuTemplate(this.serverStatus, this.consoleStatus, this.actions);
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TurnStoneTray };
