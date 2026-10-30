import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAIN_DIR = join(__dirname, "..", "..", "src", "main");

// The code of a file with its comments removed, so a comment that mentions fetch( is not a call.
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// A call to Node's global fetch. A fetch( preceded by a dot or a word character is a method or another
// name, such as net.fetch( or this._fetch(, so it does not count.
const GLOBAL_FETCH = /(?<![\w$.])fetch\s*\(|globalThis\s*\.\s*fetch\b/;

describe("requests from the main process", () => {
  // Failure: a main-process module calls Node's fetch, which trusts only the certificate authorities bundled
  // with Node, so a server behind a CA the system trusts loads in the views but fails the app's own requests.
  it("never use Node's global fetch", () => {
    const offenders = readdirSync(MAIN_DIR)
      .filter((name) => name.endsWith(".js"))
      .filter((name) => GLOBAL_FETCH.test(code(readFileSync(join(MAIN_DIR, name), "utf8"))));

    expect(offenders).toEqual([]);
  });

  // Failure: the detector matches nothing, or matches the session's fetch, so the check above proves nothing.
  it("detects a global fetch call and not the session's", () => {
    expect(GLOBAL_FETCH.test("const resp = await fetch(url, init);")).toBe(true);
    expect(GLOBAL_FETCH.test("return globalThis.fetch(url);")).toBe(true);
    expect(GLOBAL_FETCH.test('return require("electron").net.fetch(url, init);')).toBe(false);
    expect(GLOBAL_FETCH.test("const resp = await this._fetch(url, init);")).toBe(false);
    expect(GLOBAL_FETCH.test(code("// Node's fetch(url) is not used here\n"))).toBe(false);
  });
});
