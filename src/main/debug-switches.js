const { isPackagedApp } = require("./runtime-config.js");

// Launch switches that let whoever starts a packaged build reach its signed-in server and console views:
// - remote-debugging-port and remote-debugging-pipe open Chrome DevTools over every page the app shows, the shell
//   with its bridge among them. Electron has no fuse for them: forge.config.js turns off the Node inspector, not these.
// - log-net-log writes the app's traffic to a file they choose; ssl-key-log-file writes its TLS keys to one.
// - ignore-certificate-errors and its -spki-list form turn off the checks that keep a proxy of theirs from standing in
//   for the server.
// A packaged build drops them before Electron reads them, which it does once main.js's top level has run. A proxy or
// host rule is left alone: a user may need one, and it still has to pass the certificate checks. An unpackaged run
// keeps every switch: Playwright starts the smoke tier with --remote-debugging-port=0.
const SWITCHES_TO_DROP = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "log-net-log",
  "ssl-key-log-file",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
];

// The switches to drop from a command line that answers hasSwitch, as app.commandLine does.
function switchesToDrop(commandLine, packaged = isPackagedApp()) {
  if (!packaged) return [];
  return SWITCHES_TO_DROP.filter((name) => commandLine.hasSwitch(name));
}

module.exports = { switchesToDrop };
