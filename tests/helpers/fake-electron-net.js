// A stand-in for Electron's net, for unit tests of main-process modules that require electron only when they
// send a request. The fake goes into Node's require cache, where that lazy require finds it. Outside Electron,
// the electron package only names the binary, so the real one cannot stand in.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ELECTRON = require.resolve("electron");

/** Makes require("electron").net.fetch the given function, until removeFakeElectron() runs. */
export function fakeElectronNet(netFetch) {
  require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: { net: { fetch: netFetch } } };
}

/** Makes require("electron").session.defaultSession.cookies.get the given function, until removeFakeElectron() runs. */
export function fakeElectronCookies(get) {
  const exports = { session: { defaultSession: { cookies: { get } } } };
  require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports };
}

export function removeFakeElectron() {
  delete require.cache[ELECTRON];
}
