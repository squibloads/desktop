// Requests the main process makes go through Electron's network stack, the one the views use. Node's own
// fetch trusts only the certificate authorities bundled with Node, so a server behind a private CA that the
// system trusts would load in the views and still fail every health check and event stream. Through
// Electron, these requests trust what the views trust and use the same proxy settings.
//
// electron is required inside the function, so the modules that use this one still load under plain Node
// in the tests, which pass their own fetch.

// Electron's fetch fails a redirect it was told not to follow with this message, where Node's fetch
// returned the redirect itself. tests/e2e/main-requests.test.js fails if an Electron upgrade changes it.
const REFUSED_REDIRECT = "Redirect was cancelled";

/**
 * fetch through the default session. The session's cookies are not sent: Node's fetch never sent them, and
 * whether these requests act as the signed-in user is a separate decision from which certificates they trust.
 * The session's HTTP cache is skipped too. Node's fetch had none, and a health answer served from it would
 * read a server that has gone down as healthy.
 */
function sessionFetch(url, init = {}) {
  return require("electron").net.fetch(url, { ...init, credentials: "omit", cache: "no-store" });
}

/** Whether a request failed because it was answered with a redirect that was not followed. */
function isRefusedRedirect(err) {
  return err instanceof Error && err.message === REFUSED_REDIRECT;
}

module.exports = { sessionFetch, isRefusedRedirect };
