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

    await app.mainEvaluate(({ session }) => {
      session.defaultSession.on("will-download", (_event, item) => {
        globalThis.__download = item;
      });
    });

    await page.click("#get");
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const seen = await app.mainEvaluate(() => {
      const item = globalThis.__download;
      if (!item) return null;
      const state = { filename: item.getFilename(), savePath: item.getSavePath(), state: item.getState() };
      item.cancel();
      return state;
    });
    expect(seen).not.toBeNull();
    expect(seen.filename).toBe("report.txt");
    expect(seen.savePath).toBe("");
  });
});
