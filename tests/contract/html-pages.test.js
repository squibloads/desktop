import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RENDERER_DIR = join(__dirname, "..", "..", "src", "renderer");

// Every renderer page this suite has classified. A new .html file fails the
// first test until it is added here, with a CSP entry or a PAGES_WITHOUT_CSP entry.
const PAGES = [
  "error.html",
  "local-error.html",
  "local-loading.html",
  "settings.html",
  "shell.html",
];

// The CSP each page declares today, pinned per page. No script-src directive is
// present, so script-src falls back to default-src 'self', which allows no inline script.
const CSP_BY_PAGE = {
  "error.html": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;",
  "local-error.html": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;",
  "local-loading.html": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;",
  "settings.html": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;",
  "shell.html": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;",
};

// Pages with no Content-Security-Policy meta. Empty today: every page above declares one.
// A page is listed here only with a reason, because a page without a CSP can run inline script.
const PAGES_WITHOUT_CSP = [];

// The effective script-src of each page: its own script-src, or default-src when it has none.
const SCRIPT_SRC_BY_PAGE = {
  "error.html": "'self'",
  "local-error.html": "'self'",
  "local-loading.html": "'self'",
  "settings.html": "'self'",
  "shell.html": "'self'",
};

// Local script and stylesheet references per page, in document order.
const LOCAL_REFS_BY_PAGE = {
  "error.html": ["tokens.css", "error.js"],
  "local-error.html": ["tokens.css", "local-error.js"],
  "local-loading.html": ["tokens.css", "local-loading.js"],
  "settings.html": ["tokens.css", "settings.js"],
  "shell.html": ["shell.css", "shell.js"],
};

function read(name) {
  return readFileSync(join(RENDERER_DIR, name), "utf8").replace(/\r\n/g, "\n");
}

// Returns the opening <script> tag of each script that has no src and each
// script with a src and a non-empty body. The tag stands in for the element.
function inlineScriptFindings(html) {
  const findings = [];
  for (const open of html.matchAll(/<script\b([^>]*)>/gi)) {
    const start = open.index + open[0].length;
    const close = html.indexOf("</script>", start);
    const body = close === -1 ? html.slice(start) : html.slice(start, close);
    if (!/\bsrc\s*=/i.test(open[1]) || body.trim() !== "") findings.push(open[0]);
  }
  return findings;
}

// Returns every tag with an inline event-handler attribute such as onclick=.
function inlineHandlerFindings(html) {
  return (html.match(/<[a-zA-Z][^>]*>/g) || []).filter((tag) => /\son[a-z]+\s*=/i.test(tag));
}

// Returns the src or href of each script or link that points at a local file.
// External URLs and fragments are skipped; their hosts are not part of this check.
function localRefs(html) {
  const refs = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) || []) {
    const attr = /\s(?:src|href)\s*=\s*"([^"]*)"/i.exec(tag);
    if (!attr) continue;
    if (/^(?:[a-z]+:|\/\/|#)/i.test(attr[1])) continue;
    refs.push(attr[1]);
  }
  return refs;
}

// Returns the content of the CSP meta, or null when the page declares none.
function cspOf(html) {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return meta ? meta[1] : null;
}

// Returns the value of script-src, or of default-src when script-src is absent.
function effectiveScriptSrc(csp) {
  const directives = csp.split(";").map((d) => d.trim());
  const directive =
    directives.find((d) => d.startsWith("script-src ")) ??
    directives.find((d) => d.startsWith("default-src "));
  return directive ? directive.split(/\s+/).slice(1).join(" ") : "";
}

describe("renderer HTML pages", () => {
  // Failure: a new page ships without its CSP, inline-script and reference checks ever running on it.
  it("classifies every renderer page", () => {
    const onDisk = readdirSync(RENDERER_DIR).filter((name) => name.endsWith(".html")).sort();
    const classified = [...Object.keys(CSP_BY_PAGE), ...PAGES_WITHOUT_CSP].sort();

    expect(onDisk).toEqual(PAGES);
    expect(classified).toEqual(PAGES);
  });

  // Failure: an inline script under a CSP that blocks it leaves a button dead, as Settings and Retry were on the error page.
  it("has no inline script in any page", () => {
    const found = {};
    for (const page of PAGES) {
      const findings = inlineScriptFindings(read(page));
      if (findings.length > 0) found[page] = findings;
    }

    expect(found).toEqual({});
  });

  // Failure: an onclick attribute is added, which the page's CSP blocks, so the control does nothing.
  it("has no inline event-handler attribute in any page", () => {
    const found = {};
    for (const page of PAGES) {
      const findings = inlineHandlerFindings(read(page));
      if (findings.length > 0) found[page] = findings;
    }

    expect(found).toEqual({});
  });

  // Failure: a script or stylesheet is renamed on disk, so the page loads a 404 and renders unstyled or without its script.
  it("every local script and stylesheet resolves to a file in src/renderer", () => {
    const missing = {};
    for (const page of PAGES) {
      const unresolved = localRefs(read(page)).filter((ref) => !existsSync(join(RENDERER_DIR, ref)));
      if (unresolved.length > 0) missing[page] = unresolved;
    }

    expect(missing).toEqual({});
  });

  // Failure: the reference scan finds nothing on a page, so the resolve check above passes without checking it.
  it("pins the local references each page loads", () => {
    const actual = {};
    for (const page of PAGES) actual[page] = localRefs(read(page));

    expect(actual).toEqual(LOCAL_REFS_BY_PAGE);
  });

  // Failure: a page's CSP is weakened or removed, and nothing notices because no test reads it.
  it("declares the pinned CSP on every page, and no page lacks one unclassified", () => {
    const withCsp = {};
    const withoutCsp = [];
    for (const page of PAGES) {
      const csp = cspOf(read(page));
      if (csp === null) withoutCsp.push(page);
      else withCsp[page] = csp;
    }

    expect(withoutCsp).toEqual(PAGES_WITHOUT_CSP);
    expect(withCsp).toEqual(CSP_BY_PAGE);
  });

  // Failure: a page's script-src gains 'unsafe-inline', which re-enables inline script that the rest of this suite assumes is blocked.
  it("resolves script-src to 'self' on every page, with no 'unsafe-inline'", () => {
    const scriptSrc = {};
    for (const page of Object.keys(CSP_BY_PAGE)) scriptSrc[page] = effectiveScriptSrc(CSP_BY_PAGE[page]);
    const unsafe = Object.keys(scriptSrc).filter((page) => scriptSrc[page].includes("'unsafe-inline'"));

    expect(scriptSrc).toEqual(SCRIPT_SRC_BY_PAGE);
    expect(unsafe).toEqual([]);
  });

  // Failure: the detectors above match nothing on a real page, so every page check passes whatever the page contains.
  it("detector control: flags an inline script, an inline handler and an unsafe script-src in a sample", () => {
    const sample = [
      '<meta http-equiv="Content-Security-Policy"',
      '        content="default-src \'self\'; script-src \'self\' \'unsafe-inline\';">',
      "<script>alert(1)</script>",
      '<button onclick="go()">x</button>',
      '<script src="a.js"></script>',
      '<script src="x.js">alert(2)</script>',
    ].join("\n");

    expect(inlineScriptFindings(sample)).toEqual(["<script>", '<script src="x.js">']);
    expect(inlineHandlerFindings(sample)).toEqual(['<button onclick="go()">']);
    expect(effectiveScriptSrc(cspOf(sample))).toEqual("'self' 'unsafe-inline'");
    expect(localRefs(sample)).toEqual(["a.js", "x.js"]);
  });
});
