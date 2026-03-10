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
