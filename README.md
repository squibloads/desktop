# Turnstone Desktop

Turnstone Desktop is a desktop client for a [Turnstone](https://github.com/turnstonelabs/turnstone) server, its Console, or both. It shows those web interfaces in one window, with a title bar that reports whether each service is reachable.

The app does not include the Turnstone backend. The one exception is **Local mode**, which starts a Podman pod that you have set up on this PC.

## Quick start

1. Start Turnstone Desktop. The first time it runs, the Settings dialog opens by itself.
2. Pick a **Mode** (see [Modes](#modes)).
3. Enter the **Server URL** and/or **Console URL** that the mode needs. In Local mode, choose what happens on quit.
4. Click **Save**. The window opens with your views.

You can reopen Settings at any time with `Ctrl+,` (`Cmd+,` on macOS) or from the tray menu. On macOS, you can also use the app menu.

## Modes

| Mode | What the window shows | Health dots | Notifications | Typical use |
|---|---|---|---|---|
| **Server Only** | Server view, no tabs | SRV | Yes | A single-node deployment |
| **Console Only** | Console view, no tabs | CON | No | Monitoring a cluster from its Console |
| **Both** | Server and Console as tabs | SRV and CON | Yes | You need both at once |
| **Local** | Console at `http://127.0.0.1:8090`, from a Podman pod on this PC. A loading screen shows while it starts. | CON; the SRV dot is shown but stays grey | No | Running Turnstone on this PC |

## Settings reference

Open Settings with `Ctrl+,` (`Cmd+,` on macOS). The dialog has these fields:

| Field | Default | Shown in | What it does | Rules |
|---|---|---|---|---|
| **Mode** | Both | Always | Chooses which views load, which health dots show, and whether notifications run. | One of Server Only, Console Only, Both, Local. |
| **Server URL** | `http://localhost:8080` | Server Only, Both | Address of the Turnstone server. Loads the Server view, is health-checked, and is the source for notifications. | Required in these modes. Must start with `https://`, or with `http://` for this computer only (`localhost`, `127.0.0.1` or `[::1]`). Trailing slashes are removed. A redirect to another site is not followed. |
| **Console URL** | `http://localhost:8090` | Console Only, Both | Address of the Console. Loads the Console view and is health-checked. | Required in these modes. Same rules as Server URL. |
| **When the app quits** | Stop Turnstone | Local only | Whether the Local pod is stopped when the app quits. See [Local mode](#local-mode). | Stop Turnstone or Keep Turnstone running. |

**What saving does**

- **A mode change** closes and rebuilds the window. The menu, views, health checks and notifications are set up again for the new mode.
- **A URL change** reloads only the affected view. Health checks run right away. If the Server URL changed, notifications restart.
- **Changing only *When the app quits*** takes effect immediately, with no reload.
- **Switching into Local** starts the pod startup sequence. See [Local mode](#local-mode).
- **Hidden fields are not validated or changed.** For example, in Local mode your saved remote Console URL is kept.
- **If validation fails**, the dialog stays open with an error message and nothing is saved.
- **Cancel** or `Esc` closes the dialog without saving. `Enter` in a text field saves.

**Where settings are stored.** Settings are saved in `turnstone-desktop.json` in the app's user-data folder. The app also saves the window size and position, the last active tab, and whether it has launched before. These are not shown in the dialog.

## Local mode

Local mode runs Turnstone in a Podman pod on this PC and opens its Console at `http://127.0.0.1:8090`. The Console URL field is hidden in this mode, and the app always uses that address.

**Before you use it.** The app does not create anything. These must already exist:

- Podman is installed, and `podman` runs from the PATH the app sees.
- A Podman machine named `turnstone`.
- A Podman connection named `turnstone`, with a pod named `turnstone` on it. The pod commands use this connection.
- A Console that answers `/health` at `http://127.0.0.1:8090`.

**What happens on launch.** The loading screen, titled **Starting Local Turnstone**, shows these stages in order:

1. **Starting the Podman machine.** If the `turnstone` machine is not running, the app starts it.
2. **Starting Turnstone.** If the pod is not running, the app starts it. A pod that is already running is left alone.
3. **Waiting for the console.** The app checks `/health` once a second for up to 2 minutes, until it reports `ok`.
4. **Waiting for the node to come online (this can take about a minute).** The app checks once a second until a node is registered, for up to 3 minutes. If none has registered after 3 minutes, the Console opens anyway, provided the Console is still healthy. If the Console stopped answering, or answers with anything other than a healthy status, during the wait, you get the `HEALTH_TIMEOUT` error page instead.

The app starts the Podman machine when it is stopped and starts or stops the existing pod. It never stops the machine.

**What happens on quit.** The Settings field *When the app quits* controls this:

- **Stop Turnstone** (the default): the app runs `podman --connection turnstone pod stop turnstone` before it exits. This happens if the app is starting or has inspected the pod this session. If startup failed before the pod was found (for example `POD_MISSING`), nothing is stopped. Quitting while startup is still running cancels the wait. Quit can wait up to 2 minutes while the pod stops. If startup was already running a Podman step when you quit, that step finishes first, so quitting can take longer. A failed stop is ignored.
- **Keep Turnstone running**: the pod is left running. The next launch does not start the machine or the pod if they are already running.

The app never stops the Podman machine. If you switch away from Local mode during a session, Stop Turnstone still stops the pod on quit.

## Everyday use

### Tabs and views

- **Both mode:** click the Server or Console tab, or focus a tab and use the arrow keys, `Home` and `End`. The last active tab is restored at the next launch.
- **Both mode:** `Ctrl+1` switches to Server and `Ctrl+2` to Console (`Cmd` on macOS).
- The other modes show one view and have no tabs.

### Title bar

- **BETA** badge.
- **Server / Console tabs**, shown in Both mode only.
- **SRV and CON health dots**. A screen reader announces the state. The dot's colour and shape show it.
- **Window buttons** (minimize, maximize, close) on Windows and Linux. macOS uses the system window buttons.

| Dot | Meaning |
|---|---|
| Green, glowing | **Connected**: `/health` returned a successful response with `"status": "ok"` |
| Yellow diamond | **Degraded**: `/health` returned a successful response with another status |
| Solid red square | **Error**: `/health` returned an error response |
| Dim red | **Disconnected**: no answer within 3 seconds, or the answer was not JSON |
| Dim grey | **Unknown**: not checked yet |
| Solid red square | **Address refused**: the saved address is plain `http://` to another computer, so it is never checked or loaded. Open Settings and change it to `https://`. |

The app checks each service every 5 seconds. When a service changes from not OK to OK, its view recovers on its own: a working page is reloaded, and a view showing an error page loads its address again.

### System tray

- **Icon colour:** green when every active service is Connected, yellow when some are, red when none are. Grey until the first check.
- **Click the icon** to show the window. On Linux, which gesture activates the icon depends on the desktop environment; if clicking does nothing, use the tray menu.
- **Menu:** a read-only status line for each active service (for example `Server: Connected`). Local and Console Only show only Console, and Server Only shows only Server. In Server Only and Both, a line then says whether notifications work, from the end of the first poll on (see [Notifications](#notifications)). Then **Show Window**, **Settings...**, and **Quit**. **Quit** exits the app and applies the *When the app quits* setting.
- On **Windows and Linux**, closing the window quits the app. On **macOS**, the app keeps running after the window closes. On macOS, use the Dock icon, not the tray, to reopen a closed window.

### Notifications

Notifications run in **Server Only** and **Both** modes only. Every 10 seconds the app asks the server for the workstreams of the user signed in to the Server view, counting from the end of the last request, and notifies when one of that user's workstreams comes into a state that needs them.

- **Turnstone: Attention Needed**, with the text `<name> requires your input`, when one of your workstreams starts waiting for you.
- **Turnstone: Error**, with the text `<name> encountered an error`, when one of them fails.
- The name is the workstream's name, otherwise its ID, otherwise `Workstream`.
- Only your own workstreams notify, even on a server where you can see other users' workstreams.
- A workstream that already needed you when notifications started does not notify. They start again, and only record where things stand, when the app starts, when the mode or the Server URL changes, when you or another user signs in, and after the server refused the requests or answered in a form the app cannot read.

These requests carry the cookies the Server view holds for the server, its sign-in among them, so notifications need no setting of their own. A cookie does not depend on the port, so a Console on the same host adds its cookies too, as it does for the Server view. They are the only requests the app itself sends with cookies: health checks carry none. They go only to the Server URL, and a redirect is not followed. An answer is dropped when those cookies changed while it was on its way, as when you sign out or another user signs in, so one user's workstreams never notify after another has signed in.

From the end of the first poll on, at most 10 seconds after notifications start, the tray menu says whether notifications work, and the app logs each change. A Server URL the app refuses runs no notifications and shows no line.

| Tray line | Meaning |
|---|---|
| `Notifications: On` | The server answered, and the app is watching your workstreams. |
| `Notifications: Sign in to the server` | The server asked for a sign-in. Sign in through the Server view. |
| `Notifications: Refused by the server` | The server refused the requests, or answered with a redirect. |
| `Notifications: Not supported by this server` | The server answered in a form the app cannot read, such as an older server's list of workstreams. |
| `Notifications: Waiting for the server` | The server did not answer, is down or busy, or asked the app to slow down. The log says why the first time each cause appears. |

The app does not check whether the window has focus before it shows a notification. A workstream that needs you and is answered within 10 seconds may not notify. The server's global event stream is not used: it needs a service token, which the server gives no signed-in user.

### Reload and developer tools

- `Ctrl+R` (`Cmd+R` on macOS) reloads the active view. If the view is showing an error page, it loads the view's address again instead.
- `Ctrl+Shift+I` (`Cmd+Shift+I` on macOS) opens or closes developer tools for the active view.

### Keyboard shortcuts

| Action | Windows / Linux | macOS |
|---|---|---|
| Settings | `Ctrl+,` | `Cmd+,` |
| Reload active view | `Ctrl+R` | `Cmd+R` |
| Developer tools | `Ctrl+Shift+I` | `Cmd+Shift+I` |
| Server tab (Both mode only) | `Ctrl+1` | `Cmd+1` |
| Console tab (Both mode only) | `Ctrl+2` | `Cmd+2` |

On macOS the View menu also has zoom and full-screen items; the app does not set shortcuts for them.

### Links

- A link that opens a new window opens in your default browser.
- A link inside a view that goes to a different address (different scheme, host or port) is blocked.

## Troubleshooting

### "Unable to connect" page

A view shows this page when it cannot load its address. The page names the address that failed (the one currently in Settings) and says "The server is not reachable. Check that Turnstone is running."

- **It reconnects on its own.** When the health check sees the service come back, the view loads its address again.
- **Retry** tries the address now. **Settings** opens the Settings dialog.
- **Reload** (`Ctrl+R`) also tries the address again.

To fix a wrong address, open Settings with `Ctrl+,` or from the tray menu. On macOS, you can also use the app menu. Saving the same address does not reload the view. Change the address or the mode.

### Local mode errors

If startup fails, the loading screen is replaced by an error page. It shows the error code as its title, a message, and a detail line with the raw error. The **Retry** button runs the startup again. The **Settings** button opens Settings.

| Code | Message on screen | What to check |
|---|---|---|
| `PODMAN_NOT_FOUND` | Podman is not installed. Install Podman, then reopen Turnstone. | Install Podman. Check that `podman` runs from a terminal on this PC. |
| `MACHINE_MISSING` | The Turnstone Podman machine does not exist. Create it, then reopen Turnstone. | Create a machine named `turnstone` in Podman. `podman machine list` should show it. |
| `MACHINE_LIST_FAILED` | Podman answered, but its machine list could not be read. | Run `podman machine list --format json` by hand and read its error. |
| `MACHINE_START_FAILED` | The Turnstone Podman machine would not start. | Run `podman machine start turnstone` by hand and read its error. |
| `POD_MISSING` | The Turnstone pod does not exist on the Podman machine. | The app's check is `podman --connection turnstone pod inspect turnstone`. It also fails if the `turnstone` connection is missing or unreachable. |
| `POD_START_FAILED` | The Turnstone pod would not start. | Run `podman --connection turnstone pod start turnstone` by hand and read its error. |
| `HEALTH_TIMEOUT` | Turnstone started but did not become healthy before the timeout. | Open `http://127.0.0.1:8090/health` in a browser. The detail line shows the last status the app saw. |
| `NODE_TIMEOUT` | Not shown. The Console opens anyway. The message is written to the log only. | If the Console shows no nodes, check the Turnstone pod's logs. |
| `START_CANCELLED` | Not shown and not logged. | Happens when you quit during startup. No action needed. |
| `POD_STOP_FAILED` | Not shown. Written to the log only. | Happens when the pod does not stop on quit. The app quits anyway. Stop the pod by hand if it is still running. |
| `UNEXPECTED` | Local startup failed unexpectedly. | Report the detail line shown under the message. |

## Development

```bash
npm install
npm start
```

### Running the tests

```bash
npm test                # all tiers, in parallel
npm run test:unit       # tests/unit only
npm run test:contract   # tests/contract only
npm run test:renderer   # tests/renderer only (jsdom)
npm run test:shuffle    # files and tests in random order; prints the seed
npm run test:e2e        # Electron smoke tier: opens real app windows; needs the Electron binary (opt-in)
```

Tests run in parallel across worker processes. Set `VITEST_MAX_WORKERS` to change the worker count (default: half the logical cores). To replay a shuffled run, set `VITEST_SHUFFLE=1` and `VITEST_SEED=<printed seed>` in your shell, then run `npx vitest run`. The seed fixes the file order, independent of worker timing; projects run in parallel, so their files can interleave differently. `VITEST_MAX_WORKERS=1` gives an exact replay. Setting `VITEST_SEED` without `VITEST_SHUFFLE=1` is an error, not a silent no-op.

Tests live in `tests/unit` (one module under `src/main`), `tests/contract` (checks on static files and the test layout), and
`tests/renderer` (each renderer page in jsdom). The rules for writing tests are in `tests/helpers/README.md`.

**For developers: smoke-test overrides.** Two environment variables exist for the opt-in Electron smoke tests and are off by default. A packaged build ignores both: only an unpackaged run, such as `npm start` or the smoke tier, reads them. `TURNSTONE_PODMAN` replaces the `podman` command with a JSON array of strings: the executable first, then any arguments that go before the Podman arguments, for example `["C:\\node.exe","C:\\fake-podman.js"]`. `TURNSTONE_LOCAL_CONSOLE_URL` replaces the Local Console address with an `http://` URL on `127.0.0.1`, `localhost` or `[::1]`, for example `http://localhost:9191`; a URL with credentials or any other host is rejected. The console address keeps only the origin, so any path or query on the value is dropped. A malformed value is an error that names the variable, never a silent fallback: an empty value counts as unset, and a bad value of either variable stops the app at start with that message.

## Building

```bash
npm run make
```

Produces platform-specific distributables in `out/make/`.

## Releases

Pushing a version tag triggers CI builds for macOS, Windows, and Linux. The workflow publishes a GitHub Release. A tag containing a hyphen is marked a prerelease.

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

## License

[BUSL-1.1](LICENSE)
