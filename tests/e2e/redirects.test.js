import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closeEverything, launchApp, urlEndsWith, urlIs } from "../helpers/launch-app.js";
import { waitForText, waitForTitle } from "../helpers/poll.js";

// Small sites for the redirect tests. Each one answers /health as a healthy console, so the
// health poller does not reload the view on its own; every other path is the test's own.
const servers = [];

function healthy(route) {
  return (req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", nodes: 1, workstreams: 0 }));
      return;
    }
    route(req, res);
  };
}

function startSite(route) {
  return new Promise((resolve) => {
    const server = http.createServer(healthy(route));
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

afterEach(async () => {
  await closeEverything();
  for (const server of servers.splice(0)) server.close();
});

describe("console mode redirects", () => {
  // Failure: a server-side redirect to another site loads in the console view, so the page leaves the configured site without the user asking.
  it("cancels a redirect to another site, shows Redirect refused, and never reaches that site", async () => {
    let otherSiteHits = 0;
    const otherSite = await startSite((_req, res) => {
      otherSiteHits += 1;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>other site</title><body>other</body>");
    });
    const consoleSite = await startSite((_req, res) => {
      res.writeHead(302, { location: `${otherSite}/landing` });
      res.end();
    });

    const app = await launchApp({ settings: { mode: "console", consoleUrl: consoleSite } });
    const errorPage = await app.findPage(urlEndsWith("error.html"), { description: "redirect refusal page" });
    await waitForText(errorPage, "#error-title", "Redirect refused");

    expect(otherSiteHits).toBe(0);
  });

  // Failure: a redirect within the configured site is refused too, so a console that moves a page inside itself stops loading.
  it("follows a redirect that stays on the configured site", async () => {
    const consoleSite = await startSite((req, res) => {
      if (req.url === "/") {
        res.writeHead(302, { location: "/home" });
        res.end();
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>home page</title><body>home</body>");
    });

    const app = await launchApp({ settings: { mode: "console", consoleUrl: consoleSite } });
    const page = await app.findPage(urlIs(`${consoleSite}/home`), { description: "console page after the redirect" });
    await waitForTitle(page, "home page");
  });
});
