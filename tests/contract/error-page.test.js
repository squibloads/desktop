import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "src", "renderer");
const html = readFileSync(join(dir, "error.html"), "utf8");

describe("error.html", () => {
  // The page's CSP (default-src 'self') blocks inline scripts, which left
  // Settings and Retry dead. Its script must be an external file.
  it("has no inline script under its CSP", () => {
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
    expect(html).toMatch(/<script src="error\.js"><\/script>/);
    expect(existsSync(join(dir, "error.js"))).toBe(true);
  });
});
