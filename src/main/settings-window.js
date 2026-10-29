// The settings dialog sizes itself to its content. The window never goes under
// 300 pixels (the form would be cut off) or past the work area less 120 pixels
// (the buttons would be off screen).
const MIN_HEIGHT = 300;
const WORK_AREA_MARGIN = 120;

/** A height request is usable only when it is a finite number. */
function isValidHeight(height) {
  return typeof height === "number" && Number.isFinite(height);
}

/**
 * The content height to apply, or null when the request is not a finite
 * number and must be ignored.
 */
function clampSettingsHeight(height, workAreaHeight) {
  if (!isValidHeight(height)) return null;
  const maxHeight = Math.max(MIN_HEIGHT, workAreaHeight - WORK_AREA_MARGIN);
  return Math.min(Math.max(Math.round(height), MIN_HEIGHT), maxHeight);
}

/**
 * True only when the event came from the given window contents and those
 * contents are still alive. A missing sender never matches missing contents.
 */
function isFromWindow(event, webContents) {
  if (!event || !webContents) return false;
  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    return false;
  }
  return event.sender === webContents;
}

module.exports = { clampSettingsHeight, isFromWindow, isValidHeight };
