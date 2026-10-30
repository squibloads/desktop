import http from "node:http";
import https from "node:https";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeEverything, launchApp, urlEndsWith } from "../helpers/launch-app.js";
import { pollUntil } from "../helpers/poll.js";
import { selfSignedCert } from "../helpers/self-signed-cert.js";

const servers = [];

afterEach(async () => {
  await closeEverything();
  for (const { server, sockets } of servers.splice(0)) {
    // The app holds the event stream open, and close() waits for every connection to end.
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

// A loopback port with nothing listening on it yet. The port is bound, read, and released.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Listens on the loopback port and returns it. The sockets are kept so afterEach can end them.
function serve(server, port) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  servers.push({ server, sockets });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

// A Turnstone server as the main process sees it: a healthy /health and an event stream that stays
// open. Every request is recorded with the cookie it carried.
function turnstoneServer(seen) {
  return (req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie ?? null });
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", nodes: 1, workstreams: 0 }));
      return;
    }
    if (req.url === "/v1/api/events/global") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>server</title>");
  };
}

// The shell's health dot for the server. shell.js sets the state as a class on this element.
function serverDotHas(shell, state) {
  return () => shell.evaluate((cls) => document.getElementById("server-health").classList.contains(cls), state);
}

describe("requests the main process makes", () => {
  // Failure: the health checks and the event stream use Node's fetch, which trusts only the certificate
  // authorities bundled with Node, so a server behind a private CA the system trusts loads in the views
  // but shows as disconnected and sends no notifications.
  it("trust the certificates the session trusts, and carry none of its cookies", async () => {
    const { cert, key, certBase64 } = selfSignedCert();
    const port = await freePort();
    const site = `https://127.0.0.1:${port}`;
    const app = await launchApp({ settings: { mode: "server", serverUrl: site } });

    // The session accepts this one certificate, as it would one signed by a CA installed in the system.
    // It is set before the server listens: Chromium caches a verification result, so a certificate it had
    // already refused would stay refused. The cookie stands in for a signed-in user's.
    await app.mainEvaluate(
      async ({ session }, { expected, url }) => {
        session.defaultSession.setCertificateVerifyProc((request, callback) => {
          const data = request.certificate.data.replace(/-----[^-]+-----|\s/g, "");
          callback(data === expected ? 0 : -3);
        });
        await session.defaultSession.cookies.set({ url, name: "session", value: "signed-in" });
      },
      { expected: certBase64, url: site },
    );

    const seen = [];
    await serve(https.createServer({ cert, key }, turnstoneServer(seen)), port);

    // Control: Node's own fetch refuses this server, so only the session's trust can reach it.
    await expect(fetch(`${site}/health`)).rejects.toThrow();

    await pollUntil(
      () => seen.some((r) => r.path === "/health") && seen.some((r) => r.path === "/v1/api/events/global"),
      { description: "a health check and the event stream over TLS", timeoutMs: 60_000 },
    );
    const withCookie = seen.filter(
      (r) => (r.path === "/health" || r.path === "/v1/api/events/global") && r.cookie !== null,
    );
    expect(withCookie).toEqual([]);
  });

  // Failure: Electron's fetch fails a redirect instead of returning it, so a server that answers its health
  // check with a redirect, such as one behind a sign-in page, shows as disconnected while it is up.
  it("show a health check answered with a redirect as an error, without following it", async () => {
    const seen = [];
    let redirecting = false;
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url === "/health" && redirecting) {
        res.writeHead(302, { location: "/sign-in" });
        res.end();
        return;
      }
      turnstoneServer([])(req, res);
    });
    const port = await serve(server, 0);
    const app = await launchApp({ settings: { mode: "server", serverUrl: `http://127.0.0.1:${port}` } });
    const shell = await app.findPage(urlEndsWith("shell.html"), { description: "shell window" });

    // The redirect starts once the shell is listening and the app has read a healthy answer, so the change
    // from healthy to redirected reaches the dot.
    await pollUntil(() => shell.evaluate(() => document.readyState === "complete"), {
      description: "the shell page to load",
    });
    await pollUntil(() => seen.includes("/health"), { description: "a healthy health check" });
    redirecting = true;

    await pollUntil(serverDotHas(shell, "error"), { description: "the server dot to read error" });
    const followed = seen.filter((path) => path === "/sign-in");
    expect(followed).toEqual([]);
  });
});
