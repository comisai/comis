// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "_remote-root.sh");
const RIG_HELPER = resolve(HERE, "_rig.sh");
const RIG_NODE_HELPER = resolve(HERE, "_rig.mjs");
const RESTART_DAEMON = resolve(HERE, "restart-daemon.sh");
const CLEAN_RESTART = resolve(HERE, "clean-restart.sh");
const PHASE_ZERO_CHECK = resolve(HERE, "phase0-check.sh");
const LOCAL_UP = resolve(HERE, "local-up.sh");
const WIRE_EMULATOR = resolve(HERE, "wire-emu.mjs");
const DEPLOY_SCRIPTS = resolve(HERE, "deploy-scripts.sh");
const DEPLOY_EMULATOR = resolve(HERE, "deploy-emu.sh");
const RIG_DOCTOR = resolve(HERE, "rig-doctor.sh");
const VERIFY_BUILD = resolve(HERE, "verify-build.sh");
const INSTALL_VPS = resolve(HERE, "install-vps.sh");
const MEDIA_DRIVE = resolve(HERE, "media-drive.mjs");
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
  it("refuses to wipe a continuity-protected data root unless explicitly overridden", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-continuity-rig-"));
    temporaryDirectories.push(directory);
    writeFileSync(resolve(directory, ".continuity-protected"), "protected\n");

    const blocked = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -e",
          `source ${shellQuote(RIG_HELPER)}`,
          `DATA=${shellQuote(directory)}`,
          'rig_refuse_continuity_wipe "$DATA"',
          "echo WIPE-REACHED",
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env } },
    );

    expect(blocked.status).toBe(3);
    expect(blocked.stdout).not.toContain("WIPE-REACHED");
    expect(blocked.stderr).toContain("continuity-protected");
    expect(blocked.stderr).toContain("ALLOW_CONTINUITY_WIPE=1");
    expect(blocked.stderr).toContain("separate scratch DATA root");

    const allowed = runRigHelper('rig_refuse_continuity_wipe "$DATA"; echo WIPE-ALLOWED', {
      DATA: directory,
      ALLOW_CONTINUITY_WIPE: "1",
    });
    expect(allowed.trim()).toBe("WIPE-ALLOWED");
  });

  it("checks continuity protection before clean restart stops or deletes anything", () => {
    const source = readFileSync(CLEAN_RESTART, "utf8");
    const guard = source.indexOf('rig_refuse_continuity_wipe "$DATA"');
    const localStop = source.indexOf('pm2 stop "$SERVICE"');
    const remoteStop = source.indexOf('systemctl stop "$SERVICE"');
    const sessionWipe = source.indexOf("rm -rf '$DATA'/workspace/sessions/default/*");
    const memoryWipe = source.indexOf("rm -f '$DATA'/memory.db");

    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(localStop);
    expect(guard).toBeLessThan(remoteStop);
    expect(guard).toBeLessThan(sessionWipe);
    expect(guard).toBeLessThan(memoryWipe);
  });

  it("limits clean-restart worker cleanup to the selected data root", () => {
    const source = readFileSync(CLEAN_RESTART, "utf8");

    expect(source).toContain('for s in "$DATA"/terminal-worker/*.sock');
    expect(source).toContain("tmux -S '$s' kill-server");
    expect(source).not.toMatch(/pkill\b[^\n]*(?:share\/codex|share\/claude|bwrap)/);
  });

  it("lets media injection select a sender independently from the chat", () => {
    const source = readFileSync(MEDIA_DRIVE, "utf8");

    expect(source).toContain("process.env.FROMUSER");
    expect(source).toContain("fromUserId: fromUser");
  });

  it("sends the media caption in the control API field the emulator preserves", () => {
    const source = readFileSync(MEDIA_DRIVE, "utf8");

    expect(source).toContain("caption: caption || undefined");
    expect(source).not.toContain("meta: caption");
  });

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

  it("preserves an explicit isolated DATA override while dropping the leaked remote layout", () => {
    const isolated = runRigHelper('rig_defaults 2>/dev/null; echo "$DATA|$COMIS_HOME|$PKG"', {
      RIG_MODE: "local",
      HOME: "/tmp/fake-home",
      COMIS_HOME: "/home/comis-does-not-exist-here",
      DATA: "/tmp/explicit-isolated-rig",
      PKG: "/home/comis-does-not-exist-here/.npm-global/lib/node_modules/comisai",
    });

    expect(isolated).toContain("/tmp/explicit-isolated-rig|/tmp/fake-home|");
    expect(isolated).not.toContain("comis-does-not-exist-here");
  });

  it("keeps explicit local selections ahead of live and rendered rig files", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-rig-precedence-"));
    temporaryDirectories.push(directory);
    const isolatedData = resolve(directory, "isolated-data");
    const everydayData = resolve(directory, "everyday-data");
    const liveEnv = resolve(directory, "live.env");
    const rigEnv = resolve(directory, "rig.env");
    writeFileSync(
      liveEnv,
      [
        `DATA=${everydayData}`,
        "GW_PORT=4766",
        "SERVICE=comis",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      rigEnv,
      [
        'export RIG_MODE="${RIG_MODE:-local}"',
        `export COMIS_USER="\${COMIS_USER:-test-user}"`,
        `export COMIS_HOME="\${COMIS_HOME:-${directory}}"`,
        `export DATA="\${DATA:-${resolve(directory, "rendered-data")}}"`,
        `export PKG="\${PKG:-${resolve(HERE, "../../../..")}}"`,
        'export SERVICE="${SERVICE:-comis-rendered}"',
        'export GW_PORT="${GW_PORT:-4767}"',
        'export CHATID="${CHATID:-678314278}"',
        `export EMU_DIR="\${EMU_DIR:-${resolve(HERE, "../../../..")}}"`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const output = runRigHelper(
      `rig_load_env ${shellQuote(liveEnv)} ${shellQuote(rigEnv)}; printf '%s|%s|%s\n' "$DATA" "$GW_PORT" "$SERVICE"`,
      {
        HOME: directory,
        RIG_MODE: "local",
        RIG_ENV: rigEnv,
        DATA: isolatedData,
        GW_PORT: "4877",
        SERVICE: "comis-local-drive",
      },
    );

    expect(output.trim()).toBe(`${isolatedData}|4877|comis-local-drive`);
  });

  it("restores the rendered local gateway port with the isolated data root", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-rig-port-"));
    temporaryDirectories.push(directory);
    const isolatedData = resolve(directory, "isolated-data");
    const rigEnv = resolve(directory, "rig.env");
    writeFileSync(
      rigEnv,
      [
        'export RIG_MODE="${RIG_MODE:-local}"',
        `export COMIS_USER="\${COMIS_USER:-test-user}"`,
        `export COMIS_HOME="\${COMIS_HOME:-${directory}}"`,
        `export DATA="\${DATA:-${isolatedData}}"`,
        `export PKG="\${PKG:-${resolve(HERE, "../../../..")}}"`,
        'export SERVICE="${SERVICE:-comis}"',
        'export GW_PORT="${GW_PORT:-4767}"',
        'export CHATID="${CHATID:-678314278}"',
        `export EMU_DIR="\${EMU_DIR:-${resolve(HERE, "../../../..")}}"`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const resolved = runRigHelper(
      `rig_load_persisted_env "$RIG_ENV"; printf '%s|%s\\n' "$DATA" "$GW_PORT"`,
      {
        HOME: directory,
        RIG_ENV: rigEnv,
        COMIS_USER: "comis",
        COMIS_HOME: "/home/comis-does-not-exist-here",
        DATA: "/home/comis-does-not-exist-here/.comis",
        PKG: "/home/comis-does-not-exist-here/.npm-global/lib/node_modules/comisai",
        EMU_DIR: "/root/comis-emu",
        GW_PORT: "4766",
      },
    );

    expect(resolved.trim()).toBe(`${isolatedData}|4767`);
  });

  it("refuses the everyday local service before changing its config", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-up-isolation-"));
    temporaryDirectories.push(directory);
    const data = resolve(directory, "isolated-data");
    mkdirSync(data, { recursive: true });
    const config = resolve(data, "config.yaml");
    writeFileSync(config, "sentinel: unchanged\n", { mode: 0o600 });

    const result = spawnSync("bash", [LOCAL_UP], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        RIG_MODE: "local",
        DATA: data,
        GW_PORT: "4878",
        SERVICE: "comis",
        SKIP_BUILD: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("SERVICE must name a dedicated local rig");
    expect(readFileSync(config, "utf8")).toBe("sentinel: unchanged\n");
  });

  it("refuses the everyday local data root before changing its config", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-up-everyday-root-"));
    temporaryDirectories.push(directory);
    const data = resolve(directory, ".comis");
    mkdirSync(data, { recursive: true });
    const config = resolve(data, "config.yaml");
    writeFileSync(config, "sentinel: unchanged\n", { mode: 0o600 });

    const result = spawnSync("bash", [LOCAL_UP], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        RIG_MODE: "local",
        DATA: data,
        GW_PORT: "4879",
        SERVICE: "comis-local-drive",
        SKIP_BUILD: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("DATA must not be the operator's everyday");
    expect(readFileSync(config, "utf8")).toBe("sentinel: unchanged\n");
  });

  it("loads the rendered rig selection in every standalone local gate", () => {
    for (const script of [DEPLOY_EMULATOR, RIG_DOCTOR, VERIFY_BUILD]) {
      const source = readFileSync(script, "utf8");
      expect(source, script).toContain("rig_load_env");
    }
  });

  it("keeps the local rig shell entry points syntactically valid", () => {
    for (const script of [
      RIG_HELPER,
      LOCAL_UP,
      RESTART_DAEMON,
      CLEAN_RESTART,
      DEPLOY_SCRIPTS,
      DEPLOY_EMULATOR,
      RIG_DOCTOR,
      VERIFY_BUILD,
      resolve(HERE, "restart-emu.sh"),
      resolve(HERE, "phase0-check.sh"),
      resolve(HERE, "durability-resume-probe.sh"),
    ]) {
      expect(() => execFileSync("bash", ["-n", script]), script).not.toThrow();
    }
  });

  it("lets bare node helpers discover the rendered local rig mode", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-node-rig-mode-"));
    temporaryDirectories.push(directory);
    const helperCopy = resolve(directory, "_rig.mjs");
    const isolatedData = resolve(directory, "isolated-data");
    writeFileSync(helperCopy, readFileSync(RIG_NODE_HELPER, "utf8"));
    writeFileSync(
      resolve(directory, ".rig-env"),
      [
        'export RIG_MODE="${RIG_MODE:-local}"',
        `export COMIS_USER="\${COMIS_USER:-test-user}"`,
        `export COMIS_HOME="\${COMIS_HOME:-${directory}}"`,
        `export DATA="\${DATA:-${isolatedData}}"`,
        `export PKG="\${PKG:-${directory}}"`,
        'export SERVICE="${SERVICE:-comis}"',
        'export GW_PORT="${GW_PORT:-4767}"',
        'export CHATID="${CHATID:-678314278}"',
        `export EMU_DIR="\${EMU_DIR:-${directory}}"`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const env = { ...process.env };
    for (const key of [
      "RIG_MODE",
      "RIG_ENV",
      "COMIS_USER",
      "COMIS_HOME",
      "COMIS_DATA_DIR",
      "DATA",
      "COMIS_SRC",
      "GW_PORT",
      "EMU_DIR",
    ]) {
      delete env[key];
    }

    const output = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { rig } from ${JSON.stringify(pathToFileURL(helperCopy).href)}; console.log(JSON.stringify({ mode: rig.mode, dataDir: rig.dataDir, gwPort: rig.gwPort }));`,
      ],
      { encoding: "utf8", env },
    );

    expect(JSON.parse(output)).toEqual({
      mode: "local",
      dataDir: isolatedData,
      gwPort: 4767,
    });
  });

  it("keeps the portable probes off Linux-only tools", () => {
    // `ss` does not exist on macOS and `date -d` is GNU-only: a local rig that shelled out to either
    // would report a healthy daemon as down (or a fresh build as stale) instead of failing honestly.
    const epoch = runRigHelper('rig_epoch "2026-07-28T17:18:03.000Z"').trim();
    expect(Number(epoch)).toBe(Math.floor(Date.parse("2026-07-28T17:18:03.000Z") / 1000));
    expect(runRigHelper('rig_epoch "not a date"').trim()).toBe("0");

    const source = readFileSync(RIG_HELPER, "utf8");
    expect(source).toContain("command -v lsof");
    expect(source).toMatch(/rig_daemon_pid\(\)[\s\S]*LOCAL_DAEMON_PID_FILE/u);
  });

  it("finds only the daemon owned by the selected local data root", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-daemon-owner-"));
    temporaryDirectories.push(directory);
    const entry = resolve(directory, "packages/daemon/dist/daemon.js");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "setInterval(() => {}, 1000);\n");
    const processHandle = spawn(process.execPath, [entry], { stdio: "ignore" });

    try {
      const unowned = runRigHelper('rig_defaults; printf "%s" "$(rig_daemon_pid)"', {
        RIG_MODE: "local",
        DATA: resolve(directory, "unowned-data"),
        PKG: directory,
        SERVICE: "comis-local-drive",
        LOCAL_SUPERVISOR: "direct",
      });
      expect(unowned).toBe("");

      const ownedData = resolve(directory, "owned-data");
      mkdirSync(ownedData, { recursive: true });
      writeFileSync(resolve(ownedData, ".local-daemon.pid"), `${processHandle.pid}\n`, { mode: 0o600 });
      const owned = runRigHelper('rig_defaults; printf "%s" "$(rig_daemon_pid)"', {
        RIG_MODE: "local",
        DATA: ownedData,
        PKG: directory,
        SERVICE: "comis-local-drive",
        LOCAL_SUPERVISOR: "direct",
      });
      expect(owned).toBe(String(processHandle.pid));
    } finally {
      processHandle.kill("SIGKILL");
    }
  });

  it("keeps the local lifecycle free of sudo and systemd", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");
    const clean = readFileSync(CLEAN_RESTART, "utf8");

    // Both still drive systemd on the remote rig — but only inside a `rig_is_local` else-branch.
    expect(restart).toMatch(/if rig_is_local; then[\s\S]*else[\s\S]*systemctl restart/u);
    expect(clean).toContain("as_service_user");
    expect(clean).not.toMatch(/^\s*sudo -u "\$COMIS_USER" bash -c/mu);
  });

  it("offers a tmux-backed local supervisor for shells that reap detached children", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");

    expect(restart).toMatch(/LOCAL_SUPERVISOR[^]*tmux/u);
    expect(restart).toMatch(/tmux new-session -d -s/u);
    expect(restart).toMatch(/COMIS_CONFIG_PATHS[^]*daemon\.console\.log/u);
  });

  it("restarts the tmux-backed local daemon after the configured reload exit", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");

    expect(restart).toMatch(/while true; do[^]*node[^]*daemon\.console\.log/u);
    expect(restart).toContain("daemon_exit_code=\\$?");
    expect(restart).toContain('if [ \\"\\$daemon_exit_code\\" -eq 42 ]; then continue');
    expect(restart).toContain('exit \\"\\$daemon_exit_code\\"');
    expect(restart).not.toContain("status=\\$?");
  });

  it("binds local daemon boot and runtime storage to the isolated rig data directory", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");

    expect(restart).toMatch(
      /COMIS_DATA_DIR=['"]?\$DATA['"]?[^]*COMIS_CONFIG_PATHS=['"]?\$DATA\/config\.yaml/u,
    );
  });

  it("blocks the baseline while first-run onboarding is still pending", () => {
    const phaseZero = readFileSync(PHASE_ZERO_CHECK, "utf8");

    expect(phaseZero).toContain("$DATA/workspace/BOOTSTRAP.md");
    expect(phaseZero).toContain("finish or explicitly skip setup through the channel");
  });

  it("uses portable local gateway and Linux-jail preflight semantics", () => {
    const phaseZero = readFileSync(PHASE_ZERO_CHECK, "utf8");

    expect(phaseZero).toContain('rig_port_listening "$GW_PORT"');
    expect(phaseZero).not.toContain('timeout 3 bash -c "exec 3<>/dev/tcp/');
    expect(phaseZero).toMatch(
      /rig_is_local[^]*"\$bin" = "bwrap"[^]*warn "jail-dep:\$bin"[^]*NO-ACCESS/u,
    );
  });
});
