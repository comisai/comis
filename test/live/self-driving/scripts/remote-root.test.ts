// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "_remote-root.sh");
const WIRE_EMULATOR = resolve(HERE, "wire-emu.mjs");
const DEPLOY_SCRIPTS = resolve(HERE, "deploy-scripts.sh");
const DEPLOY_EMULATOR = resolve(HERE, "deploy-emu.sh");
const temporaryDirectories: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runRemoteRoot(remoteSudo: "0" | "1", input = ""): string {
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
    `printf %s ${shellQuote(input)} | remote_root ${shellQuote("printf '%s' ready")}`,
  ].join("\n");
  const output = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env["PATH"] ?? ""}`, CAPTURE: capturePath },
  });
  return output;
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
});
