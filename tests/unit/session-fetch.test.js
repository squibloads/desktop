import { afterEach, describe, expect, it, vi } from "vitest";

const { sessionFetch } = require("../../src/main/session-fetch.js");

// session-fetch.js requires electron only when it sends a request, so a module placed in the require cache
// stands in for Electron's net. Outside Electron, the electron package only names the binary.
const ELECTRON = require.resolve("electron");

function fakeNet(netFetch) {
  require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: { net: { fetch: netFetch } } };
}

afterEach(() => {
  delete require.cache[ELECTRON];
});

describe("sessionFetch", () => {
  // Failure: a caller's options reach Electron's fetch as they are, so a request carries the signed-in user's
  // cookies, or is answered from the HTTP cache and reads a server that has gone down as healthy.
  it("sends no cookies and skips the HTTP cache, whatever the caller asks for", async () => {
    const netFetch = vi.fn().mockResolvedValue("the response");
    fakeNet(netFetch);

    const resp = await sessionFetch("https://example.com/health", {
      credentials: "include",
      cache: "force-cache",
      redirect: "manual",
    });

    expect(resp).toBe("the response");
    expect(netFetch.mock.calls).toEqual([
      ["https://example.com/health", { credentials: "omit", cache: "no-store", redirect: "manual" }],
    ]);
  });
});
