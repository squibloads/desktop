import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeElectronCookies, fakeElectronNet, removeFakeElectron } from "../helpers/fake-electron-net.js";

const { sessionFetch, signedInFetch, cookieDigest } = require("../../src/main/session-fetch.js");

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

describe("cookieDigest", () => {
  const cookie = (name, value) => ({ name, value, domain: "example.com", path: "/", httpOnly: true });

  // Failure: a sign-in or sign-out through the Server view leaves the digest as it was, so the notification poll keeps
  // an answer to requests sent as the user before; or the digest reads another URL's cookies.
  it("changes when a cookie the session holds for the URL changes, and reads that URL's", async () => {
    const jar = { cookies: [cookie("turnstone_auth_server", "token-u1"), cookie("theme", "dark")] };
    const get = vi.fn(async () => jar.cookies);
    fakeElectronCookies(get);

    const before = await cookieDigest("https://example.com");
    jar.cookies = [cookie("turnstone_auth_server", "token-u2"), cookie("theme", "dark")];
    const after = await cookieDigest("https://example.com");
    jar.cookies = [];
    const signedOut = await cookieDigest("https://example.com");

    expect(new Set([before, after, signedOut]).size).toBe(3);
    expect(get.mock.calls).toEqual([[{ url: "https://example.com" }], [{ url: "https://example.com" }], [{ url: "https://example.com" }]]);
  });

  // Failure: the order the store lists cookies in changes the digest, so answers are dropped while nobody signed in or
  // out; or the digest holds the sign-in token itself.
  it("depends on the cookies, not their order, and holds no cookie value", async () => {
    const jar = { cookies: [cookie("turnstone_auth_server", "token-u1"), cookie("theme", "dark")] };
    fakeElectronCookies(async () => jar.cookies);

    const first = await cookieDigest("https://example.com");
    jar.cookies = [...jar.cookies].reverse();
    const reordered = await cookieDigest("https://example.com");

    expect(reordered).toEqual(first);
    expect(first).not.toContain("token-u1");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
