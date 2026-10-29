// A seeded random sequencer whose input order does not matter.
//
// Vitest's own RandomSequencer shuffles the spec list in the order it receives
// it. That order follows async project discovery, so the same VITEST_SEED can
// give a different file order from one run to the next. This sequencer sorts
// the specs by project name and workspace-relative module id first, then applies
// the seeded shuffle, so the order depends only on the seed and the file set.
//
// RandomSequencer is not exported from vitest 4.0.18, so the seeded permutation
// below mirrors its algorithm. Only the pre-sort is new; BaseSequencer's
// cache and duration ordering is deliberately not used, since it changes with
// every run's history.

import { relative, sep } from "node:path";
import { BaseSequencer } from "vitest/node";

// Same generator as vitest's internal shuffle. Math.sin is deterministic for a
// given engine, so the permutation is stable across runs on the same Node version.
function seededRandom(seed) {
  const x = Math.sin(seed) * 1e4;
  return x - Math.floor(x);
}

// Fisher-Yates driven by consecutive seeds. Mutates and returns `array`.
function shuffleWithSeed(array, seed) {
  let length = array.length;
  let s = seed;
  while (length) {
    const index = Math.floor(seededRandom(s) * length--);
    const previous = array[length];
    array[length] = array[index];
    array[index] = previous;
    ++s;
  }
  return array;
}

// Forward slashes on every platform, so a Windows and a Linux run agree on the key.
function workspaceId(root, moduleId) {
  return relative(root, moduleId).split(sep).join("/");
}

// Plain code-unit comparison. localeCompare depends on the host locale and ICU data.
function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class OrderedRandomSequencer extends BaseSequencer {
  async sort(specs) {
    const { root, sequence } = this.ctx.config;
    const keyed = specs.map((spec) => ({
      spec,
      project: spec.project.name,
      id: workspaceId(root, spec.moduleId),
    }));
    keyed.sort((a, b) => compareText(a.project, b.project) || compareText(a.id, b.id));
    return shuffleWithSeed(
      keyed.map((entry) => entry.spec),
      sequence.seed,
    );
  }
}
