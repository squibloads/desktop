import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closeEverything, launchApp, urlIs } from "../helpers/launch-app.js";

const servers = [];

afterEach(async () => {
  await closeEverything();
  for (const server of servers.splice(0)) server.close();
});

// A console that answers /health as healthy, a page with a download link, and an attachment.
function startConsole() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok", nodes: 1, workstreams: 0 }));
        return;
      }
      if (req.url === "/report.txt") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        res.end("quarterly numbers\n");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<!doctype html><title>console</title><a id="get" href="/report.txt">report</a>');
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

describe("downloads from the configured console", () => {
  // Failure: a download from the console is written to the Downloads folder with no prompt, so a page the user did not choose can place files there.
  it("waits for the user to choose a save location before it writes the file", async () => {
    const site = await startConsole();
    const app = await launchApp({ settings: { mode: "console", consoleUrl: site } });
    const page = await app.findPage(urlIs(`${site}/`), { description: "console page" });

    // The listener must be in place before the click, so its registration is awaited first. It never rejects,
    // so a slow click cannot leave a rejection with no handler in the main process.
    await app.mainEvaluate(({ session }) => {
      globalThis.__started = new Promise((resolve) => {
        session.defaultSession.once("will-download", (_event, item) => {
          globalThis.__download = item;
          resolve();
        });
      });
    });

    await page.click("#get");
    // The bound starts after the click, so the time the click takes does not count against the download.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("no download started")), 10_000);
    });
    try {
      await Promise.race([app.mainEvaluate(() => globalThis.__started), timeout]);
    } finally {
      clearTimeout(timer);
    }
    // A download that is still pending after a moment is waiting for the user to choose a location.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const seen = await app.mainEvaluate(() => {
      const item = globalThis.__download;
      const state = { filename: item.getFilename(), savePath: item.getSavePath(), state: item.getState() };
      item.cancel();
      return state;
    });
    expect(seen.filename).toBe("report.txt");
    // A cancelled dialog is terminal, so the state must still be progressing for the dialog to be open.
    expect(seen.state).toBe("progressing");
    expect(seen.savePath).toBe("");
  });
});
