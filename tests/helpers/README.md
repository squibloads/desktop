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
- `tests/renderer/` runs each `src/renderer/` page in jsdom, with the real HTML
  and script and a fake `window.electronAPI`. Each page gets its own jsdom
  window from `tests/helpers/load-page.js`; the project itself runs in Node. CSS is not loaded in
  this tier, so a test asserts class names such as `hidden` or `gone`,
  never what is visible.
- `tests/e2e/` is tier 4, the Electron smoke tier. Each test launches the real
  app with Playwright's Electron support, against a fake Podman and a fake
  Console. See "Tier 4" below. It is opt-in: its project exists only when
  `TURNSTONE_E2E=1`.
- `tests/fixtures/` holds static input a test reads, such as a sample file.
- `tests/golden/` holds expected output a test compares against.
- `tests/helpers/` holds fakes shared by more than one test file, plus the
  shuffle runner (`run-shuffled.mjs`) and the seeded sequencer.
  - `ordered-random-sequencer.mjs` exports `OrderedRandomSequencer`, the
    `sequence.sequencer` used when shuffling. It sorts specs by project and
    module id before the seeded shuffle, so a seed gives the same file order
    whatever order Vitest discovers the files in.
  - `load-page.js` exports `loadPage(name, { api, hub, prefersLight, query })`,
    `createFakeBridge()` and `closeAllPages()`. The fake bridge has exactly the
    keys `src/preload/preload.js` exposes; `tests/contract/renderer-bridge.test.js`
    checks that. Test-only emitters (health and stage events) sit on a separate
    `hub`, so the page never sees them. A loaded page's `setPrefersLight(bool)`
    changes the colour scheme and fires the page's `change` listeners.
  - `fake-clock.js` exports `installSteppedClock({ step })`. It replaces
    `Date.now` with a counter that advances by `step` ms on every read, so a
    timeout counts polls. `make()` in `tests/unit/local-runtime.test.js`
    installs it by default. `restoreMocks` in `vitest.config.mjs` restores it
    after each test.

- `fake-podman.js` is the podman binary the app shells out to. It implements
  exactly the five calls `local-runtime.js` makes, matched argv element by
  element; any other call exits 1. It keeps machine and pod state in a JSON
  file (`FAKE_PODMAN_STATE`), and logs every call to `FAKE_PODMAN_LOG`.
  `FAKE_PODMAN_STOP_DELAY_MS` makes `pod stop` take that long, then logs
  `pod stop done`, so a test can check that the stop finished before the app exited.
- `fake-console.js` exports `createFakeConsole()`, a loopback `/health` server
  with a settable status and node count. It counts health reads, so a test can
  wait for the app to poll without a fixed delay. A bind refused because the port
  is still in use is retried 20 times, 100 ms apart, before the start fails.
- `self-signed-cert.js` exports `selfSignedCert()`, a certificate for 127.0.0.1
  and its key, made at test time with `node:crypto` so none is stored in the
  repository. Nothing trusts it by default. `tests/e2e/main-requests.test.js`
  tells the session to accept it, to check that the main process trusts what
  the session trusts. It also exports `derInteger`, the integer encoder, which
  `tests/contract/self-signed-cert.test.js` checks byte by byte.
- `launch-app.js` exports `launchApp()`, which seeds a fresh user-data
  directory, launches the app, and returns a handle with `findPage`,
  `windowUrls`, `readPodmanLog`, `setPodmanState`, `clickMenuItem` and `close`.
  `closeEverything()` is the afterEach hook: it closes every app, then stops every
  console passed to `registerConsole()`, even when a close throws. A quit that does
  not finish within 25 s kills the app's whole process tree. A launch with no
  `consolePort` gets one closed loopback port per process, never 8090. `safe-path.js`
  builds the child's PATH without any directory that holds a podman executable.
  `urlIs` and `urlEndsWith` are window predicates for `findPage`.
- `poll.js` exports `pollUntil(check)`, a deadline-bounded wait on observable
  state, built on `vi.waitFor`.
- `e2e-setup.js` runs before the e2e files. It fails the run when the Electron
  binary is missing, so the smoke tier can never pass by skipping.
- `run-e2e.mjs` sets `TURNSTONE_E2E=1` and runs `vitest run --project e2e`.

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
npm run test:renderer
npm run test:shuffle      # random file and test order; prints the seed; no e2e unless TURNSTONE_E2E=1
npm run test:e2e          # tier 4, Electron smoke tests; opt-in, see below
```

`VITEST_MAX_WORKERS` sets the worker count (default: half the logical cores).
`VITEST_SEED` replays a shuffled order and requires `VITEST_SHUFFLE=1`; the
config throws if it is set without it.

## Tier 4: the Electron smoke tier

`tests/e2e/` drives the real app. Each test launches Electron with Playwright,
so it opens real windows: the shell, the console view and the local
loading and error pages. Run it on a machine with a display.

What it needs: the Electron binary from `npm ci` (without
`ELECTRON_SKIP_BINARY_DOWNLOAD`), and nothing else. Podman and the Turnstone
console are both faked, so no real container or server is touched.

```bash
npm run test:e2e                                   # all e2e files
node tests/helpers/run-e2e.mjs tests/e2e/quit.test.js   # one file
```

The project is absent unless `TURNSTONE_E2E=1`, so `npm test` never opens a
window. CI runs it in a separate `smoke` job under Xvfb. Each e2e file must pass
alone and in any order. Each test uses its own temp directory and its own port 0
console. One fixed port is the exception: a launch with no `consolePort` gets the
closed port `launchApp` reserves once per process. Another process can take that
port in the gap after it is released. A failure comment above each test names the
user-visible failure it guards against.
