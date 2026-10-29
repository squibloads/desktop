import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrderedRandomSequencer } from "../helpers/ordered-random-sequencer.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Specs as the sequencer receives them: a project and an absolute module id.
// `label` is only for the assertions; the sequencer never reads it.
function spec(project, relPath) {
  return { project: { name: project }, moduleId: join(root, relPath), label: `${project} ${relPath}` };
}

const SPECS = [];
for (let i = 0; i < 20; i += 1) {
  const n = String(i).padStart(2, "0");
  SPECS.push(spec("unit", `tests/unit/m${n}.test.js`));
  SPECS.push(spec("contract", `tests/contract/c${n}.test.js`));
}

// Runs the sequencer with a fake Vitest context and returns the labels in order.
async function orderOf(seed, specs) {
  const sequencer = new OrderedRandomSequencer({ config: { root, sequence: { seed } } });
  const sorted = await sequencer.sort(specs);
  return sorted.map((s) => s.label);
}

describe("OrderedRandomSequencer", () => {
  // Without the pre-sort, the file order follows async project discovery, so a
  // replayed VITEST_SEED runs the files in a different order on another run.
  it("gives the same order for one seed whatever order the specs arrive in", async () => {
    const reversed = [...SPECS].reverse();
    const interleaved = SPECS.filter((_, i) => i % 2 === 0).concat(SPECS.filter((_, i) => i % 2 === 1));

    const fromSorted = await orderOf(123, SPECS);
    const fromReversed = await orderOf(123, reversed);
    const fromInterleaved = await orderOf(123, interleaved);

    expect(fromReversed).toEqual(fromSorted);
    expect(fromInterleaved).toEqual(fromSorted);
  });

  // A sequencer that ignored the seed would pass the test above, so the seed
  // must visibly change the order.
  it("gives a different order for a different seed", async () => {
    const seed123 = await orderOf(123, SPECS);
    const seed124 = await orderOf(124, SPECS);

    expect(seed124).not.toEqual(seed123);
  });

  // Sorting must not drop or duplicate a file, or a tier's tests would silently
  // stop running under shuffle.
  it("returns exactly the specs it was given", async () => {
    const order = await orderOf(123, [...SPECS].reverse());
    const sortedOrder = [...order].sort();
    const expected = SPECS.map((s) => s.label).sort();

    expect(sortedOrder).toEqual(expected);
    expect(order).toHaveLength(40);
  });
});
