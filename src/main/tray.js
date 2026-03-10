const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

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

    const active = [];
    if (server !== "disabled") active.push(server);
    if (console_ !== "disabled") active.push(console_);

    const allOk = active.length > 0 && active.every((s) => s === "ok");
    const someOk = active.some((s) => s === "ok");

    if (allOk) {
      this.tray.setImage(loadIcon("green"));
    } else if (someOk) {
      this.tray.setImage(loadIcon("yellow"));
    } else {
      this.tray.setImage(loadIcon("red"));
    }
  }

  _rebuildMenu() {
    const statusLabel = (s) => {
      if (s === "ok") return "Connected";
      if (s === "degraded") return "Degraded";
      if (s === "error") return "Error";
      if (s === "disconnected") return "Disconnected";
      return "Unknown";
    };

    const items = [];
    if (this.serverStatus !== "disabled") {
      items.push({
        label: `Server: ${statusLabel(this.serverStatus)}`,
        enabled: false,
      });
    }
    if (this.consoleStatus !== "disabled") {
      items.push({
        label: `Console: ${statusLabel(this.consoleStatus)}`,
        enabled: false,
      });
    }
    items.push(
      { type: "separator" },
      { label: "Show Window", click: this.actions.showWindow },
      { label: "Settings\u2026", click: this.actions.openSettings },
      { type: "separator" },
      { label: "Quit", click: this.actions.quit },
    );

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
