import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const MAIN_DIR = join(__dirname, "..", "..", "src", "main");

// Node's own network modules. Electron's net is required as electron, so it is not one of them.
const NODE_NETWORK = new Set(["http", "https", "http2", "net", "tls", "undici"]);

// Each node of the syntax tree, with the node that holds it and the key it is held under.
function* walk(node, parent = null, key = null) {
  yield { node, parent, key };
  for (const [childKey, value] of Object.entries(node)) {
    for (const child of [value].flat()) {
      if (child && typeof child.type === "string") yield* walk(child, node, childKey);
    }
  }
}

// A name that is not a variable: a property after a dot, or a key in an object or a class.
function isPropertyName(parent, key) {
  if (parent.computed) return false;
  if (parent.type === "MemberExpression") return key === "property";
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type)) return key === "key";
  return false;
}

/**
 * What in a source could reach Node's networking instead of the session's: the name fetch, which here can only
 * be Node's global; the global object, through which fetch is reached without naming it; and a require or
 * import of one of Node's network modules. The source is parsed, so comments and strings never count.
 */
function nodeNetworkUses(source) {
  const uses = [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, locations: true });
  for (const { node, parent, key } of walk(tree)) {
    if (node.type === "Identifier" && ["fetch", "global", "globalThis"].includes(node.name) && !(parent && isPropertyName(parent, key))) {
      uses.push(`${node.loc.start.line}: ${node.name}`);
    }
    const loaded =
      node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require"
        ? node.arguments[0]
        : node.type === "ImportExpression"
          ? node.source
          : null;
    if (loaded?.type === "Literal" && NODE_NETWORK.has(String(loaded.value).replace(/^node:/, ""))) {
      uses.push(`${node.loc.start.line}: ${loaded.value}`);
    }
  }
  return uses;
}

describe("requests from the main process", () => {
  // Failure: a main-process module reaches Node's fetch or its network modules, which trust only the certificate
  // authorities bundled with Node, so a server behind a CA the system trusts loads in the views but fails the
  // app's own requests.
  it("never go through Node's networking", () => {
    const uses = {};
    for (const name of readdirSync(MAIN_DIR).filter((file) => file.endsWith(".js"))) {
      const found = nodeNetworkUses(readFileSync(join(MAIN_DIR, name), "utf8"));
      if (found.length > 0) uses[name] = found;
    }

    expect(uses).toEqual({});
  });

  // Failure: the detector misses a way of reaching Node's networking, or flags the session's fetch, a comment or
  // a string, so the check above proves nothing.
  it("detects Node's networking however it is reached, and nothing else", () => {
    expect(nodeNetworkUses("fetch(url);")).toEqual(["1: fetch"]);
    expect(nodeNetworkUses("const send = fetch;")).toEqual(["1: fetch"]);
    expect(nodeNetworkUses("fetch?.(url); fetch.call(null, url);")).toEqual(["1: fetch", "1: fetch"]);
    expect(nodeNetworkUses("global.fetch(url);")).toEqual(["1: global"]);
    expect(nodeNetworkUses('globalThis["fetch"](url);')).toEqual(["1: globalThis"]);
    expect(nodeNetworkUses("const { fetch: send } = globalThis;")).toEqual(["1: globalThis"]);
    expect(nodeNetworkUses('require("node:https"); require("undici");')).toEqual(["1: node:https", "1: undici"]);
    expect(nodeNetworkUses('import("http");')).toEqual(["1: http"]);
    expect(nodeNetworkUses('const page = "http://example.com"; fetch(page);')).toEqual(["1: fetch"]);

    const clean = [
      'const resp = require("electron").net.fetch(url, init);',
      "this._fetch(url);",
      "const options = { fetch: send };",
      "function make({ fetch: fetchImpl = send } = {}) { return fetchImpl; }",
      "// fetch(url) in a comment",
      'const text = "fetch(url) in a string";',
      "const stream = `${base}/v1/api/events/global`;",
    ].join("\n");
    expect(nodeNetworkUses(clean)).toEqual([]);
  });
});
