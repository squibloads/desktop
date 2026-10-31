// Which permissions a page in the server or console view may have. Electron approves
// every request when no handler is set, so this is the whole policy for those pages.
// No electron require here, so the rules run under plain Node in the unit tier.

// Audio capture is the one media the console needs (voice input). Video stays refused.
const ALLOWED_MEDIA = ["audio"];
// The console copies with navigator.clipboard.writeText. Nothing else in it needs a permission here.
const ALLOWED_OTHER = ["clipboard-sanitized-write"];

/** Whether a permission name, with its media types, can be granted at all. */
function permissionNameAllowed(permission, mediaTypes) {
  if (permission === "media") {
    // An empty list passes every(), and desktop capture arrives with no types, so require at least one.
    return (
      Array.isArray(mediaTypes) &&
      mediaTypes.length > 0 &&
      mediaTypes.every((type) => ALLOWED_MEDIA.includes(type))
    );
  }
  return ALLOWED_OTHER.includes(permission);
}

/** The origin of an http or https URL, or "" for anything else, so it never matches a configured origin. */
function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

/** Origins of the views the app shows. A URL for a view that is not shown grants nothing. */
function allowedOriginsFrom({ hasServer, serverUrl, hasConsole, consoleUrl }) {
  const urls = [];
  if (hasServer) urls.push(serverUrl);
  if (hasConsole) urls.push(consoleUrl);
  return urls.map(originOf).filter((origin) => origin !== "");
}

/**
 * The origin rule both handlers share. The frame's origin must be configured. A frame inside
 * another page also needs that top page configured, so a configured URL shown inside an
 * unconfigured page gets nothing.
 */
function originAllowed(origin, isMainFrame, topOrigin, allowedOrigins) {
  if (!allowedOrigins.includes(origin)) return false;
  return isMainFrame === true || allowedOrigins.includes(topOrigin);
}

/**
 * Decision for a permission request. The configured origins are read only after the
 * permission name and its media types pass, so a refused request never touches settings.
 */
function requestDecision({ permission, requestingUrl, topUrl, isMainFrame, mediaTypes }, getAllowedOrigins) {
  if (!permissionNameAllowed(permission, mediaTypes)) return false;
  return originAllowed(originOf(requestingUrl), isMainFrame, originOf(topUrl), getAllowedOrigins());
}

/**
 * Decision for a permission check, which Electron answers without a prompt. requestingOrigin
 * arrives in URL form (with a path, or userinfo), so it is reduced to an origin first.
 */
function checkDecision({ permission, requestingOrigin, topUrl, isMainFrame, mediaType }, getAllowedOrigins) {
  const mediaTypes = mediaType === undefined ? undefined : [mediaType];
  if (!permissionNameAllowed(permission, mediaTypes)) return false;
  return originAllowed(originOf(requestingOrigin), isMainFrame, originOf(topUrl), getAllowedOrigins());
}

module.exports = { permissionNameAllowed, originOf, allowedOriginsFrom, requestDecision, checkDecision };
