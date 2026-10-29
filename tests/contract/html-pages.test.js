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

// Removes HTML comments, so a commented-out handler or script is not read as live markup.
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

// Reads the start tags of live markup (comments already removed). A quoted value may hold
// `>`, `/` or `=` and is read as a value, never as an attribute. Attributes may be separated
// by whitespace, by `/`, or by nothing at all after a closing quote. The body of script and
// style is raw text, so markup-looking text inside it is not read as tags.
function startTags(live) {
  const tags = [];
  const tagStart = /<([a-zA-Z][a-zA-Z0-9-]*)/y;
  const attrName = /[^\s/>="']+/y;
  const unquoted = /[^\s>]*/y;
  let i = 0;
  while (i < live.length) {
    const lt = live.indexOf("<", i);
    if (lt === -1) break;
    tagStart.lastIndex = lt;
    const open = tagStart.exec(live);
    if (!open) {
      i = lt + 1;
      continue;
    }
    const name = open[1].toLowerCase();
    const attrs = [];
    let j = tagStart.lastIndex;
    while (j < live.length) {
      if (/[\s/]/.test(live[j])) {
        j++;
        continue;
      }
      if (live[j] === ">") {
        j++;
        break;
      }
      attrName.lastIndex = j;
      const n = attrName.exec(live);
      if (!n) {
        j++;
        continue;
      }
      j = attrName.lastIndex;
      let value = "";
      let k = j;
      while (k < live.length && /\s/.test(live[k])) k++;
      if (live[k] === "=") {
        k++;
        while (k < live.length && /\s/.test(live[k])) k++;
        const q = live[k];
        if (q === '"' || q === "'") {
          const end = live.indexOf(q, k + 1);
          value = live.slice(k + 1, end === -1 ? live.length : end);
          j = end === -1 ? live.length : end + 1;
        } else {
          unquoted.lastIndex = k;
          value = unquoted.exec(live)[0];
          j = unquoted.lastIndex;
        }
      }
      attrs.push({ name: n[0].toLowerCase(), value });
    }
    tags.push({ name, attrs, text: live.slice(lt, j), end: j });
    i = j;
    if (name === "script" || name === "style") {
      const close = live.toLowerCase().indexOf(`</${name}`, j);
      i = close === -1 ? live.length : close;
    }
  }
  return tags;
}

// Returns the text from `from` up to the closing </name>, or to the end of the markup when it is missing.
function bodyAfter(live, from, name) {
  const close = live.toLowerCase().indexOf(`</${name}`, from);
  return close === -1 ? live.slice(from) : live.slice(from, close);
}

// Browsers drop ASCII control characters and spaces before reading a URL's scheme, so this does too.
// It can flag more than a browser would, never less.
function urlNoise(value) {
  return value.replace(/[\u0000- ]/g, "");
}

// Returns the text of each script that has no src, and each script that has a src and a body.
// Only an attribute named exactly src counts: data-src does not make a script external.
function inlineScriptFindings(html) {
  const live = stripComments(html);
  return startTags(live)
    .filter((tag) => tag.name === "script")
    .filter((tag) => !tag.attrs.some((a) => a.name === "src") || bodyAfter(live, tag.end, "script").trim() !== "")
    .map((tag) => tag.text);
}

// Returns the text of each start tag with an attribute whose name starts with "on", such as onclick.
function inlineHandlerFindings(html) {
  return startTags(stripComments(html))
    .filter((tag) => tag.attrs.some((a) => a.name.startsWith("on")))
    .map((tag) => tag.text);
}

// Returns the text of each script whose src has a scheme or starts with //, so it loads from another host.
function remoteScriptFindings(html) {
  return startTags(stripComments(html))
    .filter((tag) => tag.name === "script")
    .filter((tag) => tag.attrs.some((a) => a.name === "src" && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(urlNoise(a.value))))
    .map((tag) => tag.text);
}

// Returns the text of each start tag whose href or src uses the javascript: scheme.
function javascriptUrlFindings(html) {
  return startTags(stripComments(html))
    .filter((tag) => tag.attrs.some((a) => (a.name === "href" || a.name === "src") && /^javascript:/i.test(urlNoise(a.value))))
    .map((tag) => tag.text);
}

// Returns the src or href of each script or link that points at a local file, in document order.
// External URLs, javascript: URLs and fragments are skipped; the checks above cover them.
function localRefs(html) {
  const refs = [];
  for (const tag of startTags(stripComments(html))) {
    if (tag.name !== "script" && tag.name !== "link") continue;
    const attr = tag.attrs.find((a) => a.name === "src" || a.name === "href");
    if (!attr) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(urlNoise(attr.value))) continue;
    refs.push(attr.value);
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

  // Failure: a script loads from another host, so the page runs code the CSP and this suite never see as local.
  it("every script src in any page is local", () => {
    const remote = {};
    for (const page of PAGES) {
      const findings = remoteScriptFindings(read(page));
      if (findings.length > 0) remote[page] = findings;
    }

    expect(remote).toEqual({});
  });

  // Failure: an href or src uses javascript:, which runs script without any inline-script or handler attribute to flag.
  it("no href or src in any page starts with javascript:", () => {
    const found = {};
    for (const page of PAGES) {
      const findings = javascriptUrlFindings(read(page));
      if (findings.length > 0) found[page] = findings;
    }

    expect(found).toEqual({});
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

  // Failure: a page file gains 'unsafe-inline' in its script-src, re-enabling inline script, and this check passes because it reads a copy of the CSP in this file.
  it("resolves script-src to 'self' on every page, with no 'unsafe-inline', from the page file", () => {
    const scriptSrc = {};
    for (const page of PAGES) {
      const csp = cspOf(read(page));
      scriptSrc[page] = csp === null ? null : effectiveScriptSrc(csp);
    }
    const unsafe = PAGES.filter((page) => (scriptSrc[page] ?? "").includes("'unsafe-inline'"));

    expect(scriptSrc).toEqual(SCRIPT_SRC_BY_PAGE);
    expect(unsafe).toEqual([]);
  });

  // Failure: the script-src check does not read the page text it is given, so the test above passes whatever the file says.
  it("detector control: the script-src derivation reads the page text it is given", () => {
    const page = read("error.html");
    const loosened = page.replace("default-src 'self';", "default-src 'self'; script-src 'self' 'unsafe-inline';");

    expect(loosened).not.toBe(page);
    expect(effectiveScriptSrc(cspOf(page))).toEqual("'self'");
    expect(effectiveScriptSrc(cspOf(loosened))).toEqual("'self' 'unsafe-inline'");
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

  // Failure: the old tag regex stopped at the first > inside a quoted value, so onclick after title="a>b" was never seen.
  it("detector control: a handler after a quoted > is flagged", () => {
    const sample = '<button title="a>b" onclick="go()">x</button>';

    expect(inlineHandlerFindings(sample)).toEqual(['<button title="a>b" onclick="go()">']);
  });

  // Failure: a handler written straight after a closing quote, after a slash, or in upper case is missed, so the control is not seen.
  it("detector control: a handler after a closing quote, after a slash, or in upper case is flagged", () => {
    const sample = '<button class="a"onclick="x()">y</button>\n<img src="a.png"/OnError="z()">';

    expect(inlineHandlerFindings(sample)).toEqual(['<button class="a"onclick="x()">', '<img src="a.png"/OnError="z()">']);
  });

  // Failure: attribute values and comments are read as live markup, so a quoted "onclick=1" or a commented-out handler or script fails the page.
  it("detector control: attribute values and HTML comments are not read as live markup", () => {
    const sample = [
      "<p title=\"x one=1\" data-x='a onclick=2'>a</p>",
      '<!-- <button onclick="x()"> -->',
      "<!-- <script>alert(1)</script> -->",
    ].join("\n");

    expect(inlineHandlerFindings(sample)).toEqual([]);
    expect(inlineScriptFindings(sample)).toEqual([]);
  });

  // Failure: a single-quoted or unquoted src or href is not seen, so the file it names is never resolved.
  it("detector control: single-quoted and unquoted local references are read", () => {
    const sample = "<link rel=stylesheet href=tokens.css>\n<script src='gone.js'></script>\n<script src=\"a.js\"></script>";

    expect(localRefs(sample)).toEqual(["tokens.css", "gone.js", "a.js"]);
  });

  // Failure: data-src is read as src, so a script with no real src passes the inline-script check.
  it("detector control: data-src does not make a script external", () => {
    const sample = '<script data-src="x.js"></script>\n<script src="a.js"></script>';

    expect(inlineScriptFindings(sample)).toEqual(['<script data-src="x.js">']);
  });

  // Failure: a script loads from another host, or an href or src uses javascript:, and neither is a local file, so the local checks never see it.
  it("detector control: remote script sources and javascript: URLs are flagged", () => {
    const sample = [
      '<script src="https://cdn.example.com/x.js"></script>',
      '<script src="//cdn.example.com/y.js"></script>',
      '<script src="a.js"></script>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href=" JavaScript:alert(2)">y</a>',
      '<a href="jav\tascript:alert(3)">z</a>',
      '<a href="index.html">ok</a>',
    ].join("\n");

    expect(remoteScriptFindings(sample)).toEqual(['<script src="https://cdn.example.com/x.js">', '<script src="//cdn.example.com/y.js">']);
    expect(javascriptUrlFindings(sample)).toEqual(['<a href="javascript:alert(1)">', '<a href=" JavaScript:alert(2)">', '<a href="jav\tascript:alert(3)">']);
  });
});
