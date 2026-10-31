import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { closeEverything, launchApp, urlEndsWith } from "../helpers/launch-app.js";
import { pollUntil } from "../helpers/poll.js";
import { selfSignedCert } from "../helpers/self-signed-cert.js";

const servers = [];

afterEach(async () => {
  try {
    await closeEverything();
  } finally {
    for (const { server, sockets } of servers.splice(0)) {
      // A test can leave a request unanswered, and close() waits for every connection to end.
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

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

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// The notification poll: who is signed in, then the workstreams.
const POLL_PATHS = ["/v1/api/auth/whoami", "/v1/api/workstreams"];

// A Turnstone server as the main process sees it: a healthy /health, and a poll answered for a signed-in user with
// no workstreams. Every request is recorded with the cookie it carried.
function turnstoneServer(seen) {
  return (req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie ?? null });
    if (req.url === "/health") return sendJson(res, { status: "ok", nodes: 1, workstreams: 0 });
    if (req.url === "/v1/api/auth/whoami") return sendJson(res, { user_id: "u1" });
    if (req.url === "/v1/api/workstreams") return sendJson(res, { workstreams: [] });
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>server</title>");
  };
}

// The shell's health dot for the server. shell.js sets the state as a class on this element.
function serverDotHas(shell, state) {
  return () => shell.evaluate((cls) => document.getElementById("server-health").classList.contains(cls), state);
}

describe("requests the main process makes", () => {
  // Failure: the health checks and the notification poll use Node's fetch, which trusts only the certificate
  // authorities bundled with Node, so a server behind a private CA the system trusts loads in the views but shows
  // as disconnected and sends no notifications. Or a health check carries the signed-in user's cookies.
  it("trust the certificates the session trusts, and carry its cookies only on the notification poll", async () => {
    const { cert, key, certBase64 } = selfSignedCert();
    const seen = [];
    const port = await serve(https.createServer({ cert, key }, turnstoneServer(seen)), 0);
    const site = `https://127.0.0.1:${port}`;
    // The app starts on another server and is moved to this one only once the session is set up, so every
    // request it sends here starts after the session accepts the certificate and holds the cookie. Chromium
    // caches a verification result, and a request carries the cookies that existed when it started.
    const first = await serve(http.createServer(turnstoneServer([])), 0);
    const app = await launchApp({ settings: { mode: "server", serverUrl: `http://127.0.0.1:${first}` } });

    // The session accepts this one certificate, as it would one signed by a CA installed in the system.
    // The cookie stands in for a signed-in user's.
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

    // Control: Node's own fetch refuses this server, so only the session's trust can reach it.
    await expect(fetch(`${site}/health`)).rejects.toThrow();

    await app.clickMenuItem("Settings…");
    const settingsPage = await app.findPage(urlEndsWith("settings.html"), { description: "settings window" });
    const saved = await settingsPage.evaluate(
      (serverUrl) => window.electronAPI.saveSettings({ mode: "server", serverUrl }),
      site,
    );
    expect(saved).toEqual({ ok: true });

    await pollUntil(
      () => seen.some((r) => r.path === "/health") && seen.some((r) => r.path === "/v1/api/workstreams"),
      { description: "a health check and a notification poll over TLS" },
    );
    const healthWithCookie = seen.filter((r) => r.path === "/health" && r.cookie !== null);
    const pollWithoutCookie = seen.filter((r) => POLL_PATHS.includes(r.path) && r.cookie !== "session=signed-in");
    expect(healthWithCookie).toEqual([]);
    expect(pollWithoutCookie).toEqual([]);
  });

  // Failure: notifications need a token no signed-in user has, so none arrives after the user signs in through the
  // Server view; or another user's workstream notifies; or the poll sends the user's cookie before it was set.
  it("deliver notifications once the user signs in through the server view", async () => {
    const seen = [];
    const TOKEN = "turnstone_auth_server=signed-in-token";
    const states = { w1: "running", w2: "running" };
    const server = http.createServer((req, res) => {
      const cookie = req.headers.cookie ?? null;
      seen.push({ path: req.url, cookie });
      if (req.url === "/sign-in") {
        // The server's own sign-in sets its cookie the same way.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
        });
        res.end("<!doctype html><title>signed in</title>");
        return;
      }
      if (POLL_PATHS.includes(req.url)) {
        const signedIn = cookie !== null && cookie.split("; ").includes(TOKEN);
        if (!signedIn) return sendJson(res, { error: "Unauthorized: missing or invalid token" }, 401);
        if (req.url === "/v1/api/auth/whoami") return sendJson(res, { user_id: "u1" });
        return sendJson(res, {
          workstreams: [
            { ws_id: "w1", name: "Build", state: states.w1, user_id: "u1" },
            { ws_id: "w2", name: "Someone else's", state: states.w2, user_id: "u2" },
          ],
        });
      }
      turnstoneServer([])(req, res);
    });
    const port = await serve(server, 0);
    const site = `http://127.0.0.1:${port}`;
    const app = await launchApp({ settings: { mode: "server", serverUrl: site } });

    // Notifications are recorded instead of shown, and count as supported on a system without a notification service.
    const patched = await app.mainEvaluate(({ Notification }) => {
      globalThis.shownNotifications = [];
      Notification.isSupported = () => true;
      Notification.prototype.show = function show() {
        globalThis.shownNotifications.push({ title: this.title, body: this.body });
      };
      return Notification.prototype.show.toString().includes("shownNotifications") && Notification.isSupported();
    });
    expect(patched).toBe(true);
    const shown = () => app.mainEvaluate(() => globalThis.shownNotifications);

    await pollUntil(() => seen.some((r) => r.path === "/v1/api/auth/whoami"), {
      description: "a poll before the sign-in",
    });

    // The user signs in through the Server view, which receives the server's cookie.
    await app.mainEvaluate(
      ({ webContents }, origin) => {
        const view = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin));
        return view.loadURL(`${origin}/sign-in`);
      },
      site,
    );
    await pollUntil(() => seen.some((r) => r.path === "/v1/api/workstreams" && r.cookie?.includes(TOKEN)), {
      description: "a poll that carries the sign-in cookie",
    });

    states.w1 = "attention";
    states.w2 = "attention";
    await pollUntil(async () => (await shown()).length > 0, { description: "a notification" });

    expect(await shown()).toEqual([{ title: "Turnstone: Attention Needed", body: "Build requires your input" }]);
    const signInAt = seen.findIndex((r) => r.path === "/sign-in");
    const cookieBeforeSignIn = seen.slice(0, signInAt).filter((r) => r.cookie !== null);
    const listBeforeSignIn = seen.slice(0, signInAt).filter((r) => r.path === "/v1/api/workstreams");
    const healthWithCookie = seen.filter((r) => r.path === "/health" && r.cookie !== null);
    expect(cookieBeforeSignIn).toEqual([]);
    expect(listBeforeSignIn).toEqual([]);
    expect(healthWithCookie).toEqual([]);
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

  // Failure: the main process's requests go through the session's HTTP cache, which Node's fetch never had, so a
  // health answer that allowed caching, such as one a proxy marked, keeps the dot healthy after the server fails.
  it("ask the server every time, even when an answer allowed caching", async () => {
    const seen = [];
    let failing = false;
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      if (req.url === "/health" && failing) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=3600" });
        res.end(JSON.stringify({ status: "ok", nodes: 1, workstreams: 0 }));
        return;
      }
      turnstoneServer([])(req, res);
    });
    const port = await serve(server, 0);
    const app = await launchApp({ settings: { mode: "server", serverUrl: `http://127.0.0.1:${port}` } });
    const shell = await app.findPage(urlEndsWith("shell.html"), { description: "shell window" });

    // The server fails once the shell is listening and the app has read the answer that allowed caching.
    await pollUntil(() => shell.evaluate(() => document.readyState === "complete"), {
      description: "the shell page to load",
    });
    await pollUntil(() => seen.includes("/health"), { description: "a cacheable healthy answer" });
    failing = true;

    await pollUntil(serverDotHas(shell, "error"), { description: "the server dot to read error" });
  });

  // Failure: Electron's fetch keeps a connection open after its body is cancelled, so a poll refused with an error
  // page that never ends leaves one more connection open every 10 seconds.
  it("close the connection of a refused poll before asking again", async () => {
    const polls = { refused: 0, open: 0 };
    const server = http.createServer((req, res) => {
      if (req.url !== "/v1/api/auth/whoami") {
        turnstoneServer([])(req, res);
        return;
      }
      polls.refused += 1;
      polls.open += 1;
      // The error page never ends, so only the app can close this connection.
      res.writeHead(503, { "content-type": "text/plain" });
      const feed = setInterval(() => res.write("unavailable\n".repeat(64)), 20);
      res.on("close", () => {
        clearInterval(feed);
        polls.open -= 1;
      });
    });
    const port = await serve(server, 0);
    await launchApp({ settings: { mode: "server", serverUrl: `http://127.0.0.1:${port}` } });

    // Polls come every 10 seconds, so the second comes about 10 seconds after the first.
    await pollUntil(() => polls.refused >= 2 && polls.open === 0, {
      description: "two refused polls, none left open",
    });
  });

  // Failure: a poll whose answer never comes is waited on for ever, so one stalled request ends notifications until
  // the app restarts.
  it("give up on a poll that gets no answer, and close its connection", async () => {
    const polls = { started: 0, open: 0 };
    const server = http.createServer((req, res) => {
      if (req.url !== "/v1/api/auth/whoami") {
        turnstoneServer([])(req, res);
        return;
      }
      polls.started += 1;
      polls.open += 1;
      // No answer is ever sent, so only the app can end this request.
      res.on("close", () => {
        polls.open -= 1;
      });
    });
    const port = await serve(server, 0);
    await launchApp({ settings: { mode: "server", serverUrl: `http://127.0.0.1:${port}` } });

    await pollUntil(() => polls.started >= 1 && polls.open === 0, {
      description: "a poll with no answer, given up",
    });
  });
});
