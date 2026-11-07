import { describe, it, expect } from "vitest";

const {
  WSL_CONF,
  machineScript,
  machineCheckCommand,
  parseMachineReport,
  hardeningGaps,
} = require("../../src/main/machine-hardening.js");

// A report from a machine that holds every setting: what the POC machine answers today.
const CLEAN = [
  "wslconf=ok",
  "sudo=refused",
  "mount=drivers /usr/lib/wsl/drivers",
  "mount=E:\\134poc-desktop\\134allowed /mnt/allowed",
  "fstab=E:\\134poc-desktop\\134allowed /mnt/allowed",
  "end=ok",
].join("\n");

function gapsOf(lines) {
  return hardeningGaps(parseMachineReport(lines.join("\n")));
}

describe("WSL_CONF", () => {
  // Failure: a section is dropped from the app's copy, and every start writes the bypass ADR-05 closed back into the machine.
  it("holds each ADR-05 setting", () => {
    const sections = WSL_CONF.split("\n\n");
    expect(sections).toContain("[automount]\nenabled=false\nmountFsTab=true");
    expect(sections).toContain("[interop]\nenabled=false\nappendWindowsPath=false");
    expect(WSL_CONF).toContain('[boot]\ncommand="echo -1 > /proc/sys/fs/binfmt_misc/WSLInterop"\n');
  });

  // Failure: the app's copy differs from the hand-hardened machine by a byte, so the first start rewrites an already
  // correct file and restarts the machine for nothing.
  it("is byte for byte the file on the POC machine", () => {
    expect(Buffer.byteLength(WSL_CONF, "utf8")).toBe(176);
    expect(WSL_CONF.startsWith("[user]\ndefault=user\n\n[automount]\n")).toBe(true);
    expect(WSL_CONF.endsWith('WSLInterop"\n')).toBe(true);
    expect(WSL_CONF).not.toContain("\r");
  });
});

describe("machineCheckCommand", () => {
  // Failure: the command carries a quote, a space-separated script or a line break, and Windows argument quoting or
  // the machine's shell changes it on the way, so the check runs something other than what was written.
  it("is one line of base64 and a pipe, with nothing a shell or Windows quoting can change", () => {
    const command = machineCheckCommand();
    expect(command).toMatch(/^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
  });

  // Failure: the encoded script is not the one the tests read, so a reviewed script is not what reaches the machine.
  it("decodes to machineScript()", () => {
    const encoded = machineCheckCommand().split(" ")[2];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(machineScript());
  });
});

describe("machineScript", () => {
  // Failure: a carriage return reaches the machine's shell and breaks every line it ends (POC #1499).
  it("has no carriage return", () => {
    expect(machineScript()).not.toContain("\r");
  });

  // Failure: the script writes a wsl.conf other than WSL_CONF, so the file it checks against is not the one it puts back.
  it("carries WSL_CONF encoded, so the file is written as the app holds it", () => {
    const encoded = Buffer.from(WSL_CONF, "utf8").toString("base64");
    expect(machineScript()).toContain(`printf %s ${encoded} | base64 -d`);
  });

  // Failure: a script cut short reads as a clean machine, because the gaps it never reached are not in the report.
  it("ends by reporting that it finished", () => {
    expect(machineScript().trimEnd().endsWith("echo end=ok")).toBe(true);
  });

  // Failure: the check asks sudo as root, which always succeeds, or as nobody, so the machine user's grant is never tested.
  it("asks sudo as the machine user, uid 1000, never as root", () => {
    expect(machineScript()).toContain("id -nu 1000");
    expect(machineScript()).toContain('runuser -u "$u" -- sudo -n true');
  });
});

describe("parseMachineReport", () => {
  // Failure: a report with no end line counts as complete, so a check cut off part way reads as a clean machine.
  it("is complete only with the end line", () => {
    expect(parseMachineReport(CLEAN).complete).toBe(true);
    expect(parseMachineReport(CLEAN.replace("end=ok", "")).complete).toBe(false);
    expect(parseMachineReport("").complete).toBe(false);
  });

  // Failure: a login banner or a carriage return from the ssh session breaks the parse, and a clean machine is refused.
  it("ignores lines it does not know and strips carriage returns", () => {
    const report = parseMachineReport(`Welcome to the machine\r\n${CLEAN.replace(/\n/g, "\r\n")}`);
    expect(report.complete).toBe(true);
    expect(report.wslconf).toBe("ok");
    expect(report.sudo).toBe("refused");
  });

  // Failure: a mount is split at the wrong space, so its target never matches the fstab line that allows it.
  it("reads each mount and fstab line as a source and a target", () => {
    const report = parseMachineReport(CLEAN);
    expect(report.mounts).toEqual([
      { source: "drivers", target: "/usr/lib/wsl/drivers" },
      { source: "E:\\134poc-desktop\\134allowed", target: "/mnt/allowed" },
    ]);
    expect(report.fstab).toEqual([{ source: "E:\\134poc-desktop\\134allowed", target: "/mnt/allowed" }]);
  });
});

describe("hardeningGaps", () => {
  // Failure: a machine that holds every setting is refused, and Local mode never starts.
  it("finds no gap on a machine that holds every setting", () => {
    expect(hardeningGaps(parseMachineReport(CLEAN))).toEqual([]);
  });

  // Failure: the machine user keeps passwordless sudo, which mounts a whole drive past the fstab scoping (ADR-05 setting 4).
  it("reports sudo without a password", () => {
    expect(gapsOf(["wslconf=ok", "sudo=allowed", "end=ok"])).toEqual([
      "the machine user can use sudo without a password",
    ]);
  });

  // Failure: a check that could not ask sudo passes, so an unknown is read as safe.
  it("reports a sudo check that did not run as a gap", () => {
    expect(gapsOf(["wslconf=ok", "sudo=nouser", "end=ok"])).toEqual(["the machine user could not be checked for sudo"]);
    expect(gapsOf(["wslconf=ok", "end=ok"])).toEqual(["the machine user could not be checked for sudo"]);
  });

  // Failure: a sudoers file the script could not fix is left granting passwordless sudo, and only the sudo answer says so.
  it("reports a sudoers file that could not be fixed, and not one that was", () => {
    expect(gapsOf(["wslconf=ok", "sudo=refused", "sudoers=failed /etc/sudoers.d/90-wheel", "end=ok"])).toEqual([
      "/etc/sudoers.d/90-wheel grants sudo without a password and could not be changed",
    ]);
    expect(gapsOf(["wslconf=ok", "sudo=refused", "sudoers=fixed /etc/sudoers", "end=ok"])).toEqual([]);
  });

  // Failure: the WSLInterop handler stays registered, and a Windows .exe in a shared folder runs on Windows (ADR-05 setting 3).
  it("reports any WSLInterop handler, including the late one, and no other handler", () => {
    expect(
      gapsOf(["wslconf=ok", "sudo=refused", "binfmt=WSLInterop", "binfmt=WSLInterop-late", "binfmt=python3.14", "end=ok"]),
    ).toEqual([
      "Windows programs can still run inside the machine (WSLInterop is registered)",
      "Windows programs can still run inside the machine (WSLInterop-late is registered)",
    ]);
  });

  // Failure: automount comes back and every drive is mounted at /mnt/<letter> without anyone choosing it (ADR-05 setting 1).
  it("reports a Windows folder mounted that fstab does not list, with its path decoded", () => {
    expect(gapsOf(["wslconf=ok", "sudo=refused", "mount=C:\\134 /mnt/c", "end=ok"])).toEqual([
      "a Windows folder is mounted that /etc/fstab does not list: C:\\ at /mnt/c",
    ]);
  });

  // Failure: a different folder mounted at a listed target passes, because only the target was compared.
  it("needs the source and the target to match an fstab line", () => {
    expect(
      gapsOf([
        "wslconf=ok",
        "sudo=refused",
        "mount=E:\\134 /mnt/allowed",
        "fstab=E:\\134poc-desktop\\134allowed /mnt/allowed",
        "end=ok",
      ]),
    ).toEqual(["a Windows folder is mounted that /etc/fstab does not list: E:\\ at /mnt/allowed"]);
  });

  // Failure: WSL's own driver folders read as a share nobody chose, and every machine with a GPU is refused.
  it("allows WSL's own mounts under /usr/lib/wsl", () => {
    expect(gapsOf(["wslconf=ok", "sudo=refused", "mount=lib /usr/lib/wsl/lib", "end=ok"])).toEqual([]);
  });

  // Failure: a wsl.conf that Podman or WSL rewrites on every boot reads as fixed, and its settings never take effect.
  it("reports a wsl.conf that still differs after the restart, or could not be written", () => {
    expect(gapsOf(["wslconf=rewritten", "sudo=refused", "end=ok"])).toEqual([
      "wsl.conf does not keep the app's settings after a restart",
    ]);
    expect(gapsOf(["wslconf=failed", "sudo=refused", "end=ok"])).toEqual(["wsl.conf could not be written"]);
    expect(gapsOf(["sudo=refused", "end=ok"])).toEqual(["wsl.conf could not be written"]);
  });
});
