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
| **When the window closes** | Keep running in the tray | Always | What closing the window (the X button, `Alt+F4`, or the taskbar's Close) does on Windows and Linux. Keep running in the tray hides the window, and the app, its checks, notifications and the Local pod carry on; Quit in the tray menu shuts it down. Quit the app quits, as Quit in the tray does. See [System tray](#system-tray). | Keep running in the tray or Quit the app. Has no effect on macOS, where the app always keeps running after its window closes. |
| **When the app quits** | Stop Turnstone server | Local only | Whether the Local pod, which runs the Turnstone server, is stopped when the app quits. See [Local mode](#local-mode). | Stop Turnstone server or Keep Turnstone server running. |

**What saving does**

- **A mode change** closes and rebuilds the window. The menu, views, health checks and notifications are set up again for the new mode.
- **A URL change** reloads only the affected view. Health checks run right away. If the Server URL changed, notifications restart.
- **Changing only *When the app quits* or *When the window closes*** takes effect immediately, with no reload.
- **Switching into Local** starts the pod startup sequence. See [Local mode](#local-mode).
- **Hidden fields are not validated or changed.** For example, in Local mode your saved remote Console URL is kept.
- **If validation fails**, the dialog stays open with an error message and nothing is saved.
- **Cancel** or `Esc` closes the dialog without saving. `Enter` in a text field saves.

**Where settings are stored.** Settings are saved in `turnstone-desktop.json` in the app's user-data folder. The app also saves the window size and position, the last active tab, whether it has launched before, and whether the tray notice has been shown. These are not shown in the dialog.

## Local mode

Local mode runs Turnstone in a Podman pod on this PC and opens its Console at `http://127.0.0.1:8090`. The Console URL field is hidden in this mode, and the app always uses that address.

**Before you use it.** These must already exist:

- Podman 6.1.4 or later is installed, and `podman` runs from the PATH the app sees.
- A Podman connection named `turnstone`, with a pod named `turnstone` on it. The pod commands use this connection. The app does not create the pod yet, but on a first run it downloads the image the pod will need (below).
- A Console that answers `/health` at `http://127.0.0.1:8090`.

The Podman machine named `turnstone` need not exist: the app creates it on first run (below).

**What happens on launch.** The loading screen, titled **Starting Local Turnstone**, shows these stages in order:

1. **Starting the Podman machine.** If there is no `turnstone` machine, the app creates one first, and the stage reads **Creating the Podman machine (first run only; this can take several minutes)**: it checks that Podman is 6.1.4 or later, then runs `podman machine init turnstone --username user`, which downloads the machine image. It allows the create 15 minutes. A create that fails is removed (`podman machine rm --force turnstone`), so Retry starts clean. Quitting during the create ends it and removes the half-made machine, so the quit does not wait for it. If the `turnstone` machine is not running, the app starts it. Then it puts back and checks the machine's safety settings (below), which a new machine needs on its first start.
2. **Starting Turnstone.** If the pod is not running, the app starts it. A pod that is already running is left alone. If there is no pod, this is a first run, and the app first makes sure the machine has the Turnstone image this release pins (see [Releases](#releases)): when it does not, the stage reads **Downloading Turnstone (first run only; this can take several minutes)** while the app pulls the image by its digest, never by tag. It allows the download 15 minutes, and quitting during it ends the download. Then it checks that the image carries the pinned digest; one that does not is removed and the start stops with `IMAGE_PULL_FAILED`. An interrupted download leaves nothing under the pinned digest, so Retry downloads again. The app does not create the pod yet, so a first run then stops at `POD_MISSING`, with the image in place.

   **Free space.** Before each download, the machine create and the image, the app checks that the drive holding Podman's machines (`containers\podman\machine` under `%XDG_DATA_HOME%` when that is set, as Podman does, otherwise under `%USERPROFILE%\.local\share`) has room: Turnstone needs 5 GB free. With less, or if the free space cannot be read, the start stops with `DISK_SPACE_LOW`.
3. **Waiting for the console.** The app checks `/health` once a second for up to 2 minutes, until it reports `ok`.
4. **Waiting for the node to come online (this can take about a minute).** The app checks once a second until a node is registered, for up to 3 minutes. If none has registered after 3 minutes, the Console opens anyway, provided the Console is still healthy. If the Console stopped answering, or answers with anything other than a healthy status, during the wait, you get the `HEALTH_TIMEOUT` error page instead.

The app creates the Podman machine when there is none, starts it when it is stopped, and starts or stops the existing pod. It stops the machine only to restart it after putting `/etc/wsl.conf` back, and removes it only after its own create failed.

**The machine's safety settings.** These keep Windows out of the machine, and nothing in the machine holds them in place, so on every start, before the pod, the app runs a script as root inside the machine (`podman machine ssh --username root turnstone`). It puts these back:

- `/etc/wsl.conf`: drives are not mounted automatically and only the folders in `/etc/fstab` are; Windows programs cannot be started and the Windows PATH is not added; a boot command removes the `WSLInterop` handler, which would otherwise still run a Windows `.exe` placed in a shared folder. If the file differs from the app's copy, the app writes its copy and restarts the machine, because the machine reads the file only when it boots. A pod that was running stops with the machine and is started again.
- sudo: each active `NOPASSWD` line in `/etc/sudoers` and `/etc/sudoers.d/` is commented out as `# turnstone-disabled: ...`, and a file is replaced only once `visudo` accepts the result. Passwordless sudo would let the machine user mount a whole drive.
- A `WSLInterop` handler registered since the machine booted is removed.

Then it checks that the gaps are closed: no `WSLInterop` handler is registered, the machine user (uid 1000) cannot run `sudo -n true`, and every Windows folder mounted in the machine is listed in `/etc/fstab` (WSL's own mounts under `/usr/lib/wsl` aside). If any check fails, the app stops the pod and shows `MACHINE_NOT_HARDENED`, with each gap in the detail line. A check that cannot run (`MACHINE_CHECK_FAILED`) or a restart that fails (`MACHINE_RESTART_FAILED`) also stops a pod left running, because the machine has not been shown to be safe. The app does not change `/etc/fstab`: which folders the machine sees is still set there.

**What happens on quit.** By default, closing the window only hides it to the tray and the pod keeps running (see *When the window closes*). Quit in the tray, or closing the window with *Quit the app* chosen, quits the app, and the Settings field *When the app quits* then controls the pod:

- **Stop Turnstone server** (the default): the app runs `podman --connection turnstone pod stop turnstone` before it exits. This happens if the app is starting or has inspected the pod this session. If startup failed before the pod was found (for example `POD_MISSING`), nothing is stopped. Quitting while startup is still running cancels the wait. Quit can wait up to 2 minutes while the pod stops. If startup was already running a Podman step when you quit, that step finishes first, so quitting can take longer. A machine create is the exception: it is ended, not waited for. A failed stop is ignored.
- **Keep Turnstone server running**: the pod is left running. The next launch does not start the machine or the pod if they are already running.

The app never stops the Podman machine on quit. If you switch away from Local mode during a session, Stop Turnstone server still stops the pod on quit.

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

When the PC sleeps, the checks stop and the one in flight is cancelled, so a sleep does not show as a disconnect. On wake, the app checks at once instead of waiting for the next 5-second check. For 15 seconds after a wake, a check that gets no answer keeps the last status, because the network can take a few seconds to come back; any answer, an error included, shows at once. The log notes each sleep and wake (`power: suspend, polls paused`, `power: resume, polling now`).

### System tray

- **Icon colour:** green when every active service is Connected, yellow when some are, red when none are. Grey until the first check.
- **Click the icon** to show the window. On Linux, which gesture activates the icon depends on the desktop environment; if clicking does nothing, use the tray menu.
- **Menu:** a read-only status line for each active service (for example `Server: Connected`). Local and Console Only show only Console, and Server Only shows only Server. In Server Only and Both, a line then says whether notifications work, from the end of the first poll on (see [Notifications](#notifications)). Then **Show Window**, **Settings...**, and **Quit**. **Quit** exits the app and applies the *When the app quits* setting.
- On **Windows and Linux**, closing the window hides it to the tray by default, and the app keeps running: its health checks and notifications carry on, and in Local mode the pod stays up. Click the tray icon, choose **Show Window**, or start the app again to bring the window back; nothing restarts. The first time the window hides, a notification says the app is still running and how to quit it. To quit, use **Quit** in the tray menu. To make closing the window quit instead, set *When the window closes* to Quit the app.
- A Windows shutdown or sign-out quits the app normally, and a mode change in Settings still closes and rebuilds the window.
- On some Linux desktops there is no tray. A hidden window comes back when you start the app again.
- On **macOS**, the app keeps running after the window closes, whatever the setting. Use the Dock icon, not the tray, to reopen a closed window.

### One copy at a time

The app runs one copy at a time. Starting it again brings the open window to the front, restoring it if it is minimized and showing it if it is hidden in the tray, and the new copy exits. The new copy does nothing else: it does not start, check or stop the Local machine or pod, and the *When the app quits* setting does not apply to it. The lock belongs to the user-data folder, so a copy started with a different `--user-data-dir` keeps its own settings and runs alongside.

### Notifications

Notifications run in **Server Only** and **Both** modes only. Every 10 seconds the app asks the server for the workstreams of the user signed in to the Server view, counting from the end of the last request, and notifies when one of that user's workstreams comes into a state that needs them.

- **Turnstone: Attention Needed**, with the text `Workstream "<name>" requires your input`, when one of your workstreams starts waiting for you.
- **Turnstone: Error**, with the text `Workstream "<name>" encountered an error`, when one of them fails.
- The name is the workstream's name, otherwise its ID. With neither, the text starts `A workstream`. The model can set a workstream's name, so the notification quotes it and shows only the first 40 characters of the workstream's name, on one line, with `…` where it was cut. Invisible characters are dropped, and fullwidth letters show as plain ones. Quote marks of any kind show as one single quote, and `<`, `>` and `&` as `‹`, `›` and `＆`.
- Only your own workstreams notify, even on a server where you can see other users' workstreams.
- A workstream that already needed you when notifications started does not notify. They start again, and only record where things stand, when the app starts, when the mode or the Server URL changes, when you or another user signs in, and after the server refused the requests or answered in a form the app cannot read.
- A sleep does not start them again. While the PC sleeps, the requests stop and the one in flight is cancelled, and the tray line stays as it was. On wake the app asks at once, so a workstream that came to need you while the PC slept notifies then. For 15 seconds after a wake, a request that gets no answer leaves the tray line as it is and logs nothing; a refusal shows at once.

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

- A link that opens a new window opens in your default browser, without asking, if it is an `http` or `https` link. Any other link that opens a new window does nothing. No page opens a window inside the app.
- A link inside a view that goes to a different address (different scheme, host or port) is blocked.

## Troubleshooting

### "Unable to connect" page

A view shows this page when it cannot load its address. The page names the address that failed (the one currently in Settings) and says "The server is not reachable. Check that Turnstone is running."

- **It reconnects on its own.** When the health check sees the service come back, the view loads its address again.
- **Retry** tries the address now. **Settings** opens the Settings dialog.
- **Reload** (`Ctrl+R`) also tries the address again.

To fix a wrong address, open Settings with `Ctrl+,` or from the tray menu. On macOS, you can also use the app menu. Saving the same address does not reload the view. Change the address or the mode.

### Local mode errors

If startup fails, the loading screen is replaced by an error page. It shows the error code as its title, a message, and a detail line with Podman's error. The detail leaves out the command the app ran, and shows `[redacted]` in place of any value under a key that names a secret: `jwt_secret`, `api_key`, or any key containing `password`, `token` or `secret`. The log is masked the same way. The **Retry** button runs the startup again. The **Settings** button opens Settings.

| Code | Message on screen | What to check |
|---|---|---|
| `PODMAN_NOT_FOUND` | Podman is not installed. Install Podman, then reopen Turnstone. | Install Podman. Check that `podman` runs from a terminal on this PC. |
| `PODMAN_TOO_OLD` | Podman is older than 6.1.4, which Turnstone needs to create its machine. Update Podman, then reopen Turnstone. | Update Podman. The detail line shows the version found. Only a first run, which creates the machine, checks it. |
| `DISK_SPACE_LOW` | Turnstone could not confirm 5 GB of free disk space for its download. Free up space, then reopen Turnstone. | Free space on the drive the detail line names, then Retry. The detail also says when the free space could not be read at all. |
| `IMAGE_PULL_FAILED` | The Turnstone image could not be downloaded. | Read the detail line: Podman's error for a failed download, or a digest that did not match the pin (that image was removed). Check the network, then Retry. To try it yourself, run `podman --connection turnstone pull` with the pinned reference from [Releases](#releases). |
| `MACHINE_CREATE_FAILED` | The Turnstone Podman machine could not be created. | Read the detail line, which shows Podman's error or why its version could not be read. The half-made machine was removed, so Retry tries again from the start. To see the error yourself, run `podman machine init turnstone --username user`. If the detail says the half-made machine could not be removed, or that a WSL distribution named `podman-turnstone` already exists, a create was interrupted before Podman saved the machine: if that distribution holds nothing you need, run `wsl --unregister podman-turnstone`, then Retry. The app never removes a distribution Podman does not know, since it could hold a machine whose Podman settings were lost. |
| `MACHINE_LIST_FAILED` | Podman answered, but its machine list could not be read. | Run `podman machine list --format json` by hand and read its error. |
| `MACHINE_START_FAILED` | The Turnstone Podman machine would not start. | Run `podman machine start turnstone` by hand and read its error. |
| `MACHINE_CHECK_FAILED` | The Turnstone machine's safety settings could not be checked, so Turnstone was not started. | Run `podman machine ssh --username root turnstone id -u` by hand. It must print `0`. The detail line shows Podman's error. |
| `MACHINE_RESTART_FAILED` | The Turnstone machine's safety settings were put back, but the machine would not restart to apply them. | Run `podman machine stop turnstone`, then `podman machine start turnstone`, by hand and read the error. |
| `MACHINE_NOT_HARDENED` | The Turnstone machine's safety settings are not holding, so Turnstone was not started. | The detail line names each gap. See *The machine's safety settings* under [Local mode](#local-mode). |
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

### A pinned dev shortcut on Windows

Windows puts a window on a pinned taskbar button only when both carry the same AppUserModelID. A dev run sets `turnstone-desktop.dev`, and an installed build sets the ID its installer gives its shortcuts. A shortcut you make by hand for a dev run carries no ID, so a dev copy that the shortcut did not start gets a taskbar button of its own.

A dev shortcut targets `<repo>\node_modules\electron\dist\electron.exe` with the argument `"<repo>"`, and starts in `<repo>`. Stamp it once:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stamp-dev-shortcut.ps1 -Path "C:\path\to\Turnstone Desktop (dev).lnk"
```

`-ExecutionPolicy Bypass` applies to that one PowerShell process, since Windows blocks scripts by default, and changes no machine setting.

**Stamping a shortcut that is already pinned** (pinned shortcuts live in `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`) may not be enough: Windows can keep the identity it read when the shortcut was first pinned, and two buttons still show. Pin it again from a stamped copy:

1. Unpin the old button. This deletes the pinned shortcut file.
2. Make a dev shortcut elsewhere, for example in `%APPDATA%\Microsoft\Windows\Start Menu\Programs`, and stamp it as above. A Start menu shortcut with the ID is also what Windows uses to show the app's notifications.
3. In Explorer, right-click the stamped shortcut and choose **Pin to taskbar**. On Windows 11 it can sit under **Show more options**. Start's search can take a while to list a new shortcut, so Explorer is the quicker way.

Do not pin the running window's taskbar button instead: Windows pins bare `electron.exe` without the repo argument, and that pin opens Electron's default screen rather than the app.

### Running the tests

```bash
npm test                # all tiers, in parallel
npm run test:unit       # tests/unit only
npm run test:contract   # tests/contract only
npm run test:renderer   # tests/renderer only (jsdom)
npm run test:shuffle    # files and tests in random order; prints the seed
npm run test:e2e        # Electron smoke tier: opens real app windows; needs the Electron binary (opt-in)
npm run test:packaged   # after npm run package or make: checks the packaged build's fuses and dropped launch switches
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

On Windows, the installer is `out/make/squirrel.windows/x64/Turnstone-<version> Setup.exe`. It installs for the current user, with no admin prompt.

Squirrel makes no shortcuts for this app. Instead it starts the app once for each event and waits for it: up to 15 seconds for install and update, 10 for uninstall. The app answers each event without opening a window:

- **Install:** creates the desktop shortcut and the Start menu shortcut, under Turnstone Labs.
  - Running a newer Setup.exe over an installed app is also an install, not an update.
  - Squirrel first ends a running copy, without the app's quit steps, so a Local mode pod is not stopped.
- **Update:** `Update.exe --update`. The app has no auto-updater and never runs it itself.
  - Refreshes both shortcuts.
  - Brings back a desktop shortcut the user deleted. Update.exe has no option that refreshes only the shortcuts that exist.
- **Uninstall:** removes both shortcuts. What stays: the empty Turnstone Labs folder; `%LOCALAPPDATA%\turnstone-desktop`, with the last version's folder; and the app's data in `%APPDATA%`.
- **An older version that an update is about to delete:** exits.

## Releases

Pushing a version tag triggers CI builds for macOS, Windows, and Linux. The workflow publishes a GitHub Release. A tag containing a hyphen is marked a prerelease.

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

**The pinned Turnstone image.** Each release ships one Turnstone version, pinned by its registry index digest in `src/main/turnstone-image.js` (ADR-03). A first run in Local mode pulls exactly that image, and newer versions come only through the updater. This release pins Turnstone 1.9.1:

```text
ghcr.io/turnstonelabs/turnstone@sha256:c98762f1c339986d84c255476d0fe188466bb13da1ccee695612ec3a83660d12
```

To move the pin for a release, look up the new version's index digest with an anonymous registry token, then set `version` and `digest` in `src/main/turnstone-image.js`, and update this section and its test (`tests/unit/turnstone-image.test.js`):

```bash
tok=$(curl -s "https://ghcr.io/token?scope=repository:turnstonelabs/turnstone:pull" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -sI -H "Authorization: Bearer $tok" -H "Accept: application/vnd.oci.image.index.v1+json" https://ghcr.io/v2/turnstonelabs/turnstone/manifests/X.Y.Z | grep -i docker-content-digest
```

The digest is the index's, not the linux/amd64 manifest's: a pull by the index digest records both on the image, and the app checks for the index digest.

## License

[BUSL-1.1](LICENSE)
