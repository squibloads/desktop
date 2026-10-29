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

// README cells for codes the app never shows. Those rows describe log-only or silent behaviour, so they are checked as text.
const NOT_SHOWN_CELLS = {
  NODE_TIMEOUT: "Not shown. The Console opens anyway. The message is written to the log only.",
  START_CANCELLED: "Not shown and not logged.",
  POD_STOP_FAILED: "Not shown. Written to the log only.",
};

// Returns { CODE: text } for every entry in USER_MESSAGES.
function userMessages(source) {
  const block = /const USER_MESSAGES = \{\n([\s\S]*?)\n\};/.exec(source);
  if (!block) return {};
  return Object.fromEntries([...block[1].matchAll(/([A-Z_]+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

// Codes passed directly to `new LocalRuntimeError(`, allowing the code on the next line.
function constructedCodes(source) {
  return [...source.matchAll(/new LocalRuntimeError\(\s*"([A-Z_]+)"/g)].map((m) => m[1]);
}

// Codes passed as the failCode argument of this._podman(...), the form the runner
// uses to wrap a podman failure. Only the call sites are matched, so the method's
// own definition and the ENOENT comparison are not read as codes.
function podmanFailCodes(source) {
  return [...source.matchAll(/this\._podman\([\s\S]*?"([A-Z][A-Z_]+)"\s*,?\s*\)/g)].map((m) => m[1]);
}

// Codes main.js handles: the ones it compares against and the one it shows itself.
function mainHandledCodes(source) {
  return [
    ...[...source.matchAll(/err\.code === "([A-Z_]+)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/showLocalError\(view,\s*"([A-Z_]+)"/g)].map((m) => m[1]),
  ];
}

// The message main.js shows for UNEXPECTED, which is not in USER_MESSAGES.
function mainUnexpectedMessage(source) {
  const m = /showLocalError\(view,\s*"UNEXPECTED",\s*"([^"]*)"/.exec(source);
  return m ? m[1] : null;
}

// Returns one { code, message } per row of the "Local mode errors" table.
function parseErrorTable(readme) {
  const start = readme.indexOf("### Local mode errors");
  if (start === -1) return [];
  const end = readme.indexOf("\n## ", start);
  const section = readme.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\| `([A-Z_]+)` \| ([^|]*?) \| /gm)].map((m) => ({
    code: m[1],
    message: m[2].trim(),
  }));
}

const localRuntime = read("src/main/local-runtime.js");
const mainJs = read("src/main/main.js");
const readme = read("README.md");
const messages = userMessages(localRuntime);
const thrown = [...new Set([...constructedCodes(localRuntime), ...podmanFailCodes(localRuntime)])].sort();
const handled = [...new Set(mainHandledCodes(mainJs))].sort();
const derived = [...new Set([...Object.keys(messages), ...thrown, ...handled])].sort();
const rows = parseErrorTable(readme);
const rowCodes = rows.map((row) => row.code);
const unexpectedText = mainUnexpectedMessage(mainJs);

describe("Local mode error codes", () => {
  // Failure: a thrown code has no USER_MESSAGES text, so the error page shows "undefined" with no message.
  it("every thrown code has a USER_MESSAGES entry, except UNEXPECTED which main.js sets", () => {
    const unmessaged = [...thrown, ...handled].filter(
      (code) => code !== "UNEXPECTED" && !Object.hasOwn(messages, code),
    );

    expect([...new Set(unmessaged)]).toEqual([]);
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
});
