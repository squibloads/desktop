// A stand-in for the Turnstone Console. It answers /health with the status and node
// count the test sets, and serves a small page for every other path. It binds
// 127.0.0.1 only, on the port it is given (0 picks a free one).
//
// Tests wait on the health read count rather than on time: a count that has gone up
// shows the app polled the node check, without a fixed delay.

import http from "node:http";

// A port another process still holds, or one this process released a moment ago, can refuse the
// bind for a short while. Those refusals are retried. Port 0 never clashes, so it is not retried.
const LISTEN_RETRIES = 20;
const LISTEN_RETRY_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFakeConsole({ nodes = 1, health = "ok" } = {}) {
  const state = { nodes, status: health };
  let server = null;
  let port = 0;
  let healthHits = 0;
  const sockets = new Set();

  function handle(req, res) {
    // One request per connection, so a stopped server never leaves a kept-alive socket behind.
    res.setHeader("connection", "close");
    if (req.url === "/health") {
      healthHits += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: state.status, nodes: state.nodes, workstreams: 0 }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><html><head><title>fake console</title></head><body><h1>console</h1></body></html>",
    );
  }

  function bindOnce(requestedPort) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer(handle);
      candidate.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      candidate.once("error", reject);
      candidate.listen(requestedPort, "127.0.0.1", () => {
        candidate.off("error", reject);
        resolve(candidate);
      });
    });
  }

  async function listen(requestedPort) {
    for (let retry = 0; ; retry += 1) {
      try {
        return await bindOnce(requestedPort);
      } catch (err) {
        if (err.code !== "EADDRINUSE" || requestedPort === 0) throw err;
        if (retry === LISTEN_RETRIES) {
          throw new Error(
            `fake console could not bind 127.0.0.1:${requestedPort}: still in use after ${LISTEN_RETRIES} retries`,
          );
        }
        await sleep(LISTEN_RETRY_MS);
      }
    }
  }

  async function start(requestedPort = 0) {
    if (server) throw new Error("fake console is already running");
    const bound = await listen(requestedPort);
    server = bound;
    port = bound.address().port;
  }

  async function stop() {
    if (!server) return;
    const closing = server;
    server = null;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolve) => closing.close(resolve));
  }

  return {
    start,
    stop,
    // Stops, then listens on the port the last start bound, so the app's saved URL still points here.
    async restartOnSamePort() {
      const same = port;
      await stop();
      await start(same);
    },
    setNodes(n) {
      state.nodes = n;
    },
    setHealth(status) {
      state.status = status;
    },
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    get healthHits() {
      return healthHits;
    },
  };
}
