import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";

const MAIN_DIR = join(__dirname, "..", "..", "src", "main");

// Node's own network modules. Electron's net is required as electron, so it is not one of them.
const NODE_NETWORK = new Set(["http", "https", "http2", "net", "tls", "undici"]);

// Globals that send requests through Node, plus the global object itself, through which they are reached
// without being named. EventSource is behind a flag in Node today, so it is named before it can arrive.
const NODE_GLOBALS = ["fetch", "WebSocket", "EventSource", "global", "globalThis"];

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

// A call that loads a module by name: require(), module.require(), process.getBuiltinModule() or import().
function loadsModule(node) {
  if (node.type === "ImportExpression") return true;
  if (node.type !== "CallExpression") return false;
  const { callee } = node;
  if (callee.type === "Identifier") return callee.name === "require";
  if (callee.type !== "MemberExpression" || callee.computed || callee.object.type !== "Identifier") return false;
  const name = `${callee.object.name}.${callee.property.name}`;
  return name === "module.require" || name === "process.getBuiltinModule";
}

// The module name a load call writes out, as a string or a template with nothing filled in.
function moduleName(node) {
  const arg = node.type === "ImportExpression" ? node.source : node.arguments[0];
  if (arg?.type === "Literal" && typeof arg.value === "string") return arg.value;
  if (arg?.type === "TemplateLiteral" && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  return null;
}

/**
 * What in a source could reach Node's networking instead of the session's: one of NODE_GLOBALS by name, which
 * here can only be Node's own; and a load of one of Node's network modules. The source is parsed, so comments
 * and strings never count.
 */
function nodeNetworkUses(source) {
  const uses = [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, locations: true });
  for (const { node, parent, key } of walk(tree)) {
    if (node.type === "Identifier" && NODE_GLOBALS.includes(node.name) && !(parent && isPropertyName(parent, key))) {
      uses.push(`${node.loc.start.line}: ${node.name}`);
    }
    const name = loadsModule(node) ? moduleName(node) : null;
    if (name !== null && NODE_NETWORK.has(name.replace(/^node:/, ""))) {
      uses.push(`${node.loc.start.line}: ${name}`);
    }
  }
  return uses;
}

// Every name a source writes as a variable, a property or a string. A module that reaches something by name, by
// any route, names it, while a comment that mentions it does not count.
function namesIn(source) {
  const names = new Set();
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
  for (const { node } of walk(tree)) {
    if (node.type === "Identifier") names.add(node.name);
    if (node.type === "Literal" && typeof node.value === "string") names.add(node.value);
  }
  return names;
}

// What reaches past the rules session-fetch.js sets: the fetch that sends the signed-in user's cookies, and
// Electron's net itself, which takes whatever cookie and cache options it is given.
const PAST_THE_RULES = ["signedInFetch", "net"];

// The same name, as a key or a property.
function isNamed(node, computed, name) {
  return computed ? node.type === "Literal" && node.value === name : node.type === "Identifier" && node.name === name;
}

/**
 * Where a source takes a fetch from an object: session.defaultSession.fetch or a view's webContents.session.fetch,
 * which are Electron's net.fetch without the name net and send the session's cookies by default. A parameter
 * written { fetch: fetchImpl = sessionFetch } takes what its caller passes, not a property of an object, so it does
 * not count.
 */
function fetchTakenFromObject(source) {
  const found = [];
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, locations: true });
  for (const { node, parent, key } of walk(tree)) {
    if (node.type === "MemberExpression" && isNamed(node.property, node.computed, "fetch")) {
      found.push(`${node.loc.start.line}: .fetch`);
    }
    const destructured =
      node.type === "ObjectPattern" &&
      ((parent?.type === "VariableDeclarator" && key === "id") || (parent?.type === "AssignmentExpression" && key === "left"));
    for (const prop of destructured ? node.properties : []) {
      if (prop.type === "Property" && isNamed(prop.key, prop.computed, "fetch")) found.push(`${prop.loc.start.line}: { fetch }`);
    }
  }
  return found;
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
    expect(nodeNetworkUses('new WebSocket("wss://example.com");')).toEqual(["1: WebSocket"]);
    expect(nodeNetworkUses("new EventSource(url);")).toEqual(["1: EventSource"]);
    expect(nodeNetworkUses('require(`https`); module.require("tls"); process.getBuiltinModule("node:net");')).toEqual([
      "1: https",
      "1: tls",
      "1: node:net",
    ]);
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

  // Failure: a request that needs no sign-in, such as a health check, is sent with the signed-in user's cookies,
  // or a module calls Electron's net, or a session's fetch, itself and skips the rules for cookies and the cache.
  it("send the user's cookies only from the notification poll, and reach Electron's network only in session-fetch.js", () => {
    const reach = {};
    for (const name of readdirSync(MAIN_DIR).filter((file) => file.endsWith(".js") && file !== "session-fetch.js")) {
      const source = readFileSync(join(MAIN_DIR, name), "utf8");
      const names = namesIn(source);
      const found = [...PAST_THE_RULES.filter((target) => names.has(target)), ...fetchTakenFromObject(source)];
      if (found.length > 0) reach[name] = found;
    }

    expect(reach).toEqual({ "notifications.js": ["signedInFetch"] });
  });

  // Failure: the check above misses a session's fetch, so a health check written with one sends the user's cookies
  // and every test still passes; or it flags a fetch passed in by a caller, which every module here takes.
  it("finds a fetch taken from an object, and not one passed in", () => {
    expect(fetchTakenFromObject("session.defaultSession.fetch(url);")).toEqual(["1: .fetch"]);
    expect(fetchTakenFromObject('view.webContents.session["fetch"](url);')).toEqual(["1: .fetch"]);
    expect(fetchTakenFromObject("const { fetch: send } = session.defaultSession;")).toEqual(["1: { fetch }"]);
    expect(fetchTakenFromObject("let send; ({ fetch: send } = ses);")).toEqual(["1: { fetch }"]);

    const clean = [
      "class Poller { constructor(settings, { fetch: fetchImpl = sessionFetch } = {}) { this._fetch = fetchImpl; } }",
      "function make({ fetch } = {}) { return fetch; }",
      "this._fetch(url);",
      "const options = { fetch: send };",
      "// session.defaultSession.fetch(url) in a comment",
    ].join("\n");
    expect(fetchTakenFromObject(clean)).toEqual([]);
  });

  // Failure: the name check misses a route to the signed-in fetch or to Electron's net, or counts a comment, so
  // the check above proves nothing.
  it("finds a name however it is reached, and not in a comment", () => {
    expect(namesIn('require("./session-fetch.js").signedInFetch(url);').has("signedInFetch")).toBe(true);
    expect(namesIn('const { signedInFetch: send } = require("./session-fetch.js");').has("signedInFetch")).toBe(true);
    expect(namesIn('const { net } = require("electron");').has("net")).toBe(true);
    expect(namesIn('require("electron").net.fetch(url);').has("net")).toBe(true);
    expect(namesIn('require("electron")["net"].fetch(url);').has("net")).toBe(true);
    expect(namesIn("// signedInFetch and net in a comment\nconst network = 1;").has("signedInFetch")).toBe(false);
    expect(namesIn("// signedInFetch and net in a comment\nconst network = 1;").has("net")).toBe(false);
  });
});
