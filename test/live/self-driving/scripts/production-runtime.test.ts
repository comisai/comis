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

import {
  RUNTIME_FACTS_BEGIN,
  RUNTIME_FACTS_END,
  buildRuntimeArtifactAttestationPlan,
  buildRuntimeArtifactProbeScript,
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
      `printf '%s\\n' '{ path=${process.execPath} ; argv[]=${process.execPath} --permission ${daemonPath} ; ignore_errors=no ; }'`,
      "",
    ].join("\n"),
  );
  chmodSync(systemctl, 0o755);
  return { root, packageRoot, linkPath };
}

function runProbe(root: string): string {
  const result = spawnSync("bash", ["-s", "--", "comis"], {
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
    ...overrides,
  };
  return [
    RUNTIME_FACTS_BEGIN,
    `digestSha256=${facts.digestSha256}`,
    `entryCount=${facts.entryCount}`,
    `bytes=${facts.bytes}`,
    `packageRoot=${facts.packageRoot}`,
    `version=${facts.version}`,
    RUNTIME_FACTS_END,
    "",
  ].join("\n");
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
      args: ["sudo", "bash", "-s", "--", "comis-source"],
    });
    expect(plan.target).toMatchObject({
      label: "runtime-attest-target",
      host: "target.example.com",
      port: 2202,
      args: ["sudo", "bash", "-s", "--", "comis-target"],
    });
    expect(plan.source.stdin).toBe(plan.target.stdin);
    expect(plan.source.stdin).toContain("systemctl show");
    expect(plan.source.stdin).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable)/u);
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

  it("keeps the generated package probe read-only and independent of install paths", () => {
    const script = buildRuntimeArtifactProbeScript();

    expect(script).toContain("systemctl show");
    expect(script).toContain("ExecStart");
    expect(script).not.toContain("/home/comis");
    expect(script).not.toContain("/usr/lib/node_modules/comisai");
    expect(script).not.toMatch(/systemctl\s+(?:start|stop|restart|enable|disable)/u);
    expect(script).not.toMatch(/(?:^|\s)(?:rm|mv|cp|chmod|chown|tee|install)(?:\s|$)/mu);
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
    expect(parseRuntimeArtifactFacts(`banner\n${validFacts()}`).ok).toBe(false);
  });

  it("fails comparison on every runtime identity mismatch", () => {
    const source = parseFacts(validFacts());
    expect(compareRuntimeArtifacts(source, source)).toEqual({ ok: true, value: undefined });
    expect(
      compareRuntimeArtifacts(source, {
        ...source,
        packageRoot: "/different/node_modules/comisai",
      }),
    ).toEqual({ ok: true, value: undefined });

    for (const target of [
      { ...source, digestSha256: "b".repeat(64) },
      { ...source, entryCount: source.entryCount + 1 },
      { ...source, bytes: source.bytes + 1 },
      { ...source, version: "1.2.4" },
    ]) {
      const result = compareRuntimeArtifacts(source, target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("runtime_mismatch");
    }
  });

  it("returns both read-only attestations before enforcing artifact equality", async () => {
    const sourceFacts = validFacts({ digestSha256: "a".repeat(64) });
    const targetFacts = validFacts({ digestSha256: "b".repeat(64) });
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
