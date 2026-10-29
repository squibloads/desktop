// Waits for an observable condition, within a deadline. The e2e tier waits on window
// URLs, DOM classes, podman log lines and console health reads, never on a fixed delay.

import { vi } from "vitest";

// A falsy result (or a throw) retries until the deadline; the last failure is the error reported.
export function pollUntil(check, { description = "condition", timeoutMs = 30_000, intervalMs = 200 } = {}) {
  return vi.waitFor(
    async () => {
      const value = await check();
      if (!value) throw new Error(`timed out waiting for ${description}`);
      return value;
    },
    { timeout: timeoutMs, interval: intervalMs },
  );
}

// Waits until a page's script has written the text. A window's URL appears before its script
// runs, so a read straight after findPage can see an empty element.
export function waitForText(page, selector, expected) {
  return pollUntil(async () => (await page.textContent(selector)) === expected, {
    description: `${selector} to read "${expected}"`,
  });
}

// Same race as waitForText, for the document title of a console page.
export function waitForTitle(page, expected) {
  return pollUntil(async () => (await page.title()) === expected, {
    description: `page title "${expected}"`,
  });
}
