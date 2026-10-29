import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

// The codes the app can show or log, pinned. Adding a code to the source changes
// the derived set, so this list and a README row must change with it.
const CODES = [
  "HEALTH_TIMEOUT",
  "MACHINE_LIST_FAILED",
  "MACHINE_MISSING",
  "MACHINE_START_FAILED",
  "NODE_TIMEOUT",
  "PODMAN_NOT_FOUND",
  "POD_MISSING",
  "POD_START_FAILED",
  "POD_STOP_FAILED",
  "START_CANCELLED",
  "UNEXPECTED",
];

// README cells for codes the app never shows. The source pins below show what keeps each one silent, so these rows are checked as text.
const NOT_SHOWN_CELLS = {
  NODE_TIMEOUT: "Not shown. The Console opens anyway. The message is written to the log only.",
  START_CANCELLED: "Not shown and not logged.",
  POD_STOP_FAILED: "Not shown. Written to the log only.",
};

// A code written as a string literal, in either quote style.
const LITERAL_CODE = /^(["'])([A-Z][A-Z0-9_]*)\1$/;

// Returns the top-level argument texts of the call whose "(" is at index `open`. Commas inside
// quotes or brackets do not split arguments, and a trailing comma adds no argument.
function callArgs(source, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += source[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) {
        if (current.trim() !== "") args.push(current.trim());
        return args;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  return args;
}

// The first argument of every `new LocalRuntimeError(` call, in source order. Works across lines.
function constructorFirstArgs(source) {
  return [...source.matchAll(/new LocalRuntimeError\(/g)].map(
    (m) => callArgs(source, m.index + m[0].length - 1)[0] ?? "",
  );
}

// The second argument (the failCode) of every `this._podman(` call, in source order.
// The method's own definition has no `this.` and is not matched.
function podmanFailCodeArgs(source) {
  return [...source.matchAll(/this\._podman\(/g)].map(
    (m) => callArgs(source, m.index + m[0].length - 1)[1] ?? "",
  );
}

// The code an argument names as a string literal, or null when it is a variable or an expression.
function literalCode(arg) {
  const m = LITERAL_CODE.exec(arg);
  return m ? m[2] : null;
}

// Codes passed directly to `new LocalRuntimeError(`, in either quote style.
function constructedCodes(source) {
  return constructorFirstArgs(source).map(literalCode).filter((code) => code !== null);
}

// Codes passed as the failCode argument of this._podman(...), the form the runner
// uses to wrap a podman failure.
function podmanFailCodes(source) {
  return podmanFailCodeArgs(source).map(literalCode).filter((code) => code !== null);
}

// The second argument of every `this._wrap(` call that has one, in source order. `this._wrap(err)`
// has no failCode and adds nothing. The method's own definition has no `this.` and is not matched.
function wrapFailCodeArgs(source) {
  return [...source.matchAll(/this\._wrap\(/g)]
    .map((m) => callArgs(source, m.index + m[0].length - 1)[1])
    .filter((arg) => arg !== undefined);
}

// Codes passed as the failCode argument of this._wrap(...), the form that turns a podman
// error into a LocalRuntimeError.
function wrapFailCodes(source) {
  return wrapFailCodeArgs(source).map(literalCode).filter((code) => code !== null);
}

// Codes main.js handles: the ones it compares against and the one it shows itself, in either quote style.
function mainHandledCodes(source) {
  return [
    ...[...source.matchAll(/err\.code === ["']([A-Z][A-Z0-9_]*)["']/g)].map((m) => m[1]),
    ...[...source.matchAll(/showLocalError\(view,\s*["']([A-Z][A-Z0-9_]*)["']/g)].map((m) => m[1]),
  ];
}

// The message main.js shows for UNEXPECTED, which is not in USER_MESSAGES.
function mainUnexpectedMessage(source) {
  const m = /showLocalError\(view,\s*["']UNEXPECTED["'],\s*(["'])(.*?)\1/.exec(source);
  return m ? m[2] : null;
}

// Each { key, text } entry of USER_MESSAGES, in source order. Duplicates are kept so that a
// caller can see them; an object literal would keep only the last one. Keys may be bare or quoted.
function userMessageEntries(source) {
  const block = /const USER_MESSAGES = \{\n([\s\S]*?)\n\};/.exec(source);
  if (!block) return [];
  return [...block[1].matchAll(/["']?\b([A-Z][A-Z0-9_]*)["']?:\s*(["'])((?:(?!\2)[^\n])*)\2/g)].map((m) => ({
    key: m[1],
    text: m[3],
  }));
}

// Returns { CODE: text } for every entry in USER_MESSAGES.
function userMessages(source) {
  return Object.fromEntries(userMessageEntries(source).map((e) => [e.key, e.text]));
}

// Returns one { code, message } per row of the "Local mode errors" table.
function parseErrorTable(readme) {
  const start = readme.indexOf("### Local mode errors");
  if (start === -1) return [];
  const end = readme.indexOf("\n## ", start);
  const section = readme.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \| ([^|]*?) \| /gm)].map((m) => ({
    code: m[1],
    message: m[2].trim(),
  }));
}

const localRuntime = read("src/main/local-runtime.js");
const mainJs = read("src/main/main.js");
const readme = read("README.md");
const messages = userMessages(localRuntime);
const thrown = [...new Set([...constructedCodes(localRuntime), ...podmanFailCodes(localRuntime), ...wrapFailCodes(localRuntime)])].sort();
const handled = [...new Set(mainHandledCodes(mainJs))].sort();
const derived = [...new Set([...Object.keys(messages), ...thrown, ...handled])].sort();
const rows = parseErrorTable(readme);
const rowCodes = rows.map((row) => row.code);
const unexpectedText = mainUnexpectedMessage(mainJs);

describe("Local mode error codes", () => {
  // Failure: a LocalRuntimeError with no userMessage is reported as UNEXPECTED ("Local startup failed unexpectedly."), so the user loses the specific code and message.
  it("every thrown code has a USER_MESSAGES entry, except UNEXPECTED which main.js sets", () => {
    const unmessaged = [...new Set([...thrown, ...handled])].filter(
      (code) => code !== "UNEXPECTED" && !Object.hasOwn(messages, code),
    );

    expect(unmessaged).toEqual([]);
  });

  // Failure: a code is added in the source but the README table is not updated, so users are told nothing about it.
  it("the derived code set matches the pinned list", () => {
    expect(derived).toEqual(CODES);
  });

  // Failure: the README lists a code the app never produces, so a support reader looks for a failure that cannot happen.
  it("the README table has no row for an unknown code", () => {
    const unknown = rowCodes.filter((code) => !derived.includes(code));

    expect(unknown).toEqual([]);
  });

  // Failure: a code the app can produce has no README row, so the on-screen message has no "what to check" entry.
  it("the README table has a row for every code", () => {
    const missing = derived.filter((code) => !rowCodes.includes(code));

    expect(missing).toEqual([]);
  });

  // Failure: a code has two README rows that disagree, so the reader sees a different instruction depending on which one they find.
  it("the README table has exactly one row per code", () => {
    const duplicates = rowCodes.filter((code, i) => rowCodes.indexOf(code) !== i);

    expect(duplicates).toEqual([]);
  });

  // Failure: the message a user sees on the error page drifts from the message the README tells them to expect.
  it("the README message equals USER_MESSAGES for every code the app shows", () => {
    const shown = derived.filter((code) => !Object.hasOwn(NOT_SHOWN_CELLS, code));
    const messageFor = (code) => (code === "UNEXPECTED" ? unexpectedText : messages[code]);
    const mismatched = shown.filter((code) => {
      const row = rows.find((r) => r.code === code);
      return !row || row.message !== messageFor(code);
    });

    expect(mismatched).toEqual([]);
  });

  // Failure: a code the app does not show is documented as shown, or its log-only note is reworded without anyone reviewing it.
  it("the README says the not-shown codes are not shown, with the pinned text", () => {
    const actual = {};
    for (const code of Object.keys(NOT_SHOWN_CELLS)) {
      const row = rows.find((r) => r.code === code);
      actual[code] = row ? row.message : null;
    }

    expect(actual).toEqual({
      NODE_TIMEOUT: "Not shown. The Console opens anyway. The message is written to the log only.",
      START_CANCELLED: "Not shown and not logged.",
      POD_STOP_FAILED: "Not shown. Written to the log only.",
    });
  });

  // Failure: a source change makes START_CANCELLED, NODE_TIMEOUT or POD_STOP_FAILED visible, or drops the handling that keeps it silent, and the README's not-shown rows are then wrong with no test noticing.
  it("main.js keeps the not-shown codes silent: START_CANCELLED returns, NODE_TIMEOUT opens the Console, the quit stop is caught", () => {
    const startCancelled = /if \(err\.code === "START_CANCELLED"\) return;/.exec(mainJs);
    expect(startCancelled, "START_CANCELLED early return was not found in main.js").not.toBeNull();

    const nodeTimeout = /if \(err\.code === "NODE_TIMEOUT"\) \{\n\s*console\.warn\([^\n]*\);\n\s*loadLocalConsole\(view\);\n\s*return;\n\s*\}/.exec(mainJs);
    expect(nodeTimeout, "NODE_TIMEOUT branch that calls loadLocalConsole(view) and returns before showLocalError was not found in main.js").not.toBeNull();

    const quitStop = /localRuntime\s*\.stop\(\)\s*\.catch\(/.exec(mainJs);
    expect(quitStop, "quit-path localRuntime.stop() with a .catch( was not found in main.js").not.toBeNull();
  });

  // Failure: a code is thrown with a variable instead of a literal, so the USER_MESSAGES and README checks never see it and the refactor passes silently.
  it("has no non-literal code at any call site, except the failCode forwarders in _wrap and _podman", () => {
    const ctor = constructorFirstArgs(localRuntime);
    const forwarded = ctor.filter((arg) => arg === "failCode");
    const variableCtor = ctor.filter((arg) => arg !== "failCode" && literalCode(arg) === null);
    const variablePodman = podmanFailCodeArgs(localRuntime).filter((arg) => literalCode(arg) === null);
    const variableWrap = wrapFailCodeArgs(localRuntime).filter((arg) => arg !== "failCode" && literalCode(arg) === null);

    expect(variableCtor).toEqual([]);
    expect(variablePodman).toEqual([]);
    expect(variableWrap).toEqual([]);
    expect(forwarded).toEqual(["failCode"]);
  });

  // Failure: USER_MESSAGES has the same key twice, and the later entry silently replaces the earlier, so one text is never shown.
  it("USER_MESSAGES has no duplicate keys", () => {
    const keys = userMessageEntries(localRuntime).map((e) => e.key);
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i);

    expect(duplicates).toEqual([]);
  });

  // Failure: the table parser silently misses a row, so every table check above passes against a README with a row removed.
  it("detector control: the table parser reports a removed row as missing", () => {
    const withoutHealth = readme.replace(/^\| `HEALTH_TIMEOUT` \|.*\n/m, "");
    const codes = parseErrorTable(withoutHealth).map((row) => row.code);

    expect(CODES.filter((code) => !codes.includes(code))).toEqual(["HEALTH_TIMEOUT"]);
  });

  // Failure: a duplicated or invented README row goes unreported by the parser, so a stale row survives review.
  it("detector control: the table parser reports a duplicate and an unknown row", () => {
    const edited = readme.replace(
      /^(\| `HEALTH_TIMEOUT` \|.*\n)/m,
      "$1| `HEALTH_TIMEOUT` | Duplicate. | Duplicate. |\n| `FAKE_CODE` | Not a code. | Not a code. |\n",
    );
    const codes = parseErrorTable(edited).map((row) => row.code);

    expect(codes.filter((code, i) => codes.indexOf(code) !== i)).toEqual(["HEALTH_TIMEOUT"]);
    expect(codes.filter((code) => !CODES.includes(code))).toEqual(["FAKE_CODE"]);
  });

  // Failure: a multi-line `new LocalRuntimeError(` call is not seen, so a code thrown there is never checked against USER_MESSAGES.
  it("detector control: finds a constructor code written on the next line", () => {
    const sample = 'throw new LocalRuntimeError(\n          "HEALTH_TIMEOUT",\n          `x`,\n        );';

    expect(constructedCodes(sample)).toEqual(["HEALTH_TIMEOUT"]);
  });

  // Failure: a code written with single quotes is missed by every extractor, so a single-quoted code is never checked at all.
  it("detector control: single-quoted codes are read at every call form", () => {
    const sample = [
      "throw new LocalRuntimeError('HEALTH_TIMEOUT', 'x');",
      "await this._podman(['pod', 'start'], 'POD_START_FAILED');",
      "if (err.code === 'START_CANCELLED') return;",
      "showLocalError(view, 'NODE_TIMEOUT', 'm');",
    ].join("\n");

    expect(constructedCodes(sample)).toEqual(["HEALTH_TIMEOUT"]);
    expect(podmanFailCodes(sample)).toEqual(["POD_START_FAILED"]);
    expect(mainHandledCodes(sample)).toEqual(["START_CANCELLED", "NODE_TIMEOUT"]);
  });

  // Failure: a literal code passed to this._wrap is not read, so a podman failure wrapped with an unknown code passes every check.
  it("detector control: a literal _wrap failCode is counted as thrown, a variable one as non-literal", () => {
    const sample = [
      'throw this._wrap(err, "MACHINE_LIST_NOT_ARRAY");',
      "throw this._wrap(err, failCode);",
      "throw this._wrap(err);",
    ].join("\n");

    expect(wrapFailCodeArgs(sample)).toEqual(['"MACHINE_LIST_NOT_ARRAY"', "failCode"]);
    expect(wrapFailCodes(sample)).toEqual(["MACHINE_LIST_NOT_ARRAY"]);
    expect(wrapFailCodeArgs(sample).filter((arg) => literalCode(arg) === null)).toEqual(["failCode"]);
  });

  // Failure: a variable code is passed to either call form and the non-literal check counts nothing, so the refactor passes silently.
  it("detector control: a variable code is counted at both call forms", () => {
    const sample = [
      'throw new LocalRuntimeError(code, "x");',
      "await this._podman(args, failCode);",
      "throw new LocalRuntimeError('HEALTH_TIMEOUT', 'x');",
    ].join("\n");

    expect(constructorFirstArgs(sample).filter((arg) => literalCode(arg) === null)).toEqual(["code"]);
    expect(podmanFailCodeArgs(sample).filter((arg) => literalCode(arg) === null)).toEqual(["failCode"]);
  });

  // Failure: a duplicate USER_MESSAGES key with identical text is not reported, because the object literal keeps one entry and the text still matches.
  it("detector control: a duplicate USER_MESSAGES key is reported even with identical text", () => {
    const sample = [
      "const USER_MESSAGES = {",
      '  POD_MISSING: "The pod is missing.",',
      '  POD_MISSING: "The pod is missing.",',
      "  HEALTH_TIMEOUT:",
      "    'Timed out.',",
      "};",
    ].join("\n");
    const keys = userMessageEntries(sample).map((e) => e.key);
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i);

    expect(keys).toEqual(["POD_MISSING", "POD_MISSING", "HEALTH_TIMEOUT"]);
    expect(duplicates).toEqual(["POD_MISSING"]);
  });
});
