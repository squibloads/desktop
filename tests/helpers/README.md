# Test helpers

Shared fakes and rules for the suites under `tests/`. This directory is not a
test tier, so Vitest does not collect files from it, and the layout test fails
if a test file is placed here.

The layout test allows three support directories under `tests/`: `helpers/`,
`fixtures/` and `golden/`. Any other directory under `tests/` that is not a
tier fails it.

## Layout

- `tests/unit/` tests one module under `src/` with its dependencies faked.
- `tests/contract/` checks static files and cross-cutting rules, such as the
  renderer page's CSP or the test layout itself.
- `tests/fixtures/` holds static input a test reads, such as a sample file.
- `tests/golden/` holds expected output a test compares against.
- `tests/helpers/` holds fakes shared by more than one test file, plus the
  shuffle runner (`run-shuffled.mjs`) and the seeded sequencer.
  - `ordered-random-sequencer.mjs` exports `OrderedRandomSequencer`, the
    `sequence.sequencer` used when shuffling. It sorts specs by project and
    module id before the seeded shuffle, so a seed gives the same file order
    whatever order Vitest discovers the files in.
  - `fake-clock.js` exports `installSteppedClock({ step })`. It replaces
    `Date.now` with a counter that advances by `step` ms on every read, so a
    timeout counts polls. `make()` in `tests/unit/local-runtime.test.js`
    installs it by default. `restoreMocks` in `vitest.config.mjs` restores it
    after each test.

## Rules

These rules apply to new tests. Existing tests are being brought into line as
they are touched, so an older test may still break one. Fix it when you change
that file.

- **Hermetic.** No real network, Podman, or Turnstone. Use `example.com`-shaped
  hosts or loopback addresses.
- **No fixed ports.** Bind port 0 and read back the assigned port.
- **Fresh temp dir per test.** Create it with `fs.mkdtemp` under the OS temp
  directory and remove it in `afterEach`.
- **No shared mutable state between files.** Each file must pass when run
  alone and in any order. `npm run test:shuffle` checks this.
- **No wall-clock timing and no fixed sleeps.** Code under test that computes a
  deadline from `Date.now()` runs under `installSteppedClock()`, so the test
  asserts a poll count, not an elapsed time. A test waits for an observable
  state with `vi.waitFor(...)`, never a `setTimeout` barrier. A real timer is
  allowed only where a test must let the event loop turn, such as a cancel
  issued during a poll loop. That test asserts behaviour, never elapsed time.
  A `setImmediate` drain is allowed only after a gate has been awaited, such as
  a `vi.waitFor` on an observable call or a promise the test controls. Put a
  comment next to the drain that names the gate.
- **Plain asserts on precomputed values.** Put the expected value in the test
  as a literal. No loops or computation inside `expect`, because a bug in the
  computation then passes silently.
- **State the failure each test prevents.** One short comment above the test
  names the user-visible failure it guards against.
- **Serial only with a reason.** Use `describe.sequential` only when tests in
  the block share a resource that cannot be isolated. Put the reason in a
  comment above it.

## Running

```bash
npm test                  # all tiers, in parallel
npm run test:unit
npm run test:contract
npm run test:shuffle      # random file and test order; prints the seed
```

`VITEST_MAX_WORKERS` sets the worker count (default: half the logical cores).
`VITEST_SEED` replays a shuffled order and requires `VITEST_SHUFFLE=1`; the
config throws if it is set without it.
