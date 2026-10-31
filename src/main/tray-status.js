// Tray icon and menu decisions, kept free of electron so they can be tested under
// plain Node. tray.js supplies the Tray and Menu objects.

/**
 * Labels for a surface's status. Anything not listed, including a status the server has not
 * reported yet, reads as Unknown rather than an empty label. A refused address is a fault, so
 * it reads as one rather than as switched off.
 */
function statusLabel(s) {
  if (s === "ok") return "Connected";
  if (s === "degraded") return "Degraded";
  if (s === "error") return "Error";
  if (s === "disconnected") return "Disconnected";
  if (s === "refused") return "Address refused";
  return "Unknown";
}

/**
 * The tray's line for the notification status notifications.js reports. A stopped manager reports null, and a
 * status not listed has no line, so the tray never claims notifications work when nothing says so.
 */
function notificationLabel(status) {
  if (status === "on") return "Notifications: On";
  if (status === "signed-out") return "Notifications: Sign in to the server";
  if (status === "refused") return "Notifications: Refused by the server";
  if (status === "waiting") return "Notifications: Waiting for the server";
  return null;
}

// A surface switched off in settings is not a fault, so it does not count
// against the icon. With nothing active the icon is red.
function trayIconName(server, console_) {
  const active = [];
  if (server !== "disabled") active.push(server);
  if (console_ !== "disabled") active.push(console_);

  const allOk = active.length > 0 && active.every((s) => s === "ok");
  const someOk = active.some((s) => s === "ok");

  if (allOk) return "green";
  if (someOk) return "yellow";
  return "red";
}

// Status rows are informational, so they are disabled. Click handlers are the
// caller's functions, passed through unchanged.
function buildTrayMenuTemplate(serverStatus, consoleStatus, actions, notificationStatus = null) {
  const items = [];
  if (serverStatus !== "disabled") {
    items.push({
      label: `Server: ${statusLabel(serverStatus)}`,
      enabled: false,
    });
  }
  if (consoleStatus !== "disabled") {
    items.push({
      label: `Console: ${statusLabel(consoleStatus)}`,
      enabled: false,
    });
  }
  const notifications = notificationLabel(notificationStatus);
  if (notifications) {
    items.push({ label: notifications, enabled: false });
  }
  items.push(
    { type: "separator" },
    { label: "Show Window", click: actions.showWindow },
    { label: "Settings…", click: actions.openSettings },
    { type: "separator" },
    { label: "Quit", click: actions.quit },
  );
  return items;
}

module.exports = { statusLabel, notificationLabel, trayIconName, buildTrayMenuTemplate };
