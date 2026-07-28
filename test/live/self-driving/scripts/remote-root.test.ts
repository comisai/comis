// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "_remote-root.sh");
const RIG_HELPER = resolve(HERE, "_rig.sh");
const RESTART_DAEMON = resolve(HERE, "restart-daemon.sh");
const CLEAN_RESTART = resolve(HERE, "clean-restart.sh");
const WIRE_EMULATOR = resolve(HERE, "wire-emu.mjs");
const DEPLOY_SCRIPTS = resolve(HERE, "deploy-scripts.sh");
const DEPLOY_EMULATOR = resolve(HERE, "deploy-emu.sh");
const INSTALL_VPS = resolve(HERE, "install-vps.sh");
const temporaryDirectories: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runRemoteRoot(remoteSudo: "0" | "1", input = "", rigMode?: "local" | "remote"): string {
  const directory = mkdtempSync(resolve(tmpdir(), "comis-remote-root-"));
  temporaryDirectories.push(directory);
  const capturePath = resolve(directory, "capture");
  const fakeSsh = resolve(directory, "ssh");
  writeFileSync(
    fakeSsh,
    `#!/usr/bin/env bash\nprintf 'ARGV='\nprintf '<%s>' "$@"\nprintf '\\nSTDIN='\ncat\n`,
    { mode: 0o700 },
  );
  chmodSync(fakeSsh, 0o700);

  const script = [
    `source ${shellQuote(HELPER)}`,
    "VPS=test-vps",
    `REMOTE_SUDO=${remoteSudo}`,
    // The command echoes its own stdin so a LOCAL run is observably the same contract as the ssh
    // one: the command is metadata, the caller's stdin passes straight through.
    `printf %s ${shellQuote(input)} | remote_root ${shellQuote("printf 'ARGV=<local>\\nSTDIN='; cat")}`,
  ].join("\n");
  const output = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
      CAPTURE: capturePath,
      ...(rigMode === undefined ? {} : { RIG_MODE: rigMode }),
    },
  });
  return output;
}

/** Run a snippet with `_rig.sh` sourced, returning its stdout. */
function runRigHelper(snippet: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", `source ${shellQuote(RIG_HELPER)}\n${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sudo-aware live rig transport", () => {
  it("uses a normal remote shell for a direct-root SSH target", () => {
    const output = runRemoteRoot("0", "stream-data");

    expect(output).toContain("<test-vps>");
    expect(output).toContain("<bash -c");
    expect(output).not.toContain("sudo -n");
    expect(output).toContain("STDIN=stream-data");
  });

  it("prefixes the remote shell with non-interactive sudo when requested", () => {
    const output = runRemoteRoot("1", "archive-stream");

    expect(output).toContain("<test-vps>");
    expect(output).toContain("sudo -n -- bash -c");
    expect(output).toContain("STDIN=archive-stream");
  });

  it("keeps the helper free of credential-bearing command interpolation", () => {
    const source = readFileSync(HELPER, "utf8");

    expect(source).not.toContain("GWTOKEN");
    expect(source).not.toContain("COMIS_GATEWAY_TOKEN");
  });

  it("keeps the emulator config and its restoration copy private and service-owned", () => {
    const source = readFileSync(WIRE_EMULATOR, "utf8");

    expect(source).toContain("chmodSync(cfgPath, 0o600)");
    expect(source).toContain("chmodSync(backup, 0o600)");
    expect(source).toContain('execFileSync("chown", [`${rig.comisUser}:${rig.comisUser}`, cfgPath, backup])');
  });

  it("resolves an offline gateway secret and omits local extended attributes from streamed archives", () => {
    const scriptsSource = readFileSync(DEPLOY_SCRIPTS, "utf8");
    const emulatorSource = readFileSync(DEPLOY_EMULATOR, "utf8");

    expect(scriptsSource).toContain("secrets get --offline COMIS_GATEWAY_TOKEN");
    expect(scriptsSource).toContain("tar --no-xattrs");
    expect(emulatorSource).toContain("tar --no-xattrs");
  });

  it("uses service-none mode when a deployed build must remain stopped", () => {
    const source = readFileSync(INSTALL_VPS, "utf8");

    expect(source).toMatch(
      /if \[ "\$NO_SERVICE_START" = 1 \]; then install_flags="\$install_flags [^"]*--service none[^"]*"; fi/,
    );
    expect(source).toContain('installer_command="COMIS_REEXEC=1 $installer_command"');
    expect(source).toContain("installer_command=\"su - '$COMIS_USER' -c $quoted_installer_command\"");
  });

  it("makes the stopped installer stage traversable by the service user", () => {
    const source = readFileSync(INSTALL_VPS, "utf8");

    expect(source).toContain("chmod 0755 '$REMOTE_STAGE'");
    expect(source).toContain("chmod 0644 '$REMOTE_STAGE/install.sh'");
    expect(source).toMatch(/chmod 0644[^\n]+\$REMOTE_STAGE\/\$\(basename "\$TGZ"\)/);
  });
});

describe("local rig mode", () => {
  it("runs the command in a local shell with stdin intact and never reaches ssh", () => {
    const output = runRemoteRoot("0", "stream-data", "local");

    expect(output).toContain("ARGV=<local>");
    expect(output).toContain("STDIN=stream-data");
    // The stubbed ssh on PATH would have echoed the target; a local run must never invoke it.
    expect(output).not.toContain("<test-vps>");
  });

  it("ignores REMOTE_SUDO locally so a rig run never writes root-owned files into its own data dir", () => {
    const output = runRemoteRoot("1", "archive-stream", "local");

    expect(output).not.toContain("sudo -n");
    expect(output).toContain("STDIN=archive-stream");
  });

  it("does not require VPS in local mode", () => {
    const output = execFileSync(
      "bash",
      ["-c", `source ${shellQuote(HELPER)}\nunset VPS\nremote_root ${shellQuote("printf ok")}`],
      { encoding: "utf8", env: { ...process.env, RIG_MODE: "local" } },
    );

    expect(output).toBe("ok");
  });

  it("rejects an unknown RIG_MODE rather than silently defaulting to the remote rig", () => {
    // A typo'd mode must never resolve to `remote` — that is how a "local" run reaches a real box.
    const probe = runRigHelper('rig_mode >/dev/null 2>&1; echo "exit=$?"', { RIG_MODE: "vps" });

    expect(probe.trim()).toBe("exit=2");
  });

  it("ABORTS the script on an unknown RIG_MODE — reporting it is not enough", () => {
    // rig_mode runs inside `$( )`, so it can only report; rig_is_local then reads false and the run
    // would proceed against the REMOTE box. rig_defaults is the top-level chokepoint that must exit.
    const run = (): { status: number; stdout: string } => {
      try {
        const stdout = execFileSync(
          "bash",
          ["-c", `source ${shellQuote(RIG_HELPER)}\nrig_defaults\necho REACHED-THE-RIG`],
          { encoding: "utf8", env: { ...process.env, RIG_MODE: "vps" }, stdio: "pipe" },
        );
        return { status: 0, stdout };
      } catch (error) {
        const e = error as { status?: number; stdout?: string };
        return { status: e.status ?? -1, stdout: e.stdout ?? "" };
      }
    };

    const { status, stdout } = run();
    expect(status).toBe(2);
    expect(stdout).not.toContain("REACHED-THE-RIG");
  });

  it("resolves per-mode defaults without clobbering an explicit override", () => {
    const local = runRigHelper('rig_defaults; echo "$DATA|$KIT_DIR"', {
      RIG_MODE: "local",
      HOME: "/tmp/fake-home",
    });
    expect(local).toContain("/tmp/fake-home/.comis|");

    const pinned = runRigHelper('rig_defaults; echo "$DATA"', {
      RIG_MODE: "local",
      HOME: "/tmp/fake-home",
      DATA: "/tmp/isolated-rig",
    });
    expect(pinned.trim()).toBe("/tmp/isolated-rig");

    const remote = runRigHelper('rig_defaults; echo "$DATA|$KIT_DIR"', { RIG_MODE: "remote" });
    expect(remote.trim()).toBe("/home/comis/.comis|/root");
  });

  it("drops a leaked remote layout instead of pointing a local run at the VPS paths", () => {
    // A .live-env predating RIG_MODE assigns the remote layout unconditionally; keeping it would
    // aim a "local" run at /home/comis and fail every probe for the wrong reason.
    const leaked = runRigHelper('rig_defaults 2>/dev/null; echo "$DATA|$COMIS_USER"', {
      RIG_MODE: "local",
      HOME: "/tmp/fake-home",
      COMIS_HOME: "/home/comis-does-not-exist-here",
      DATA: "/home/comis-does-not-exist-here/.comis",
      PKG: "/home/comis-does-not-exist-here/.npm-global/lib/node_modules/comisai",
    });

    expect(leaked).toContain("/tmp/fake-home/.comis|");
    expect(leaked).not.toContain("comis-does-not-exist-here");
  });

  it("keeps the portable probes off Linux-only tools", () => {
    // `ss` does not exist on macOS and `date -d` is GNU-only: a local rig that shelled out to either
    // would report a healthy daemon as down (or a fresh build as stale) instead of failing honestly.
    const epoch = runRigHelper('rig_epoch "2026-07-28T17:18:03.000Z"').trim();
    expect(Number(epoch)).toBe(Math.floor(Date.parse("2026-07-28T17:18:03.000Z") / 1000));
    expect(runRigHelper('rig_epoch "not a date"').trim()).toBe("0");

    const source = readFileSync(RIG_HELPER, "utf8");
    expect(source).toContain("command -v lsof");
    expect(source).toMatch(/rig_daemon_pid\(\)[\s\S]*\^node \.\*daemon/u);
  });

  it("keeps the local lifecycle free of sudo and systemd", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");
    const clean = readFileSync(CLEAN_RESTART, "utf8");

    // Both still drive systemd on the remote rig — but only inside a `rig_is_local` else-branch.
    expect(restart).toMatch(/if rig_is_local; then[\s\S]*else[\s\S]*systemctl restart/u);
    expect(clean).toContain("as_service_user");
    expect(clean).not.toMatch(/^\s*sudo -u "\$COMIS_USER" bash -c/mu);
  });
});
