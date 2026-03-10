const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

class TurnStoneTray {
  constructor(actions) {
    this.actions = actions;
    this.tray = null;
    this.serverStatus = "unknown";
    this.consoleStatus = "unknown";
  }

  create() {
    // Create a simple 16x16 tray icon programmatically (colored circle)
    this.tray = new Tray(this._createIcon("#8a93ad"));
    this.tray.setToolTip("Turnstone");
    this._rebuildMenu();
    this.tray.on("click", this.actions.showWindow);
  }

  updateStatus(server, console_) {
    this.serverStatus = server;
    this.consoleStatus = console_;
    this._rebuildMenu();

    // Determine icon color from active statuses only
    const active = [];
    if (server !== "disabled") active.push(server);
    if (console_ !== "disabled") active.push(console_);

    const allOk = active.length > 0 && active.every((s) => s === "ok");
    const someOk = active.some((s) => s === "ok");

    if (allOk) {
      this.tray.setImage(this._createIcon("#34d399"));
    } else if (someOk) {
      this.tray.setImage(this._createIcon("#fbbf24"));
    } else {
      this.tray.setImage(this._createIcon("#f87171"));
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

  _createIcon(color) {
    // Generate a 16x16 PNG with a colored circle
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4);

    const cx = size / 2,
      cy = size / 2,
      r = 6;
    const [cr, cg, cb] = this._hexToRgb(color);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt((x - cx + 0.5) ** 2 + (y - cy + 0.5) ** 2);
        const idx = (y * size + x) * 4;

        if (dist <= r) {
          const alpha = dist > r - 1 ? Math.max(0, r - dist) : 1;
          canvas[idx] = cr;
          canvas[idx + 1] = cg;
          canvas[idx + 2] = cb;
          canvas[idx + 3] = Math.round(alpha * 255);
        } else {
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = 0;
        }
      }
    }

    return nativeImage.createFromBitmap(canvas, { width: size, height: size });
  }

  _hexToRgb(hex) {
    const h = hex.replace("#", "");
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ];
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TurnStoneTray };
