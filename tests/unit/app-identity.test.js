import { describe, it, expect } from "vitest";

const { appUserModelId, INSTALLED_APP_ID, DEV_APP_ID } = require("../../src/main/app-identity.js");

describe("appUserModelId", () => {
  // Failure: an installed build's window does not match the installer's shortcuts, so it gets a taskbar button of its
  // own beside the pinned one, and Windows may not show its notifications.
  it("gives an installed Windows build the ID Squirrel stamps on its shortcuts", () => {
    expect(appUserModelId({ platform: "win32", packaged: true })).toBe(INSTALLED_APP_ID);
    expect(INSTALLED_APP_ID).toBe("com.squirrel.turnstone-desktop.turnstone-desktop");
  });

  // Failure: a dev copy shares the installed app's ID, so the two merge into one taskbar button and the dev window
  // takes the installed app's pin, or the other way round.
  it("gives a dev run on Windows an ID of its own", () => {
    expect(appUserModelId({ platform: "win32", packaged: false })).toBe(DEV_APP_ID);
    expect(DEV_APP_ID).toBe("turnstone-desktop.dev");
    expect(DEV_APP_ID).not.toBe(INSTALLED_APP_ID);
  });

  // Failure: the app sets a Windows-only ID on macOS or Linux, where Electron has no such call to make.
  it("gives no ID on macOS or Linux", () => {
    expect(appUserModelId({ platform: "darwin", packaged: true })).toBeNull();
    expect(appUserModelId({ platform: "linux", packaged: false })).toBeNull();
  });
});
