// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { AppConfigSchema } from "@comis/core";
import { offlineSecretGet } from "@comis/memory";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const HELPER = resolve(HERE, "_remote-root.sh");
const RIG_HELPER = resolve(HERE, "_rig.sh");
const RIG_NODE_HELPER = resolve(HERE, "_rig.mjs");
const RESTART_DAEMON = resolve(HERE, "restart-daemon.sh");
const CLEAN_RESTART = resolve(HERE, "clean-restart.sh");
const PHASE_ZERO_CHECK = resolve(HERE, "phase0-check.sh");
const LOCAL_UP = resolve(HERE, "local-up.sh");
const INIT_LOCAL_CONFIG = resolve(HERE, "init-local-config.sh");
const LOCAL_CONFIG = resolve(HERE, "local-config.mjs");
const WIRE_EMULATOR = resolve(HERE, "wire-emu.mjs");
const RESTART_EMULATOR = resolve(HERE, "restart-emu.sh");
const VPS_EMULATOR = resolve(HERE, "../../bin/vps-emu.ts");
const DEPLOY_SCRIPTS = resolve(HERE, "deploy-scripts.sh");
const DEPLOY_EMULATOR = resolve(HERE, "deploy-emu.sh");
const RIG_DOCTOR = resolve(HERE, "rig-doctor.sh");
const VERIFY_BUILD = resolve(HERE, "verify-build.sh");
const INSTALL_VPS = resolve(HERE, "install-vps.sh");
const MEDIA_DRIVE = resolve(HERE, "media-drive.mjs");
const temporaryDirectories: string[] = [];

// `local-config.mjs validate` must work from a plain in-repo run with NO rig env — that is the
// contract these gates pin, so they must not inherit whichever .rig-env the developer happens to
// have rendered in the scripts directory. RIG_ENV points at a path that cannot exist so _rig.mjs
// falls back to its own defaults (mode "remote") on every box, CI included. Reading the ambient
// file made these gates pass locally while CI failed them: a rendered RIG_MODE=local silently
// supplied the code root the validator was wrongly depending on.
const NO_RIG_ENV = { ...process.env, RIG_ENV: resolve(HERE, ".rig-env-absent") } as NodeJS.ProcessEnv;

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

function makeCanonicalTempDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function listFiles(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

/**
 * A scratch local rig the clean-restart script can actually be run against: the
 * kit copied into a temp dir (it resolves `_rig.sh` and `restart-daemon.sh`
 * beside itself), with the relaunch stubbed so the wipe is observable without
 * booting a daemon. `LOCAL_SUPERVISOR=direct` and an unbound `GW_PORT` keep the
 * lifecycle-owner assertion satisfied without touching pm2 or tmux.
 */
function makeCleanRestartRig(): {
  dataDir: string;
  run: () => ReturnType<typeof spawnSync>;
} {
  const kitDir = makeCanonicalTempDirectory("comis-clean-restart-kit-");
  const dataDir = makeCanonicalTempDirectory("comis-clean-restart-data-");
  for (const name of ["clean-restart.sh", "_rig.sh"]) {
    writeFileSync(resolve(kitDir, name), readFileSync(resolve(HERE, name), "utf8"));
  }
  writeFileSync(
    resolve(kitDir, "restart-daemon.sh"),
    "#!/usr/bin/env bash\necho RESTART-DAEMON-INVOKED\n",
  );
  chmodSync(resolve(kitDir, "restart-daemon.sh"), 0o755);
  return {
    dataDir,
    run: () =>
      spawnSync("bash", [resolve(kitDir, "clean-restart.sh")], {
        encoding: "utf8",
        env: {
          ...NO_RIG_ENV,
          RIG_MODE: "local",
          LOCAL_SUPERVISOR: "direct",
          SERVICE: "comis-clean-restart-rig",
          DATA: dataDir,
          GW_PORT: "47661",
          KIT_DIR: kitDir,
        },
      }),
  };
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

  it("revalidates a non-empty gateway token against the selected local rig", () => {
    const source = readFileSync(DEPLOY_SCRIPTS, "utf8");

    expect(source).toContain('resolved_gateway_token=""');
    expect(source).toContain(
      'if [ -n "${GWTOKEN:-}" ] && [ "$GWTOKEN" != "$resolved_gateway_token" ]; then',
    );
    expect(source).toContain(
      "the configured GWTOKEN does not match the selected rig — using its resolved token",
    );
    expect(source).not.toContain('&& ! rig_is_local; then');
    expect(source).not.toContain("Authorization: Bearer $GWTOKEN");
  });

  it("does not persist the selected gateway token in a local rendered rig env", () => {
    const source = readFileSync(DEPLOY_SCRIPTS, "utf8");

    expect(source).toContain('if rig_is_local; then rendered_gateway_token=""; fi');
    expect(source).toContain('export GWTOKEN="\\${GWTOKEN:-${rendered_gateway_token:-}}"');
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

  it("clears prior diagnostic trajectories during a clean restart", () => {
    const source = readFileSync(CLEAN_RESTART, "utf8");
    const guard = source.indexOf('rig_refuse_continuity_wipe "$DATA"');
    const trajectoryWipe = source.indexOf("rm -rf '$DATA'/trajectories/*");

    expect(trajectoryWipe).toBeGreaterThan(guard);
  });

  // Substring ordering is not the wipe: a commented-out line, a line inside a
  // branch this run never takes, or a reordered guard all read the same. Run the
  // script against a scratch DATA root and check the state it actually leaves.
  it("clears persisted background tasks during a clean restart", () => {
    const { dataDir, run } = makeCleanRestartRig();
    mkdirSync(resolve(dataDir, "background-tasks"), { recursive: true });
    writeFileSync(
      resolve(dataDir, "background-tasks", "task-a.json"),
      JSON.stringify({ id: "task-a", status: "failed" }),
    );
    mkdirSync(resolve(dataDir, "trajectories"), { recursive: true });
    writeFileSync(resolve(dataDir, "trajectories", "prior.jsonl"), "{}\n");

    const wiped = run();

    expect(wiped.status).toBe(0);
    expect(wiped.stdout).toContain("RESTART-DAEMON-INVOKED");
    expect(listFiles(resolve(dataDir, "background-tasks"))).toEqual([]);
    expect(listFiles(resolve(dataDir, "trajectories"))).toEqual([]);
  });

  it("leaves persisted background tasks intact when continuity is protected", () => {
    const { dataDir, run } = makeCleanRestartRig();
    mkdirSync(resolve(dataDir, "background-tasks"), { recursive: true });
    writeFileSync(resolve(dataDir, "background-tasks", "task-a.json"), "{}");
    writeFileSync(resolve(dataDir, ".continuity-protected"), "protected\n");

    const refused = run();

    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("continuity-protected");
    expect(refused.stdout).not.toContain("RESTART-DAEMON-INVOKED");
    expect(listFiles(resolve(dataDir, "background-tasks"))).toEqual(["task-a.json"]);
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

  it("rebuilds local emulator paths after dropping a leaked remote layout", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-rig-emulator-layout-"));
    temporaryDirectories.push(directory);
    const isolatedData = resolve(directory, "isolated-data");
    const liveEnv = resolve(directory, "live.env");
    const rigEnv = resolve(directory, "rig.env");
    const missingRemoteHome = "/home/comis-does-not-exist-here";
    writeFileSync(
      liveEnv,
      [
        `COMIS_HOME=${missingRemoteHome}`,
        `DATA=${missingRemoteHome}/.comis`,
        `PKG=${missingRemoteHome}/.npm-global/lib/node_modules/comisai`,
        "EMU_DIR=/root/comis-emu",
        "KIT_DIR=/root",
        "EMU_JSON=/tmp/comis-emu.json",
        "EMU_LOG=/root/comis-emu.log",
        "EMU_TMUX_SESSION=emu",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(rigEnv, "", { mode: 0o600 });

    const output = runRigHelper(
      `rig_load_env ${shellQuote(liveEnv)} ${shellQuote(rigEnv)} 2>/dev/null; printf '%s|%s|%s|%s|%s\n' "$EMU_DIR" "$KIT_DIR" "$EMU_JSON" "$EMU_LOG" "$EMU_TMUX_SESSION"`,
      {
        HOME: directory,
        RIG_MODE: "local",
        RIG_ENV: rigEnv,
        DATA: isolatedData,
        REPO: resolve(HERE, "../../../.."),
        SERVICE: "comis-isolated-test",
      },
    );

    expect(output.trim()).toBe(
      [
        resolve(HERE, "../../../.."),
        HERE,
        resolve(isolatedData, "emulator-wiring.json"),
        resolve(isolatedData, "emulator.log"),
        "emu-comis-isolated-test",
      ].join("|"),
    );
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

  it("does not inherit a rendered trajectory path when data is selected explicitly", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-rig-trajectory-precedence-"));
    temporaryDirectories.push(directory);
    const selectedData = resolve(directory, "selected-data");
    const renderedData = resolve(directory, "rendered-data");
    const liveEnv = resolve(directory, "live.env");
    const rigEnv = resolve(directory, "rig.env");
    writeFileSync(liveEnv, "", { mode: 0o600 });
    writeFileSync(
      rigEnv,
      [
        'export RIG_MODE="${RIG_MODE:-local}"',
        `export DATA="\${DATA:-${renderedData}}"`,
        `export COMIS_TRAJECTORY_DIR="\${COMIS_TRAJECTORY_DIR:-${resolve(renderedData, "trajectories")}}"`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const output = runRigHelper(
      `rig_load_env ${shellQuote(liveEnv)} ${shellQuote(rigEnv)}; printf '%s|%s\n' "$DATA" "$COMIS_TRAJECTORY_DIR"`,
      {
        RIG_MODE: "local",
        DATA: selectedData,
      },
    );

    expect(output.trim()).toBe(`${selectedData}|${resolve(selectedData, "trajectories")}`);
  });

  it("refuses the everyday local service before changing its config", () => {
    const directory = makeCanonicalTempDirectory("comis-local-up-isolation-");
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
    const directory = makeCanonicalTempDirectory("comis-local-up-everyday-root-");
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

  it("resolves missing data roots through their nearest existing symlink ancestor", () => {
    const directory = makeCanonicalTempDirectory("comis-local-up-symlink-root-");
    const home = resolve(directory, "home");
    const everyday = resolve(home, ".comis");
    const alias = resolve(directory, "operator-data");
    mkdirSync(everyday, { recursive: true });
    symlinkSync(everyday, alias, "dir");
    const selected = resolve(alias, "fresh-rig");

    const result = spawnSync("bash", [LOCAL_UP], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        RIG_MODE: "local",
        DATA: selected,
        GW_PORT: "4880",
        SERVICE: "comis-local-drive",
        SKIP_BUILD: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("canonical and symlink-free");
    expect(statSync(everyday).isDirectory()).toBe(true);
    expect(() => statSync(resolve(everyday, "fresh-rig"))).toThrow();
  });

  it("refuses a fresh rig nested inside the everyday data tree", () => {
    const directory = makeCanonicalTempDirectory("comis-local-up-everyday-child-");
    const everyday = resolve(directory, ".comis");
    const selected = resolve(everyday, "fresh-rig");
    mkdirSync(everyday, { recursive: true });

    const result = spawnSync("bash", [LOCAL_UP], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        RIG_MODE: "local",
        DATA: selected,
        GW_PORT: "4880",
        SERVICE: "comis-local-drive",
        SKIP_BUILD: "1",
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("operator's everyday");
    expect(() => statSync(selected)).toThrow();
  });

  it("refuses a relative first-run root before creating it", () => {
    const directory = makeCanonicalTempDirectory("comis-local-init-relative-root-");
    const marker = resolve(directory, "guard.txt");
    writeFileSync(marker, "unchanged\n", { mode: 0o600 });

    const result = spawnSync("bash", [INIT_LOCAL_CONFIG], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        RIG_MODE: "local",
        RIG_ENV: resolve(directory, "absent.rig-env"),
        DATA: "relative-rig",
        GW_PORT: "4881",
        SERVICE: "comis-relative-root",
        LOCAL_SUPERVISOR: "direct",
      },
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "DATA must be an absolute path (got 'relative-rig')",
    );
    expect(readFileSync(marker, "utf8")).toBe("unchanged\n");
    expect(existsSync(resolve(directory, "relative-rig"))).toBe(false);
  });

  it("refuses a busy first-run gateway port before creating the data root", async () => {
    const directory = makeCanonicalTempDirectory("comis-local-init-busy-port-");
    const data = resolve(directory, "isolated-data");
    const marker = resolve(directory, "guard.txt");
    writeFileSync(marker, "unchanged\n", { mode: 0o600 });
    const listener = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      listener.once("error", rejectListen);
      listener.listen(0, "127.0.0.1", resolveListen);
    });
    const address = listener.address();
    if (address === null || typeof address === "string") {
      throw new Error("test listener did not bind a TCP port");
    }

    try {
      const result = spawnSync("bash", [INIT_LOCAL_CONFIG], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: directory,
          RIG_MODE: "local",
          RIG_ENV: resolve(directory, "absent.rig-env"),
          DATA: data,
          GW_PORT: String(address.port),
          SERVICE: "comis-busy-port",
          LOCAL_SUPERVISOR: "direct",
          LOCAL_TMUX_SESSION: `comis-busy-port-${process.pid}`,
        },
      });

      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `GW_PORT ${address.port} is already owned by another process`,
      );
      expect(readFileSync(marker, "utf8")).toBe("unchanged\n");
      expect(existsSync(data)).toBe(false);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        listener.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  });

  it("initializes a pinned local config without exposing generated credentials", () => {
    const directory = makeCanonicalTempDirectory("comis-local-config-init-");
    const data = resolve(directory, "isolated-data");
    const configPath = resolve(data, "config.yaml");
    const result = spawnSync("bash", [INIT_LOCAL_CONFIG], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        RIG_MODE: "local",
        DATA: data,
        GW_PORT: "4881",
        SERVICE: "comis-local-drive",
        LOCAL_TMUX_SESSION: `comis-local-drive-${process.pid}`,
      },
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const config = readFileSync(configPath, "utf8");
    const envFile = readFileSync(resolve(data, ".env"), "utf8");
    const masterKey = envFile.match(/^SECRETS_MASTER_KEY=([a-f0-9]{64})$/mu)?.[1];
    const parsedConfig = YAML.parse(config);
    expect(parsedConfig.gateway.tokens[0].secret).toEqual({
      source: "env",
      provider: "comis",
      id: "COMIS_GATEWAY_TOKEN",
    });
    expect(AppConfigSchema.safeParse(parsedConfig).success).toBe(true);
    expect(masterKey).toBeDefined();
    if (masterKey === undefined) {
      throw new Error("initializer omitted generated credentials");
    }
    const stored = offlineSecretGet({
      name: "COMIS_GATEWAY_TOKEN",
      dataDir: data,
      envFilePath: resolve(data, ".env"),
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw stored.error;
    expect(stored.value).toMatch(/^[a-f0-9]{48}$/u);
    expect(config).not.toContain(stored.value);
    expect(result.stdout).not.toContain(stored.value);
    expect(result.stdout).not.toContain(masterKey);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(resolve(data, ".env")).mode & 0o777).toBe(0o600);

    const validated = spawnSync("node", [LOCAL_CONFIG, "validate", configPath, data, "4881"], {
      encoding: "utf8",
      env: NO_RIG_ENV,
    });
    expect(validated.status, `${validated.stdout}${validated.stderr}`).toBe(0);
  });

  it("resolves the selected local gateway secret ahead of a stale helper token", () => {
    const directory = makeCanonicalTempDirectory("comis-local-rpc-secret-");
    const data = resolve(directory, "isolated-data");
    const configPath = resolve(data, "config.yaml");
    const initialized = spawnSync("bash", [INIT_LOCAL_CONFIG], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        RIG_MODE: "local",
        RIG_ENV: resolve(directory, "selected.rig-env"),
        DATA: data,
        GW_PORT: "4883",
        SERVICE: "comis-local-rpc-secret",
        LOCAL_TMUX_SESSION: `comis-local-rpc-secret-${process.pid}`,
      },
    });
    expect(initialized.status, `${initialized.stdout}${initialized.stderr}`).toBe(0);

    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `const { ensureRpcEnv } = await import(${JSON.stringify(pathToFileURL(RIG_NODE_HELPER).href)});`,
          "ensureRpcEnv();",
          "const resolved = process.env.COMIS_GATEWAY_TOKEN ?? '';",
          "console.log(`${resolved === process.env.GWTOKEN ? 'stale' : 'selected'}|${resolved.length}`);",
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RIG_MODE: "local",
          RIG_ENV: resolve(directory, "selected.rig-env"),
          COMIS_DATA_DIR: data,
          COMIS_CONFIG_PATHS: configPath,
          DATA: data,
          GW_PORT: "4883",
          SERVICE: "comis-local-rpc-secret",
          GWTOKEN: "f".repeat(48),
          COMIS_GATEWAY_TOKEN: "",
        },
      },
    );

    expect(probe.status, `${probe.stdout}${probe.stderr}`).toBe(0);
    expect(probe.stdout.trim()).toBe("selected|48");
  });

  it("resolves the selected remote gateway secret ahead of a stale rendered token", () => {
    const directory = makeCanonicalTempDirectory("comis-remote-rpc-secret-");
    const data = resolve(directory, "isolated-data");
    const packageRoot = resolve(directory, "installed-comis");
    const cliPath = resolve(packageRoot, "node_modules/@comis/cli/dist/cli.js");
    mkdirSync(dirname(cliPath), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(
      cliPath,
      [
        "#!/usr/bin/env node",
        'if (process.argv.slice(2).join(" ") !== "secrets get --offline COMIS_GATEWAY_TOKEN") process.exit(2);',
        `process.stdout.write(${JSON.stringify("a".repeat(48))});`,
      ].join("\n"),
    );

    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `const { ensureRpcEnv } = await import(${JSON.stringify(pathToFileURL(RIG_NODE_HELPER).href)});`,
          "ensureRpcEnv();",
          "const resolved = process.env.COMIS_GATEWAY_TOKEN ?? '';",
          "console.log(`${resolved === process.env.GWTOKEN ? 'stale' : 'selected'}|${resolved.length}`);",
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RIG_MODE: "remote",
          RIG_ENV: resolve(directory, "selected.rig-env"),
          COMIS_DATA_DIR: data,
          COMIS_CONFIG_PATHS: resolve(data, "config.yaml"),
          PKG: packageRoot,
          GWTOKEN: "f".repeat(48),
          COMIS_GATEWAY_TOKEN: "",
        },
      },
    );

    expect(probe.status, `${probe.stdout}${probe.stderr}`).toBe(0);
    expect(probe.stdout.trim()).toBe("selected|48");
  });

  it("validates the authoritative config before any local rig mutation", () => {
    const source = readFileSync(LOCAL_UP, "utf8");
    const configGuard = source.indexOf('node "$HERE/local-config.mjs" validate');
    const build = source.indexOf("pnpm build");
    const emulator = source.indexOf('bash "$HERE/restart-emu.sh"');
    const wiring = source.indexOf('node "$HERE/wire-emu.mjs"');

    expect(configGuard).toBeGreaterThan(0);
    expect(configGuard).toBeLessThan(build);
    expect(configGuard).toBeLessThan(emulator);
    expect(configGuard).toBeLessThan(wiring);
    expect(source).toContain("init-local-config.sh");
    expect(source).not.toContain("node $REPO/packages/cli/dist/cli.js init");
    expect(source).not.toContain("node $HERE/init-config.mjs");
    expect(readFileSync(INIT_LOCAL_CONFIG, "utf8")).not.toContain("/root");

    const directory = makeCanonicalTempDirectory("comis-local-config-guard-");
    const configPath = resolve(directory, "config.yaml");
    writeFileSync(
      configPath,
      `dataDir: ${resolve(directory, "wrong-root")}\ngateway:\n  port: 4882\n`,
    );
    const wrongRoot = spawnSync("node", [LOCAL_CONFIG, "validate", configPath, directory, "4882"], {
      encoding: "utf8",
      env: NO_RIG_ENV,
    });
    expect(wrongRoot.status).not.toBe(0);
    expect(`${wrongRoot.stdout}${wrongRoot.stderr}`).toContain("config dataDir must be exactly");

    writeFileSync(configPath, `dataDir: ${directory}\ngateway:\n  port: 4766\n`);
    const wrongPort = spawnSync("node", [LOCAL_CONFIG, "validate", configPath, directory, "4882"], {
      encoding: "utf8",
      env: NO_RIG_ENV,
    });
    expect(wrongPort.status).not.toBe(0);
    expect(`${wrongPort.stdout}${wrongPort.stderr}`).toContain(
      "config gateway.port must be exactly 4882",
    );

    const outsideTrajectory = resolve(directory, "..", "everyday-trajectories");
    writeFileSync(
      configPath,
      [
        `dataDir: ${directory}`,
        "gateway:",
        "  port: 4882",
        "diagnostics:",
        "  trajectory:",
        `    dir: ${outsideTrajectory}`,
        "",
      ].join("\n"),
    );
    const wrongTrajectory = spawnSync(
      "node",
      [LOCAL_CONFIG, "validate", configPath, directory, "4882"],
      { encoding: "utf8", env: NO_RIG_ENV },
    );
    expect(wrongTrajectory.status).not.toBe(0);
    expect(`${wrongTrajectory.stdout}${wrongTrajectory.stderr}`).toContain(
      "diagnostics.trajectory.dir must stay inside the isolated data root",
    );

    writeFileSync(
      configPath,
      [
        `dataDir: ${directory}`,
        "gateway:",
        "  port: 4882",
        "observability:",
        "  trajectory:",
        `    dirOverride: ${outsideTrajectory}`,
        "",
      ].join("\n"),
    );
    const wrongObservabilityTrajectory = spawnSync(
      "node",
      [LOCAL_CONFIG, "validate", configPath, directory, "4882"],
      { encoding: "utf8", env: NO_RIG_ENV },
    );
    expect(wrongObservabilityTrajectory.status).not.toBe(0);
    expect(
      `${wrongObservabilityTrajectory.stdout}${wrongObservabilityTrajectory.stderr}`,
    ).toContain("observability.trajectory.dirOverride must stay inside the isolated data root");
  });

  // `validate` reads a config and persists no secret, so it must not require a
  // built `packages/memory/dist`. Resolving the encrypted-store adapter at MODULE
  // load made every subcommand need one: on a box whose code root falls through
  // to a global `comisai` install that is not there, `validate` aborted reporting
  // a secret-store problem for an operation that touches no secret — and the
  // kit's unit project is contracted to run WITHOUT a `pnpm build`
  // (`vitest.config.ts`), so a load-time dist import reintroduced the stale-dist
  // coupling that contract forbids. Pinned with a code root that deliberately has
  // no dist: the adapter stays a lazy dependency of `init` alone.
  it("validates a config without requiring a built secret-store adapter", () => {
    const directory = makeCanonicalTempDirectory("comis-local-config-nodist-");
    const configPath = resolve(directory, "config.yaml");
    writeFileSync(configPath, `dataDir: ${directory}\ngateway:\n  port: 4882\n`);

    const validated = spawnSync("node", [LOCAL_CONFIG, "validate", configPath, directory, "4882"], {
      encoding: "utf8",
      env: { ...process.env, PKG: "/nonexistent-code-root" },
    });

    const output = `${validated.stdout}${validated.stderr}`;
    expect(validated.status, output).toBe(0);
    expect(output).not.toContain("secret-store adapter");
  });

  it("loads the rendered rig selection in every standalone local gate", () => {
    for (const script of [DEPLOY_EMULATOR, RIG_DOCTOR, VERIFY_BUILD]) {
      const source = readFileSync(script, "utf8");
      expect(source, script).toContain("rig_load_env");
    }
  });

  it("scopes the local Telegram emulator lifecycle to the selected rig", () => {
    const shellRig = readFileSync(RIG_HELPER, "utf8");
    const nodeRig = readFileSync(RIG_NODE_HELPER, "utf8");
    const restart = readFileSync(RESTART_EMULATOR, "utf8");
    const launcher = readFileSync(VPS_EMULATOR, "utf8");

    expect(shellRig).toContain('${EMU_JSON:=$DATA/emulator-wiring.json}');
    expect(shellRig).toContain('${EMU_TMUX_SESSION:=emu-${SERVICE}}');
    expect(nodeRig).toContain('isLocal ? `${dataDir}/emulator-wiring.json` : "/tmp/comis-emu.json"');
    expect(restart).toContain('tmux kill-session -t "=$EMU_TMUX_SESSION"');
    expect(restart).toContain("EMU_JSON='$EMU_JSON'");
    expect(restart).not.toMatch(/^\s*pkill\s+.*vps-emu/mu);
    expect(restart).not.toMatch(/^\s*tmux kill-session -t emu\b/mu);
    expect(launcher).toContain('process.env["EMU_JSON"] ?? "/tmp/comis-emu.json"');
  });

  it("removes stale emulator wiring before launching a replacement process", () => {
    const directory = makeCanonicalTempDirectory("comis-restart-emu-");
    const bin = resolve(directory, "bin");
    const wiring = resolve(directory, "emulator-wiring.json");
    const log = resolve(directory, "emulator.log");
    const capture = resolve(directory, "launch-state");
    mkdirSync(bin);
    writeFileSync(wiring, JSON.stringify({ port: 1, pid: 999_999_999 }));
    writeFileSync(log, "stale\n");
    writeFileSync(
      resolve(bin, "tmux"),
      `#!/usr/bin/env bash
case "\${1:-}" in
  has-session) exit 1 ;;
  new-session)
    if [ -e "$EMU_JSON" ]; then exit 41; fi
    printf 'stale-wiring-absent\\n' > "$EMU_LAUNCH_CAPTURE"
    printf '{"port":49001,"pid":4242}\\n' > "$EMU_JSON"
    printf 'EMU_UP port=49001\\n' > "$EMU_LOG"
    ;;
  set-environment) ;;
esac
`,
      { mode: 0o700 },
    );
    writeFileSync(resolve(bin, "tsx"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    writeFileSync(resolve(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });

    const restarted = spawnSync("bash", [RESTART_EMULATOR], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RIG_MODE: "local",
        DATA: directory,
        REPO: REPO_ROOT,
        EMU_DIR: REPO_ROOT,
        EMU_JSON: wiring,
        EMU_LOG: log,
        EMU_LAUNCH_CAPTURE: capture,
        EMU_MESSAGE_ID_STATE_DIR: resolve(directory, "message-ids"),
        EMU_TMUX_SESSION: "emu-fixture",
        SERVICE: "comis-fixture",
        RIG_ENV: resolve(directory, "absent-rig-env"),
      },
    });

    expect(restarted.status, `${restarted.stdout}${restarted.stderr}`).toBe(0);
    expect(readFileSync(capture, "utf8").trim()).toBe("stale-wiring-absent");
    expect(JSON.parse(readFileSync(wiring, "utf8"))).toEqual({ port: 49001, pid: 4242 });
    expect(restarted.stdout).toContain("EMU UP");
  });

  it("scopes the local phase-zero daemon probe to the selected lifecycle owner", () => {
    const source = readFileSync(PHASE_ZERO_CHECK, "utf8");

    expect(source).toContain('daemon_pid="$(rig_daemon_pid)"');
    expect(source).toContain('pass "daemon-process" "selected daemon process is running (pid $daemon_pid)"');
    expect(source).not.toContain("pid $(pgrep -f 'node.*daemon\\.js' | head -1)");
  });

  it("recognizes a service wrapper that imports the selected daemon distribution", () => {
    const directory = makeCanonicalTempDirectory("comis-rig-wrapper-entry-");
    const packageRoot = resolve(directory, "comisai");
    const daemonDist = resolve(packageRoot, "node_modules/@comis/daemon/dist");
    const wrapper = resolve(directory, "campaign-daemon.mjs");
    const unrelated = resolve(directory, "unrelated-daemon.mjs");
    const kit = resolve(directory, "kit");
    const data = resolve(directory, "data");
    const bin = resolve(directory, "bin");
    const rigEnv = resolve(directory, "rig.env");
    mkdirSync(daemonDist, { recursive: true });
    mkdirSync(kit);
    mkdirSync(data);
    mkdirSync(bin);
    writeFileSync(resolve(daemonDist, "daemon.js"), "export const daemon = true;\n");
    writeFileSync(resolve(daemonDist, "index.js"), "export const main = () => {};\n");
    writeFileSync(
      wrapper,
      `import { main } from ${JSON.stringify(`${daemonDist}/index.js`)};\nvoid main;\n`,
    );
    writeFileSync(unrelated, 'import "./somewhere-else.js";\n');

    const imported = spawnSync(
      "bash",
      [
        "-c",
        [
          `source ${shellQuote(RIG_HELPER)}`,
          `PKG=${shellQuote(packageRoot)}`,
          `rig_entry_uses_daemon_dist ${shellQuote(wrapper)}`,
        ].join("\n"),
      ],
      { encoding: "utf8", env: NO_RIG_ENV },
    );
    const rejected = spawnSync(
      "bash",
      [
        "-c",
        [
          `source ${shellQuote(RIG_HELPER)}`,
          `PKG=${shellQuote(packageRoot)}`,
          `rig_entry_uses_daemon_dist ${shellQuote(unrelated)}`,
        ].join("\n"),
      ],
      { encoding: "utf8", env: NO_RIG_ENV },
    );

    expect(imported.status, imported.stderr).toBe(0);
    expect(rejected.status).not.toBe(0);

    writeFileSync(resolve(kit, "_rig.sh"), readFileSync(RIG_HELPER));
    writeFileSync(resolve(kit, "_rig.mjs"), "export {};\n");
    writeFileSync(resolve(kit, "revoke.mjs"), 'console.log("RESULT:{}");\n');
    writeFileSync(resolve(data, "config.yaml"), "gateway:\n  port: 4766\n");
    writeFileSync(rigEnv, `export GWTOKEN=${"a".repeat(40)}\n`);
    writeFileSync(
      resolve(bin, "ssh"),
      "#!/usr/bin/env bash\nremote=\"${!#}\"\nexec bash -c \"$remote\"\n",
      { mode: 0o700 },
    );
    writeFileSync(
      resolve(bin, "systemctl"),
      `#!/usr/bin/env bash
case "$*" in
  *is-active*) printf 'active\\n' ;;
  *ExecStart*) printf '/usr/bin/node %s\\n' "$DOCTOR_WRAPPER" ;;
  *) printf '4242\\n' ;;
esac
`,
      { mode: 0o700 },
    );
    writeFileSync(
      resolve(bin, "ss"),
      "#!/usr/bin/env bash\nprintf 'LISTEN 0 128 127.0.0.1:4766 0.0.0.0:*\\n'\n",
      { mode: 0o700 },
    );

    const doctor = spawnSync("bash", [RIG_DOCTOR], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RIG_MODE: "remote",
        VPS: "fixture-host",
        REMOTE_SUDO: "0",
        SERVICE: "comis-campaign",
        COMIS_HOME: directory,
        PKG: packageRoot,
        KIT_DIR: kit,
        DATA: data,
        RIG_ENV: rigEnv,
        GWTOKEN: "a".repeat(40),
        GW_PORT: "4766",
        EMU_JSON: resolve(data, "absent-emulator.json"),
        DOCTOR_WRAPPER: wrapper,
      },
    });

    expect(doctor.status, `${doctor.stdout}${doctor.stderr}`).toBe(0);
    expect(doctor.stdout).toContain("service wrapper imports the daemon distribution under $PKG");
  });

  it("returns the selected remote wrapper process instead of a sibling daemon", () => {
    const directory = makeCanonicalTempDirectory("comis-rig-remote-wrapper-pid-");
    const packageRoot = resolve(directory, "comisai");
    const daemonDist = resolve(packageRoot, "node_modules/@comis/daemon/dist");
    const wrapper = resolve(directory, "campaign-daemon.mjs");
    const bin = resolve(directory, "bin");
    mkdirSync(daemonDist, { recursive: true });
    mkdirSync(bin);
    writeFileSync(resolve(daemonDist, "daemon.js"), "export const daemon = true;\n");
    writeFileSync(
      wrapper,
      `import { main } from ${JSON.stringify(`${daemonDist}/index.js`)};\nvoid main;\n`,
    );
    writeFileSync(resolve(bin, "systemctl"), "#!/usr/bin/env bash\nprintf '4242\\n'\n", { mode: 0o700 });
    writeFileSync(
      resolve(bin, "ps"),
      `#!/usr/bin/env bash\nprintf '%s\\n' ${shellQuote(`/usr/bin/node ${wrapper}`)}\n`,
      { mode: 0o700 },
    );
    writeFileSync(resolve(bin, "pgrep"), "#!/usr/bin/env bash\nprintf '9999\\n'\n", { mode: 0o700 });

    const selected = runRigHelper(
      'kill() { return 0; }; printf "%s" "$(rig_daemon_pid)"',
      {
        RIG_MODE: "remote",
        SERVICE: "comis-campaign",
        PKG: packageRoot,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    );

    expect(selected).toBe("4242");

    writeFileSync(wrapper, 'import "./unrelated.js";\n');
    const rejected = runRigHelper(
      'kill() { return 0; }; printf "%s" "$(rig_daemon_pid)"',
      {
        RIG_MODE: "remote",
        SERVICE: "comis-campaign",
        PKG: packageRoot,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
    );

    expect(rejected).toBe("");
  });

  it("parses every deployment record kind by its final timestamp", () => {
    const directory = makeCanonicalTempDirectory("comis-verify-build-");
    const bin = resolve(directory, "bin");
    const record = resolve(directory, "deployed-build");
    const systemctlCapture = resolve(directory, "systemctl-args");
    const dateCapture = resolve(directory, "date-args");
    const localSha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    mkdirSync(bin);
    writeFileSync(
      resolve(bin, "ssh"),
      "#!/usr/bin/env bash\nremote=\"${!#}\"\nexec bash -c \"$remote\"\n",
      { mode: 0o700 },
    );
    writeFileSync(
      resolve(bin, "systemctl"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_CAPTURE\"\nprintf '4242\\n'\n",
      { mode: 0o700 },
    );
    writeFileSync(
      resolve(bin, "ps"),
      "#!/usr/bin/env bash\nprintf 'Mon Jan 1 00:01:00 UTC 2026\\n'\n",
      { mode: 0o700 },
    );
    writeFileSync(
      resolve(bin, "date"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DATE_CAPTURE"
case "$*" in
  *2026-01-01T00:00:00Z*) printf '100\\n' ;;
  *) printf '200\\n' ;;
esac
`,
      { mode: 0o700 },
    );

    for (const kind of ["installed", "deployed", "dist-overlay"]) {
      writeFileSync(record, `${localSha} ${kind} 2026-01-01T00:00:00Z\n`);
      writeFileSync(systemctlCapture, "");
      writeFileSync(dateCapture, "");
      const verified = spawnSync("bash", [VERIFY_BUILD], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          RIG_MODE: "remote",
          VPS: "fixture-host",
          REMOTE_SUDO: "0",
          SERVICE: "selected-service",
          COMIS_HOME: directory,
          REPO: REPO_ROOT,
          RIG_ENV: resolve(directory, "absent-rig-env"),
          COMIS_DEPLOY_RECORD_PATH: record,
          SYSTEMCTL_CAPTURE: systemctlCapture,
          DATE_CAPTURE: dateCapture,
        },
      });

      expect(verified.status, `${kind}: ${verified.stdout}${verified.stderr}`).toBe(0);
      expect(readFileSync(systemctlCapture, "utf8")).toContain("selected-service");
      expect(readFileSync(dateCapture, "utf8")).toContain("2026-01-01T00:00:00Z");
    }
  });

  it("keeps the local rig shell entry points syntactically valid", () => {
    for (const script of [
      RIG_HELPER,
      LOCAL_UP,
      INIT_LOCAL_CONFIG,
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

  it("keeps a selected rig env isolated while rendering credentials", () => {
    const source = readFileSync(DEPLOY_SCRIPTS, "utf8");

    expect(source).toContain(
      'SELECTED_RIG_ENV="${RIG_ENV:-$HERE/.rig-env}"',
    );
    expect(source).toContain(
      'rig_load_env "$HERE/.live-env" "$SELECTED_RIG_ENV"',
    );
    expect(source).not.toContain(
      'rig_load_env "$HERE/.live-env" "$HERE/.rig-env"',
    );
  });

  it("derives the local trajectory root from an explicitly selected data root", () => {
    const source = readFileSync(LOCAL_UP, "utf8");
    const selected = source.indexOf(
      'SELECTED_TRAJECTORY_DIR="${COMIS_TRAJECTORY_DIR:-$SELECTED_DATA/trajectories}"',
    );
    const assigned = source.indexOf(
      'COMIS_TRAJECTORY_DIR="$SELECTED_TRAJECTORY_DIR"',
    );
    const loaded = source.indexOf(
      'rig_load_env "$HERE/.live-env" "$HERE/.rig-env"',
    );

    expect(selected).toBeGreaterThan(-1);
    expect(assigned).toBeGreaterThan(selected);
    expect(loaded).toBeGreaterThan(assigned);
  });

  it("uses exact tmux targets so daemon and emulator name prefixes cannot collide", () => {
    const shellRig = readFileSync(RIG_HELPER, "utf8");
    const restartDaemon = readFileSync(RESTART_DAEMON, "utf8");
    const restartEmulator = readFileSync(RESTART_EMULATOR, "utf8");

    expect(shellRig).toContain('tmux has-session -t "=${LOCAL_TMUX_SESSION:-comis-${SERVICE:-comis}}"');
    expect(shellRig).toContain('tmux show-environment -t "=${LOCAL_TMUX_SESSION:-comis-${SERVICE:-comis}}"');
    expect(shellRig).toContain('tmux list-panes -t "=$_tmux_session"');
    expect(restartDaemon).toContain('tmux kill-session -t "=$tmux_session"');
    expect(restartEmulator).toContain('tmux has-session -t "=$EMU_TMUX_SESSION"');
    expect(restartEmulator).toContain('tmux show-environment -t "=$EMU_TMUX_SESSION"');
    expect(restartEmulator).toContain('tmux kill-session -t "=$EMU_TMUX_SESSION"');
  });

  it("probes bubblewrap on a local Linux phase-zero gate", () => {
    if (process.platform !== "linux") return;
    const directory = makeCanonicalTempDirectory("comis-phase-zero-linux-");
    const result = spawnSync("bash", [PHASE_ZERO_CHECK], {
      encoding: "utf8",
      env: {
        ...process.env,
        RIG_MODE: "local",
        DATA: directory,
        COMIS_DATA_DIR: directory,
        COMIS_CONFIG_PATHS: resolve(directory, "config.yaml"),
        GW_PORT: "48991",
        SERVICE: "comis-phase-zero-test",
        COMIS_USER: process.env["USER"] ?? "user_a",
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(output).toMatch(/PASS.*jail-dep:bwrap/);
    expect(output).not.toContain("NO-ACCESS on the local macOS rig");
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

  it("surfaces the actionable failure ahead of a local daemon crash stack", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "comis-local-boot-diagnostic-"));
    temporaryDirectories.push(directory);
    const consoleLog = resolve(directory, "daemon.console.log");
    writeFileSync(
      consoleLog,
      [
        "FATAL: failure from an earlier launch",
        "structured startup line",
        "FATAL: gateway.tokens[0].secret resolved to 8 characters; provide at least 32",
        ...Array.from({ length: 20 }, (_, index) => `stack frame ${index + 1}`),
      ].join("\n"),
    );

    const output = runRigHelper(
      `rig_actionable_boot_failure ${shellQuote(consoleLog)} 2`,
      { RIG_MODE: "local" },
    );

    expect(output.trim()).toBe(
      "FATAL: gateway.tokens[0].secret resolved to 8 characters; provide at least 32",
    );
    expect(output).not.toContain("earlier launch");
  });

  it("binds local daemon boot and runtime storage to the isolated rig data directory", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");

    expect(restart).toMatch(
      /COMIS_DATA_DIR=['"]?\$DATA['"]?[^]*COMIS_CONFIG_PATHS=['"]?\$DATA\/config\.yaml/u,
    );
  });

  it("rejects inherited trajectory paths outside the isolated data root", () => {
    const directory = makeCanonicalTempDirectory("comis-local-trajectory-outside-");
    const data = resolve(directory, "isolated-data");
    const home = resolve(directory, "operator-home");
    const everydayTrajectory = resolve(home, ".comis", "trajectories");
    mkdirSync(data, { recursive: true });
    mkdirSync(everydayTrajectory, { recursive: true });

    const result = spawnSync("bash", [RESTART_DAEMON], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        RIG_MODE: "local",
        DATA: data,
        COMIS_DATA_DIR: data,
        COMIS_TRAJECTORY_DIR: everydayTrajectory,
        GW_PORT: "4883",
        SERVICE: "comis-local-trajectory",
        LOCAL_SUPERVISOR: "direct",
      },
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "COMIS_TRAJECTORY_DIR must stay inside the isolated DATA root",
    );
    expect(result.stdout).not.toContain("supervisor:");
    expect(result.stdout).not.toContain("no daemon dist found");
  });

  it("accepts canonical trajectory paths inside the isolated data root", () => {
    const directory = makeCanonicalTempDirectory("comis-local-trajectory-inside-");
    const data = resolve(directory, "isolated-data");
    const trajectory = resolve(data, "custom-trajectories");
    mkdirSync(data, { recursive: true });

    const output = runRigHelper('rig_defaults; rig_local_trajectory_dir', {
      HOME: directory,
      RIG_MODE: "local",
      DATA: data,
      COMIS_TRAJECTORY_DIR: trajectory,
      SERVICE: "comis-local-trajectory",
    });

    expect(output).toBe(trajectory);
  });

  it("pins the trajectory path across every local supervisor branch", () => {
    const restart = readFileSync(RESTART_DAEMON, "utf8");
    const guard = restart.indexOf('COMIS_TRAJECTORY_DIR="$(rig_local_trajectory_dir)"');
    const pm2 = restart.indexOf('COMIS_TRAJECTORY_DIR="$COMIS_TRAJECTORY_DIR"');
    const tmux = restart.indexOf("COMIS_TRAJECTORY_DIR='$COMIS_TRAJECTORY_DIR'");
    const directOuter = restart.indexOf('COMIS_LOCAL_TRAJECTORY_DIR="$COMIS_TRAJECTORY_DIR"');
    const directChild = restart.indexOf('COMIS_TRAJECTORY_DIR="$COMIS_LOCAL_TRAJECTORY_DIR"');

    expect(guard).toBeGreaterThan(0);
    expect(pm2).toBeGreaterThan(guard);
    expect(tmux).toBeGreaterThan(guard);
    expect(directOuter).toBeGreaterThan(guard);
    expect(directChild).toBeGreaterThan(directOuter);
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
