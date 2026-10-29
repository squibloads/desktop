# Turnstone Desktop

Desktop client for the [Turnstone](https://github.com/turnstonelabs/turnstone) AI orchestration platform.

A thin Electron wrapper that connects to your Turnstone server and/or console — it does not bundle or manage the Python backend.

## Modes

- **Server only** — single-node home deployments
- **Console only** — corporate cluster monitoring
- **Both** — tabbed interface with server and console views

## Features

- Custom title bar with health status indicators
- System tray with connection status
- Native notifications for workstream events
- Settings persistence (URLs, window position, mode)
- Auto-reconnect when backend comes back online

## Development

```bash
npm install
npm start
```

## Building

```bash
npm run make
```

Produces platform-specific distributables in `out/make/`.

## Releases

Tag a version to trigger CI builds for macOS, Windows, and Linux:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## License

[BUSL-1.1](https://github.com/turnstonelabs/turnstone/blob/main/LICENSE)

## Local mode

Local mode runs Turnstone on this PC in a Podman pod and opens its console at `http://127.0.0.1:8090`. On launch the app starts the `turnstone` Podman machine if it is stopped, starts the `turnstone` pod, and waits for `/health` before loading the console.

**When the app quits** (Settings): *Stop Turnstone* runs `podman pod stop turnstone`; *Keep Turnstone running* leaves the pod up so the next launch is instant.

Failures show their own message: Podman not installed, machine missing or unable to start, pod missing or unable to start, health timeout. The pod is only ever stopped and started, never restarted.
