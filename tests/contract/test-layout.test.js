import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tierGlobs } from "../../vitest.config.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The names Vitest treats as tests: *.test or *.spec with a JS or TS extension.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Dependency, build and VCS trees are not source, so nothing in them is a stray test.
const IGNORED = new Set(["node_modules", "out", "dist", ".git", ".webpack", ".vite"]);

// Collects paths relative to the repo root, with "/" separators. Symlinks are
// reported, never followed, so a link cycle cannot make the walk recurse.
function walk(dir, out = { files: [], dirs: [], links: [] }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      out.links.push(rel);
    } else if (entry.isDirectory()) {
      out.dirs.push(rel);
      walk(full, out);
    } else {
      out.files.push(rel);
    }
  }
  return out;
}

// Only the forms tierGlobs uses: literal text, `*` within a segment, and `**/`
// for any depth. Other syntax throws, so an unsupported glob cannot quietly
// match nothing.
function globToRegExp(glob) {
  if (/[?{}[\]!]/.test(glob)) throw new Error(`unsupported glob syntax: ${glob}`);
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else {
      re += glob[i].replace(/[.+^$()|\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

// Support directories under tests/, not test tiers. helpers/ holds shared fakes,
// the shuffle runner and the ordered sequencer; fixtures/ and golden/ hold static input and expected
// output. Each is described in tests/helpers/README.md. A test-looking file in
// any of them still fails the glob-collection check, so none can hide a test.
const NON_TIER_DIRS = new Set(["helpers", "fixtures", "golden"]);

function tierDirs() {
  return readdirSync(join(root, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NON_TIER_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// The glob's first segment is the directory: "tests/unit/**/*.test.js" -> "tests/unit".
function globDir(glob) {
  return glob.split("/").slice(0, 2).join("/");
}

describe("test layout", () => {
  // A link is never followed, so a cycle cannot hang the walk. A link can also
  // hide a test from the tier globs, so any link anywhere in the repo fails the run.
  it("has no symlinks anywhere in the repository", () => {
    expect(walk(root).links).toEqual([]);
  });

  // A test beside its module under src/ is not run by the tiered config and
  // would be silently skipped by a future CI change, so it must stay in tests/.
  it("keeps every test file out of src/, including __tests__ directories", () => {
    const tree = walk(join(root, "src"));
    expect(tree.files.filter((f) => TEST_FILE.test(f))).toEqual([]);
    expect(tree.dirs.filter((d) => d.split("/").includes("__tests__"))).toEqual([]);
  });

  // Only the tier globs are collected. A test in the tests/ root or in helpers/
  // is never run, and CI would still pass.
  it("keeps test files out of the tests/ root and tests/helpers/", () => {
    const { files } = walk(join(root, "tests"));
    const stray = files.filter(
      (f) => TEST_FILE.test(f) && (f.split("/").length === 2 || f.startsWith("tests/helpers/")),
    );
    expect(stray).toEqual([]);
  });

  // Vitest collects only files that match a tier glob, so a test-looking file
  // outside every glob never runs and CI stays green. The walk covers the whole
  // repo, not just tests/, so docs/example.test.js or a root probe.test.js is caught.
  it("collects every test-looking file in the repository with a tier glob", () => {
    const regexes = Object.values(tierGlobs).map(globToRegExp);
    const { files } = walk(root);
    const uncollected = files.filter(
      (f) => TEST_FILE.test(f) && !regexes.some((re) => re.test(f)),
    );
    expect(uncollected).toEqual([]);
  });

  // Vitest only looks under the tier globs, so a test-looking file at the repo
  // root or under scripts/ is never run. src/ and tests/ have their own checks.
  it("has no test-looking files at the repo root or under scripts/", () => {
    const rootFiles = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && TEST_FILE.test(entry.name))
      .map((entry) => entry.name);
    const scripts = join(root, "scripts");
    const scriptFiles = existsSync(scripts)
      ? walk(scripts).files.filter((f) => TEST_FILE.test(f))
      : [];
    expect([...rootFiles, ...scriptFiles]).toEqual([]);
  });

  // A tests/<tier> directory that no project glob matches is never run,
  // and CI would still pass.
  it("covers every tests/<tier> directory with a project glob", () => {
    const covered = Object.values(tierGlobs).map(globDir);
    const uncovered = tierDirs().filter((dir) => !covered.includes(`tests/${dir}`));
    expect(uncovered).toEqual([]);
  });

  // A glob whose directory was renamed or removed matches no files. The tier
  // then drops out of the run while the other tier's tests keep it green.
  it("points every project glob at a directory that exists", () => {
    const missing = Object.values(tierGlobs)
      .map(globDir)
      .filter((dir) => !existsSync(join(root, dir)));
    expect(missing).toEqual([]);
  });

  // A glob that matches no file gives an empty project. Vitest does not fail
  // for that when other projects have tests, so the layout test must.
  it("gives every project glob at least one test file to run", () => {
    const files = walk(join(root, "tests")).files;
    const empty = Object.entries(tierGlobs)
      .filter(([, glob]) => {
        const re = globToRegExp(glob);
        return !files.some((f) => re.test(f));
      })
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });
});
