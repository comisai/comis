import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ok } from "@comis/shared";

import { TARGET_REPLAY_QUARANTINE_SHA256 } from "./production-bootstrap.js";
import {
  RUNTIME_FACTS_BEGIN,
  RUNTIME_FACTS_END,
  STRICT_RUNTIME_PARITY_REQUIREMENTS,
  buildRuntimeArtifactAttestationPlan,
  buildRuntimeArtifactProbeScript,
  compareRuntimePackageArtifacts,
  compareRuntimeArtifacts,
  inspectRuntimeArtifactAttestations,
  parseRuntimeArtifactFacts,
} from "./production-runtime.js";
import type { RuntimeArtifactAttestation } from "./production-runtime.js";
import type { ProductionReplayProfile } from "./production-profile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRuntimeFixture(
  daemonEntry = "daemon.js",
  applicationEnvironment = "COMIS_MODE=standard",
): { root: string; packageRoot: string; linkPath: string } {
  const root = mkdtempSync(join(tmpdir(), "comis-runtime-attestation-"));
  roots.push(root);
  const packageRoot = join(root, "custom-prefix", "node_modules", "comisai");
  const daemonPath = join(packageRoot, "node_modules", "@comis", "daemon", "dist", daemonEntry);
  mkdirSync(dirname(daemonPath), { recursive: true });
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"name":"comisai","version":"1.2.3"}\n');
  writeFileSync(daemonPath, "export {};\n");
  writeFileSync(join(packageRoot, "dist", "a.txt"), "same-content\n");
  writeFileSync(join(packageRoot, "dist", "b.txt"), "same-content\n");
  chmodSync(join(packageRoot, "dist", "a.txt"), 0o640);
  const linkPath = join(packageRoot, "current.txt");
  symlinkSync("dist/a.txt", linkPath);

  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  const systemctl = join(fakeBin, "systemctl");
  writeFileSync(
    systemctl,
    [
      "#!/bin/sh",
      `exec_start='{ path=${process.execPath} ; argv[]=${process.execPath} --permission ${daemonPath} ; ignore_errors=no ; }'`,
      'case "$*" in',
      '  *"--property=ExecStart --value"*) printf \'%s\\n\' "$exec_start" ;;',
      `  *) printf 'ExecStart=%s\\nUser=comis\\nEnvironment=%s\\n' "$exec_start" '${applicationEnvironment}' ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(systemctl, 0o755);
  return { root, packageRoot, linkPath };
}

function runProbe(root: string): string {
  const result = spawnSync("bash", ["-s", "--", "comis", "source"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
    input: buildRuntimeArtifactProbeScript(),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function parseFacts(raw: string): RuntimeArtifactAttestation {
  const result = parseRuntimeArtifactFacts(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function validFacts(overrides: Partial<RuntimeArtifactAttestation> = {}): string {
  const facts: RuntimeArtifactAttestation = {
    digestSha256: "a".repeat(64),
    entryCount: 12,
    bytes: 4096,
    packageRoot: "/opt/comis/node_modules/comisai",
    version: "1.2.3",
    osId: "ubuntu",
    osVersion: "24.04",
    architecture: "x86_64",
    kernelRelease: "6.8.0-71-generic",
    libcKind: "glibc",
    libcVersion: "2.39",
    nodeVersion: "22.17.1",
    nodeAbi: "127",
    timezone: "Asia/Jerusalem",
    tzdataSha256: "b".repeat(64),
    launcherKind: "systemd",
    applicationLauncherSha256: "c".repeat(64),
    confinementKind: "source",
    confinementSha256: "none",
    browserStatus: "available",
    browserSha256: "d".repeat(64),
    mediaStatus: "available",
    mediaSha256: "e".repeat(64),
    nativeToolsStatus: "available",
    nativeToolsSha256: "f".repeat(64),
    ...overrides,
  };
  return [
    RUNTIME_FACTS_BEGIN,
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `packageRoot=${facts.packageRoot}`,
    `version=${facts.version}`,
    `osId=${facts.osId}`,
    `osVersion=${facts.osVersion}`,
    `architecture=${facts.architecture}`,
    `kernelRelease=${facts.kernelRelease}`,
    `libcKind=${facts.libcKind}`,
    `libcVersion=${facts.libcVersion}`,
    `nodeVersion=${facts.nodeVersion}`,
    `nodeAbi=${facts.nodeAbi}`,
    `timezone=${facts.timezone}`,
    `tzdataSha256=${facts.tzdataSha256}`,
    `launcherKind=${facts.launcherKind}`,
    `applicationLauncherSha256=${facts.applicationLauncherSha256}`,
    `confinementKind=${facts.confinementKind}`,
    `confinementSha256=${facts.confinementSha256}`,
    `browserStatus=${facts.browserStatus}`,
    `browserSha256=${facts.browserSha256}`,
    `mediaStatus=${facts.mediaStatus}`,
    `mediaSha256=${facts.mediaSha256}`,
    `nativeToolsStatus=${facts.nativeToolsStatus}`,
    `nativeToolsSha256=${facts.nativeToolsSha256}`,
    RUNTIME_FACTS_END,
    "",
  ].join("\n");
}

function asTarget(
  facts: RuntimeArtifactAttestation,
  overrides: Partial<RuntimeArtifactAttestation> = {},
): RuntimeArtifactAttestation {
  return {
    ...facts,
    confinementKind: "target_quarantine",
    confinementSha256: TARGET_REPLAY_QUARANTINE_SHA256,
    ...overrides,
  };
}

describe("production runtime artifact attestation", () => {
  it("builds separate read-only source and target plans with their configured SSH ports", () => {
    const profile: ProductionReplayProfile = {
      source: {
        ssh: "source.example.com",
        sshPort: 2222,
        role: "production",
        comisUser: "comis",
        dataDir: "/home/comis/.comis",
        service: "comis-source",
        expectedMachineIdSha256: "a".repeat(64),
      },
      target: {
        ssh: "target.example.com",
        sshPort: 2202,
        role: "test",
        comisUser: "comis",
        dataDir: "/home/comis/.comis",
        service: "comis-target",
        expectedMachineIdSha256: "b".repeat(64),
      },
    };

    const plan = buildRuntimeArtifactAttestationPlan(profile);

    expect(plan.source).toMatchObject({
      label: "runtime-attest-source",
      host: "source.example.com",
      port: 2222,
      args: ["sudo", "bash", "-s", "--", "comis-source", "source"],
    });
    expect(plan.target).toMatchObject({
      label: "runtime-attest-target",
      host: "target.example.com",
      port: 2202,
      args: ["sudo", "bash", "-s", "--", "comis-target", "target_quarantine"],
    });
    expect(plan.source.stdin).toBe(plan.target.stdin);
    expect(plan.source.stdin).toContain("systemctl show");
    expect(plan.source.stdin).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable)/u);

    const unsupportedPlan = buildRuntimeArtifactAttestationPlan(profile, {
      requirements: {
        ...STRICT_RUNTIME_PARITY_REQUIREMENTS,
        launcher: "declared_unsupported",
      },
      sourceLauncher: {
        kind: "declared_unsupported",
        nodePath: "/opt/node/bin/node",
        packageRoot: "/opt/comis/node_modules/comisai",
      },
      targetLauncher: {
        kind: "declared_unsupported",
        nodePath: "/srv/node/bin/node",
        packageRoot: "/srv/comis/node_modules/comisai",
      },
    });
    expect(unsupportedPlan.source.args).toEqual([
      "sudo",
      "bash",
      "-s",
      "--",
      "comis-source",
      "source",
      "declared_unsupported",
      "/opt/node/bin/node",
      "/opt/comis/node_modules/comisai",
    ]);
  });

  it("resolves the package root from systemd ExecStart and returns content-free facts", () => {
    for (const entry of ["daemon.js", "daemon-entrypoint.js"]) {
      const fixture = makeRuntimeFixture(entry);
      const output = runProbe(fixture.root);
      const facts = parseFacts(output);

      expect(facts).toMatchObject({
        packageRoot: realpathSync(fixture.packageRoot),
        version: "1.2.3",
        digestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules,
        timezone: expect.any(String),
        tzdataSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        launcherKind: "systemd",
        applicationLauncherSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        confinementKind: "source",
        confinementSha256: "none",
      });
      expect(facts.entryCount).toBeGreaterThan(0);
      expect(facts.bytes).toBeGreaterThan(0);
      expect(output).not.toContain("a.txt");
      expect(output).not.toContain("same-content");
    }
  });

  it("hashes regular file content, relative paths, modes, and symlink targets deterministically", () => {
    const fixture = makeRuntimeFixture();
    const first = parseFacts(runProbe(fixture.root));
    const repeated = parseFacts(runProbe(fixture.root));
    expect(repeated).toEqual(first);

    writeFileSync(join(fixture.packageRoot, "dist", "a.txt"), "next-content\n");
    const contentChanged = parseFacts(runProbe(fixture.root));
    expect(contentChanged.digestSha256).not.toBe(first.digestSha256);
    expect(contentChanged.entryCount).toBe(first.entryCount);
    expect(contentChanged.bytes).toBe(first.bytes);

    writeFileSync(join(fixture.packageRoot, "dist", "a.txt"), "same-content\n");
    chmodSync(join(fixture.packageRoot, "dist", "a.txt"), 0o600);
    const modeChanged = parseFacts(runProbe(fixture.root));
    expect(modeChanged.digestSha256).not.toBe(first.digestSha256);

    chmodSync(join(fixture.packageRoot, "dist", "a.txt"), 0o640);
    unlinkSync(fixture.linkPath);
    symlinkSync("dist/b.txt", fixture.linkPath);
    const linkChanged = parseFacts(runProbe(fixture.root));
    expect(linkChanged.digestSha256).not.toBe(first.digestSha256);
    expect(linkChanged.entryCount).toBe(first.entryCount);
    expect(linkChanged.bytes).toBe(first.bytes);

    unlinkSync(fixture.linkPath);
    symlinkSync("dist/a.txt", fixture.linkPath);
    renameSync(
      join(fixture.packageRoot, "dist", "b.txt"),
      join(fixture.packageRoot, "dist", "c.txt"),
    );
    const pathChanged = parseFacts(runProbe(fixture.root));
    expect(pathChanged.digestSha256).not.toBe(first.digestSha256);
    expect(pathChanged.entryCount).toBe(first.entryCount);
    expect(pathChanged.bytes).toBe(first.bytes);
  });

  it("does not ignore replay markers or other application environment on the source", () => {
    const source = parseFacts(runProbe(makeRuntimeFixture("daemon-entrypoint.js").root));
    const confined = parseFacts(
      runProbe(
        makeRuntimeFixture(
          "daemon-entrypoint.js",
          "COMIS_MODE=standard COMIS_REPLAY_TARGET=1 COMIS_REPLAY_RUNTIME_DIR=/run/comis-replay",
        ).root,
      ),
    );
    const changedApplication = parseFacts(
      runProbe(makeRuntimeFixture("daemon-entrypoint.js", "COMIS_MODE=different").root),
    );

    expect(confined.applicationLauncherSha256).not.toBe(source.applicationLauncherSha256);
    expect(changedApplication.applicationLauncherSha256).not.toBe(
      source.applicationLauncherSha256,
    );
  });

  it("keeps the generated package probe read-only and independent of install paths", () => {
    const script = buildRuntimeArtifactProbeScript();

    expect(script).toContain("systemctl show");
    expect(script).toContain("ExecStart");
    expect(script).toContain("DropInPaths");
    expect(script).toContain("target_quarantine");
    expect(script).toContain("application_launcher_facts");
    expect(script).toContain("90-comis-replay-quarantine.conf");
    expect(script).toContain("stat -c '%u:%g:%a'");
    expect(script).toContain("require_effective_property RestrictAddressFamilies AF_UNIX");
    expect(script).toContain("require_effective_property SocketBindDeny any");
    expect(script).toContain('require_effective_property CapabilityBoundingSet ""');
    expect(script).toContain('require_effective_property ReadWritePaths /run/comis-replay');
    expect(script).toContain("process.versions.modules");
    expect(script).toContain("/etc/localtime");
    expect(script).toContain("ffmpeg");
    expect(script).toContain("chromium");
    expect(script).toContain("head -c 4096");
    expect(script).toContain("timeout 5");
    expect(script).not.toContain("/home/comis");
    expect(script).not.toContain("/usr/lib/node_modules/comisai");
    expect(script).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable)/u);
    expect(script).not.toMatch(/(?:^|\s)(?:rm|mv|cp|chmod|chown|tee|install)(?:\s|$)/mu);
    expect(script).not.toContain("Environment=");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  it("rejects unbounded, incomplete, duplicate, unknown, and malformed facts", () => {
    expect(parseRuntimeArtifactFacts("x".repeat(4097)).ok).toBe(false);
    expect(parseRuntimeArtifactFacts(validFacts().replace("version=1.2.3\n", "")).ok).toBe(false);
    expect(
      parseRuntimeArtifactFacts(validFacts().replace("version=1.2.3", "version=1.2.3\nversion=1.2.3"))
        .ok,
    ).toBe(false);
    expect(
      parseRuntimeArtifactFacts(validFacts().replace(RUNTIME_FACTS_END, `payload=hidden\n${RUNTIME_FACTS_END}`))
        .ok,
    ).toBe(false);
    expect(parseRuntimeArtifactFacts(validFacts({ digestSha256: "A".repeat(64) })).ok).toBe(false);
    expect(parseRuntimeArtifactFacts(validFacts({ packageRoot: "relative/path" })).ok).toBe(false);
    expect(
      parseRuntimeArtifactFacts(
        validFacts({ browserStatus: "unavailable", browserSha256: "d".repeat(64) }),
      ).ok,
    ).toBe(false);
    expect(parseRuntimeArtifactFacts(`banner\n${validFacts()}`).ok).toBe(false);
  });

  it("fails comparison on every runtime identity mismatch", () => {
    const source = parseFacts(validFacts());
    const target = asTarget(source);
    expect(compareRuntimeArtifacts(source, target)).toEqual({ ok: true, value: undefined });
    expect(
      compareRuntimeArtifacts(source, asTarget(source, {
        packageRoot: "/different/node_modules/comisai",
      })),
    ).toEqual({ ok: true, value: undefined });

    for (const [field, divergentTarget] of [
      ["digestSha256", { ...target, digestSha256: "b".repeat(64) }],
      ["entryCount", { ...target, entryCount: source.entryCount + 1 }],
      ["bytes", { ...target, bytes: source.bytes + 1 }],
      ["version", { ...target, version: "1.2.4" }],
      ["osId", { ...target, osId: "debian" }],
      ["osVersion", { ...target, osVersion: "12" }],
      ["architecture", { ...target, architecture: "aarch64" }],
      ["kernelRelease", { ...target, kernelRelease: "6.8.0-72-generic" }],
      ["libcKind", { ...target, libcKind: "musl" as const }],
      ["libcVersion", { ...target, libcVersion: "1.2.5" }],
      ["nodeVersion", { ...target, nodeVersion: "22.18.0" }],
      ["nodeAbi", { ...target, nodeAbi: "128" }],
      ["timezone", { ...target, timezone: "Etc/UTC" }],
      ["tzdataSha256", { ...target, tzdataSha256: "1".repeat(64) }],
      [
        "applicationLauncherSha256",
        { ...target, applicationLauncherSha256: "2".repeat(64) },
      ],
      ["browserSha256", { ...target, browserSha256: "3".repeat(64) }],
      ["mediaSha256", { ...target, mediaSha256: "4".repeat(64) }],
      ["nativeToolsSha256", { ...target, nativeToolsSha256: "5".repeat(64) }],
    ] as const) {
      const result = compareRuntimeArtifacts(source, divergentTarget);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("runtime_mismatch");
        expect(result.error.field).toBe(field);
      }
    }
  });

  it("keeps package clone integrity separate from host semantic fidelity", () => {
    const source = parseFacts(validFacts());
    const semanticallyDifferent = {
      ...source,
      nodeAbi: "128",
      libcVersion: "2.40",
      timezone: "Etc/UTC",
      applicationLauncherSha256: "1".repeat(64),
    };

    expect(compareRuntimePackageArtifacts(source, semanticallyDifferent)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(compareRuntimeArtifacts(source, asTarget(semanticallyDifferent)).ok).toBe(false);

    const packageDifferent = { ...semanticallyDifferent, digestSha256: "9".repeat(64) };
    const packageResult = compareRuntimePackageArtifacts(source, packageDifferent);
    expect(packageResult.ok).toBe(false);
    if (!packageResult.ok) expect(packageResult.error.field).toBe("digestSha256");
  });

  it("requires canonical target confinement without comparing it to the source launcher", () => {
    const source = parseFacts(validFacts());
    const confinedTarget = asTarget(source);

    expect(compareRuntimeArtifacts(source, confinedTarget)).toEqual({
      ok: true,
      value: undefined,
    });

    const missing = compareRuntimeArtifacts(source, source);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.field).toBe("confinementKind");

    const tampered = compareRuntimeArtifacts(source, {
      ...confinedTarget,
      confinementSha256: "9".repeat(64),
    });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error.field).toBe("confinementSha256");
  });

  it("does not call unavailable required capabilities exact and honors explicit unsupported scope", () => {
    const source = parseFacts(validFacts());
    const unavailableBrowser = {
      ...source,
      browserStatus: "unavailable" as const,
      browserSha256: "none" as const,
    };
    const strict = compareRuntimeArtifacts(unavailableBrowser, asTarget(unavailableBrowser));
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error.field).toBe("browserStatus");

    const scoped = compareRuntimeArtifacts(unavailableBrowser, asTarget(unavailableBrowser), {
      ...STRICT_RUNTIME_PARITY_REQUIREMENTS,
      browser: "declared_unsupported",
    });
    expect(scoped).toEqual({ ok: true, value: undefined });

    const unsupportedLauncher = {
      ...source,
      launcherKind: "unsupported" as const,
      applicationLauncherSha256: "none" as const,
    };
    expect(
      compareRuntimeArtifacts(unsupportedLauncher, asTarget(unsupportedLauncher), {
        ...STRICT_RUNTIME_PARITY_REQUIREMENTS,
        launcher: "declared_unsupported",
      }),
    ).toEqual({ ok: true, value: undefined });

    const unverifiedTimezone = { ...source, tzdataSha256: "none" };
    const timezoneResult = compareRuntimeArtifacts(unverifiedTimezone, asTarget(unverifiedTimezone));
    expect(timezoneResult.ok).toBe(false);
    if (!timezoneResult.ok) expect(timezoneResult.error.field).toBe("tzdataSha256");

    const unverifiedBrowser = { ...source, browserSha256: "none" };
    const browserResult = compareRuntimeArtifacts(unverifiedBrowser, asTarget(unverifiedBrowser));
    expect(browserResult.ok).toBe(false);
    if (!browserResult.ok) expect(browserResult.error.field).toBe("browserSha256");
  });

  it("returns both read-only attestations before enforcing artifact equality", async () => {
    const sourceFacts = validFacts({ digestSha256: "a".repeat(64) });
    const targetFacts = validFacts({
      digestSha256: "b".repeat(64),
      confinementKind: "target_quarantine",
      confinementSha256: TARGET_REPLAY_QUARANTINE_SHA256,
    });
    const planProfile: ProductionReplayProfile = {
      source: {
        ssh: "source.example.com",
        role: "production",
        comisUser: "comis",
        dataDir: "/home/comis/.comis",
        service: "comis",
        expectedMachineIdSha256: "a".repeat(64),
      },
      target: {
        ssh: "target.example.com",
        role: "test",
        comisUser: "comis",
        dataDir: "/home/comis/.comis",
        service: "comis",
        expectedMachineIdSha256: "b".repeat(64),
      },
    };

    const result = await inspectRuntimeArtifactAttestations(planProfile, {
      run: async (invocation) =>
        ok({
          stdout: invocation.label === "runtime-attest-source" ? sourceFacts : targetFacts,
          exitCode: 0,
        }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.digestSha256).toBe("a".repeat(64));
    expect(result.value.target.digestSha256).toBe("b".repeat(64));
  });
});
