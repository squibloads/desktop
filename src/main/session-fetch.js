// Requests the main process makes go through Electron's network stack, the one the views use. Node's own
// fetch trusts only the certificate authorities bundled with Node, so a server behind a private CA that the
// system trusts would load in the views and still fail every health check and notification poll. Through
// Electron, these requests trust what the views trust and use the same proxy settings.
//
// electron is required inside the function, so the modules that use this one still load under plain Node
// in the tests, which pass their own fetch.

// Electron's fetch fails a redirect it was told not to follow with this message, where Node's fetch
// returned the redirect itself. tests/e2e/main-requests.test.js fails if an Electron upgrade changes it.
const REFUSED_REDIRECT = "Redirect was cancelled";

/**
 * fetch through the default session. The session's cookies are not sent: a health check needs no sign-in, so it
 * does not act as the signed-in user. The session's HTTP cache is skipped too. Node's fetch had none, and a
 * health answer served from it would read a server that has gone down as healthy.
 */
function sessionFetch(url, init = {}) {
  return require("electron").net.fetch(url, { ...init, credentials: "omit", cache: "no-store" });
}

/**
 * fetch through the default session as the user signed in to the Server view: the session's cookies for the URL
 * are sent. Only the notification poll uses it (tests/contract/main-process-fetch.test.js checks this), because
 * the server answers it only for a signed-in user. The HTTP cache is skipped, as for sessionFetch.
 */
function signedInFetch(url, init = {}) {
  return require("electron").net.fetch(url, { ...init, credentials: "include", cache: "no-store" });
}

/**
 * A digest of the cookies the session holds for the URL, which signedInFetch sends there. It changes when a user
 * signs in or out through the Server view, so the notification poll can drop an answer to requests sent as the user
 * before. Only a digest is returned, so the poll never holds the sign-in token.
 */
async function cookieDigest(url) {
  const cookies = await require("electron").session.defaultSession.cookies.get({ url });
  const pairs = cookies.map(({ name, value }) => `${name}=${value}`).sort();
  return require("node:crypto").createHash("sha256").update(pairs.join("\n")).digest("hex");
}

/** Whether a request failed because it was answered with a redirect that was not followed. */
function isRefusedRedirect(err) {
  return err instanceof Error && err.message === REFUSED_REDIRECT;
}

module.exports = { sessionFetch, signedInFetch, cookieDigest, isRefusedRedirect };
