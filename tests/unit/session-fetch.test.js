import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeElectronNet, removeFakeElectron } from "../helpers/fake-electron-net.js";

const { sessionFetch, signedInFetch } = require("../../src/main/session-fetch.js");

afterEach(removeFakeElectron);

describe("sessionFetch", () => {
  // Failure: a caller's options reach Electron's fetch as they are, so a request carries the signed-in user's
  // cookies, or is answered from the HTTP cache and reads a server that has gone down as healthy.
  it("sends no cookies and skips the HTTP cache, whatever the caller asks for", async () => {
    const netFetch = vi.fn().mockResolvedValue("the response");
    fakeElectronNet(netFetch);

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

describe("signedInFetch", () => {
  // Failure: the notification poll goes without the sign-in cookie the Server view holds, so a server that needs a
  // sign-in refuses it and no notification arrives; or it is answered from the HTTP cache with states that are over.
  it("sends the session's cookies and skips the HTTP cache, whatever the caller asks for", async () => {
    const netFetch = vi.fn().mockResolvedValue("the response");
    fakeElectronNet(netFetch);

    const resp = await signedInFetch("https://example.com/v1/api/workstreams", {
      credentials: "omit",
      cache: "force-cache",
      redirect: "manual",
    });

    expect(resp).toBe("the response");
    expect(netFetch.mock.calls).toEqual([
      ["https://example.com/v1/api/workstreams", { credentials: "include", cache: "no-store", redirect: "manual" }],
    ]);
  });
});
