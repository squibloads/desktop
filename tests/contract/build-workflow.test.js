import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(join(root, ".github", "workflows", "build.yml"), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Each job's text, from its name line to the next job.
const buildJob = workflow.slice(workflow.indexOf("\n  build:\n"), workflow.indexOf("\n  release:\n"));
const releaseJob = workflow.slice(workflow.indexOf("\n  release:\n"));
const step = (name) => buildJob.indexOf(`- name: ${name}\n`);
// One build step's text, from its name to the next step, without the trailing blank line.
function stepText(name) {
  const start = step(name);
  if (start < 0) return "";
  const next = buildJob.indexOf("\n      - ", start + 1);
  return buildJob.slice(start, next < 0 ? undefined : next).trimEnd();
}

// The check step exactly: any other text could skip it on an OS, let it fail without failing the job, or run it in
// a shell that cannot read it (pwsh, Windows' default, cannot parse the test).
const CHECK_STEP = `- name: Check the packaged build
        timeout-minutes: 10
        shell: bash
        env:
          PLATFORM: \${{ matrix.platform }}
        run: |
          if [ "$PLATFORM" = linux ]; then
            xvfb-run -a npm run test:packaged
          else
            npm run test:packaged
          fi`;

describe("build workflow", () => {
  // Failure: a release ships a build whose fuses were never flipped, or which keeps the launch switches, because
  // nothing checks the packaged binary on the OS that built it before its files are uploaded.
  it("checks the packaged build on every OS, after make and before the upload", () => {
    const make = step("Build distributables");
    const check = step("Check the packaged build");
    const upload = step("Upload artifacts");

    expect(make).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(make);
    expect(upload).toBeGreaterThan(check);
    expect(stepText("Check the packaged build")).toBe(CHECK_STEP);
  });

  // Failure: the upload runs after a failed check, or a failed check is allowed to pass the job.
  it("uploads only after a passing check", () => {
    expect(stepText("Upload artifacts")).not.toMatch(/\n\s+(?:if|continue-on-error):/);
    expect(buildJob).not.toContain("continue-on-error");
  });

  // Failure: the Linux check runs without the libraries Electron needs, or installs them on every OS.
  it("installs the Linux libraries before the check, on Linux only", () => {
    const libs = step("Install Xvfb and Electron libraries");
    expect(libs).toBeGreaterThan(-1);
    expect(libs).toBeLessThan(step("Check the packaged build"));
    expect(stepText("Install Xvfb and Electron libraries")).toContain("\n        if: matrix.platform == 'linux'\n");
  });

  // Failure: the script name in the workflow and package.json drift apart, so the step fails on every release.
  it("runs the checker through the package.json script", () => {
    expect(pkg.scripts["test:packaged"]).toBe("node tests/helpers/check-packaged-build.mjs");
  });

  // Failure: the check can only run on a tag, so it is first seen working, or failing, during a release.
  it("can be started by hand", () => {
    expect(workflow).toMatch(/\non:\n(?: {2}.*\n)*? {2}workflow_dispatch:/);
  });

  // Failure: a run started by hand on a tag publishes or replaces that tag's release with rebuilt files, or cancels a
  // release in progress for the same tag.
  it("publishes only for a pushed tag, and keeps hand-started runs apart", () => {
    expect(releaseJob).toContain("\n    needs: build\n");
    expect(releaseJob).toContain("\n    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n");
    expect(workflow).toContain("\n  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}\n");
  });

  // Failure: a run started by hand on any branch hands the Apple credentials to that branch's build scripts.
  it("passes the Apple credentials to a pushed tag's build only", () => {
    const make = stepText("Build distributables");
    for (const name of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
      expect(make).toContain(`\n          ${name}: \${{ github.event_name == 'push' && secrets.${name} || '' }}`);
    }
    expect(workflow.match(/secrets\./g)).toHaveLength(3);
  });
});
