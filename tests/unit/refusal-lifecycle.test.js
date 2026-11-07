import { describe, it, expect, vi } from "vitest";

const { createNotificationLifecycle } = require("../../src/main/notifications.js");
const { reachableSettings } = require("../../src/main/settings-save.js");

// Failure: a refused server is fixed in Settings, and notifications stay off until a restart, because restart() has no manager to restart.
describe("notifications after a refused address is fixed", () => {
  it("starts a stream once the address is valid and the lifecycle is applied again", () => {
    const store = { hasServer: true, serverUrl: "http://192.168.1.20:8080", hasConsole: false, consoleUrl: "" };
    const created = [];
    const lifecycle = createNotificationLifecycle(() => {
      const manager = { start: vi.fn(), stop: vi.fn() };
      created.push(manager);
      return manager;
    });

    lifecycle.apply(reachableSettings(() => store));
    expect(created).toHaveLength(0);

    store.serverUrl = "https://server.example.com:8443";
    lifecycle.apply(reachableSettings(() => store));

    expect(created).toHaveLength(1);
    expect(created[0].start).toHaveBeenCalledTimes(1);
  });
});
