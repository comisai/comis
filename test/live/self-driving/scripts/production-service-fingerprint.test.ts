import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";

import type { ProductionRemoteExecutor } from "./production-bootstrap.js";
import {
  PRODUCTION_SERVICE_FINGERPRINT_BEGIN,
  PRODUCTION_SERVICE_FINGERPRINT_END,
  buildProductionServiceFingerprintInvocation,
  compareProductionServiceFingerprints,
  computeProductionServiceRecoveryDigest,
  executeProductionServiceFingerprint,
  parseProductionServiceFingerprint,
  type ProductionServiceFingerprint,
} from "./production-service-fingerprint.js";

const MACHINE = "a".repeat(64);
const BOOT = "b".repeat(64);
const UNIT = createHash("sha256").update("comis.service", "utf8").digest("hex");
const PROPERTIES = "d".repeat(64);
const DEFINITION = "e".repeat(64);
const FINGERPRINT_FIELDS = [MACHINE, BOOT, UNIT, PROPERTIES, DEFINITION] as const;

function combinedFingerprint(
  fields: readonly string[],
  role: ProductionServiceFingerprint["role"] = "source",
): string {
  const hash = createHash("sha256");
  hash.update("comis-production-service-fingerprint-v1\0", "utf8");
  hash.update(`${role}\0`, "utf8");
  for (const field of fields) hash.update(`${field}\0`, "utf8");
  return hash.digest("hex");
}

function makeFingerprint(
  overrides: Partial<ProductionServiceFingerprint> = {},
): ProductionServiceFingerprint {
  const facts: ProductionServiceFingerprint = {
    schema: "comis-production-service-fingerprint",
    schemaVersion: 1,
    role: "source",
    machineIdSha256: MACHINE,
    bootIdSha256: BOOT,
    unitSha256: UNIT,
    propertySnapshotSha256: PROPERTIES,
    executionDefinitionSha256: DEFINITION,
    fingerprintSha256: combinedFingerprint(FINGERPRINT_FIELDS),
    loadState: "loaded",
    activeState: "inactive",
    subState: "dead",
    mainPid: 0,
    controlPid: 0,
    execMainPid: 0,
    stabilityMethod: "bounded_double_scan",
    stable: true,
    ...overrides,
  };
  if (overrides.fingerprintSha256 !== undefined) return facts;
  return {
    ...facts,
    fingerprintSha256: combinedFingerprint(
      [
        facts.machineIdSha256,
        facts.bootIdSha256,
        facts.unitSha256,
        facts.propertySnapshotSha256,
        facts.executionDefinitionSha256,
      ],
      facts.role,
    ),
  };
}

function envelope(
  overrides: Partial<ProductionServiceFingerprint> = {},
): string {
  const value = makeFingerprint(overrides);
  return `${PRODUCTION_SERVICE_FINGERPRINT_BEGIN}\n${JSON.stringify(value, Object.keys(value).sort())}\n${PRODUCTION_SERVICE_FINGERPRINT_END}\n`;
}

describe("production service execution fingerprint", () => {
  it("builds a bounded content-free source systemd fingerprint invocation", () => {
    const result = buildProductionServiceFingerprintInvocation({
      host: "source.example",
      port: 2222,
      role: "source",
      expectedMachineIdSha256: MACHINE,
      service: "comis@tenant.service",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      label: "fingerprint-source-service",
      host: "source.example",
      port: 2222,
      args: [
        "/usr/bin/sudo",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/bin:/bin",
        "LC_ALL=C",
        "TZ=Etc/UTC",
        "/usr/bin/python3",
        "-I",
        "-S",
        "-B",
        "-",
        MACHINE,
        "comis@tenant.service",
        "source",
      ],
      stdoutLimitBytes: 2048,
      timeoutMs: 30_000,
    });

    const script = result.value.stdin;
    expect(script).toContain("/etc/machine-id");
    expect(script).toContain("/proc/sys/kernel/random/boot_id");
    expect(script).toContain('"LoadState"');
    expect(script).toContain('"ActiveState"');
    expect(script).toContain('"SubState"');
    expect(script).toContain('"MainPID"');
    expect(script).toContain('"ControlPID"');
    expect(script).toContain('"ExecMainPID"');
    expect(script).toContain('"StateChangeTimestampMonotonic"');
    expect(script).toContain('"UnitFileState"');
    expect(script).toContain('"NeedDaemonReload"');
    expect(script).toContain('"InvocationID"');
    expect(script).toContain('"NRestarts"');
    expect(script).toContain('"Result"');
    expect(script).toContain('"ExecMainStartTimestampMonotonic"');
    expect(script).toContain('"ExecMainExitTimestampMonotonic"');
    expect(script).toContain('"EnvironmentFiles"');
    expect(script).toContain('"FragmentPath"');
    expect(script).toContain('"DropInPaths"');
    expect(script).toContain("O_NOATIME");
    expect(script).toContain("collect_execution_definition");
    expect(script.match(/collect_execution_definition/g)?.length).toBeGreaterThanOrEqual(4);
    expect(script).toContain('properties["NeedDaemonReload"] != "no"');
    expect(script).toContain("MAX_PROPERTY_BYTES");
    expect(script).toContain("MAX_UNIT_DEFINITION_BYTES");
    expect(script).toContain("MAX_ENVIRONMENT_BYTES");
    expect(script).toContain('["systemctl", "show", "--all", "--no-pager", unit]');
    expect(script).toContain('raw_path.startswith("-/")');
    expect(script).not.toContain("shell=True");
    expect(script).not.toContain("systemctl start");
    expect(script).not.toContain("systemctl stop");
    expect(script).not.toContain("print(snapshot");
    expect(script).not.toContain("print(definition");
    expect(
      spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<probe>', 'exec')"], {
        input: script,
      }).status,
    ).toBe(0);
  });

  it("rejects unsafe hosts ports identities and systemd unit names", () => {
    const base = {
      host: "source.example",
      role: "source" as const,
      expectedMachineIdSha256: MACHINE,
      service: "comis",
    };

    expect(buildProductionServiceFingerprintInvocation({ ...base, host: "bad host" }).ok).toBe(false);
    expect(buildProductionServiceFingerprintInvocation({ ...base, port: 0 }).ok).toBe(false);
    expect(
      buildProductionServiceFingerprintInvocation({
        ...base,
        expectedMachineIdSha256: [MACHINE] as unknown as string,
      }).ok,
    ).toBe(false);
    expect(
      buildProductionServiceFingerprintInvocation({
        ...base,
        service: ["comis"] as unknown as string,
      }).ok,
    ).toBe(false);
    expect(
      buildProductionServiceFingerprintInvocation({
        ...base,
        expectedMachineIdSha256: "not-a-digest",
      }).ok,
    ).toBe(false);
    expect(
      buildProductionServiceFingerprintInvocation({ ...base, service: "comis;reboot" }).ok,
    ).toBe(false);
    expect(
      buildProductionServiceFingerprintInvocation({ ...base, service: "comis.socket" }).ok,
    ).toBe(false);
  });

  it("parses only the exact bounded inactive fingerprint envelope", () => {
    const result = parseProductionServiceFingerprint(envelope());

    expect(result).toEqual({ ok: true, value: makeFingerprint() });
    expect(parseProductionServiceFingerprint(envelope({ activeState: "active" as "inactive" })).ok).toBe(
      false,
    );
    expect(parseProductionServiceFingerprint(envelope({ mainPid: 42 as 0 })).ok).toBe(false);
    expect(parseProductionServiceFingerprint(envelope({ stable: false as true })).ok).toBe(false);
    expect(parseProductionServiceFingerprint(envelope({ bootIdSha256: "x" })).ok).toBe(false);
    expect(
      parseProductionServiceFingerprint(envelope({ fingerprintSha256: "f".repeat(64) })).ok,
    ).toBe(false);
    expect(parseProductionServiceFingerprint(envelope().replace("\n", "\r\n")).ok).toBe(false);
    expect(parseProductionServiceFingerprint(`${envelope()}unexpected\n`).ok).toBe(false);
    expect(parseProductionServiceFingerprint(envelope().slice(0, -1)).ok).toBe(false);
    expect(parseProductionServiceFingerprint("x".repeat(2049)).ok).toBe(false);

    const withExtra = JSON.parse(JSON.stringify(makeFingerprint())) as Record<string, unknown>;
    withExtra.secret = "must-not-pass";
    expect(
      parseProductionServiceFingerprint(
        `${PRODUCTION_SERVICE_FINGERPRINT_BEGIN}\n${JSON.stringify(withExtra)}\n${PRODUCTION_SERVICE_FINGERPRINT_END}\n`,
      ).ok,
    ).toBe(false);

    const canonical = envelope();
    expect(
      parseProductionServiceFingerprint(
        canonical.replace('"activeState":"inactive"', '"activeState":"inactive","activeState":"inactive"'),
      ).ok,
    ).toBe(false);
  });

  it("preserves remote exit and transport evidence without returning remote output", async () => {
    const exitExecutor: ProductionRemoteExecutor = {
      run: vi.fn(async () => ok({ stdout: "private remote output", exitCode: 73 })),
    };
    const exitResult = await executeProductionServiceFingerprint(
      {
        host: "source.example",
        role: "source",
        expectedMachineIdSha256: MACHINE,
        service: "comis",
      },
      exitExecutor,
    );

    expect(exitResult).toEqual({
      ok: false,
      error: {
        kind: "remote_failure",
        stage: "fingerprint-source-service",
        message: "Service fingerprint probe failed",
        outcome: { kind: "remote_exit", exitCode: 73 },
      },
    });
    expect(JSON.stringify(exitResult)).not.toContain("private remote output");

    const transportExecutor: ProductionRemoteExecutor = {
      run: vi.fn(async () =>
        err({ kind: "remote" as const, message: "private transport detail" }),
      ),
    };
    const transportResult = await executeProductionServiceFingerprint(
      {
        host: "source.example",
        role: "source",
        expectedMachineIdSha256: MACHINE,
        service: "comis",
      },
      transportExecutor,
    );
    expect(transportResult).toMatchObject({
      ok: false,
      error: { outcome: { kind: "transport_failure" } },
    });
    expect(JSON.stringify(transportResult)).not.toContain("private transport detail");
  });

  it("executes and validates the strict remote fingerprint envelope", async () => {
    const executor: ProductionRemoteExecutor = {
      run: vi.fn(async () => ok({ stdout: envelope(), exitCode: 0 })),
    };
    const result = await executeProductionServiceFingerprint(
      {
        host: "source.example",
        role: "source",
        expectedMachineIdSha256: MACHINE,
        service: "comis",
      },
      executor,
    );

    expect(result).toEqual({ ok: true, value: makeFingerprint() });
  });

  it("rejects valid envelopes that are not bound to the requested machine or unit", async () => {
    const wrongMachine = makeFingerprint({ machineIdSha256: "9".repeat(64) });
    const machineExecutor: ProductionRemoteExecutor = {
      run: vi.fn(async () => ok({ stdout: envelope(wrongMachine), exitCode: 0 })),
    };
    const machineResult = await executeProductionServiceFingerprint(
      {
        host: "source.example",
        role: "source",
        expectedMachineIdSha256: MACHINE,
        service: "comis",
      },
      machineExecutor,
    );
    expect(machineResult).toMatchObject({
      ok: false,
      error: { kind: "binding_mismatch", field: "machineIdSha256" },
    });

    const wrongUnit = makeFingerprint({ unitSha256: "8".repeat(64) });
    const unitExecutor: ProductionRemoteExecutor = {
      run: vi.fn(async () => ok({ stdout: envelope(wrongUnit), exitCode: 0 })),
    };
    const unitResult = await executeProductionServiceFingerprint(
      {
        host: "source.example",
        role: "source",
        expectedMachineIdSha256: MACHINE,
        service: "comis",
      },
      unitExecutor,
    );
    expect(unitResult).toMatchObject({
      ok: false,
      error: { kind: "binding_mismatch", field: "unitSha256" },
    });
  });

  it("compares every bound execution field and names the first mismatch", () => {
    const exact = compareProductionServiceFingerprints(makeFingerprint(), makeFingerprint());
    expect(exact).toEqual({
      ok: true,
      value: {
        exact: true,
        machineIdSha256: MACHINE,
        bootIdSha256: BOOT,
        fingerprintSha256: combinedFingerprint(FINGERPRINT_FIELDS),
      },
    });

    const transitioned = compareProductionServiceFingerprints(
      makeFingerprint(),
      makeFingerprint({ propertySnapshotSha256: "1".repeat(64) }),
    );
    expect(transitioned).toMatchObject({
      ok: false,
      error: { kind: "fingerprint_mismatch", field: "propertySnapshotSha256" },
    });

    const restarted = compareProductionServiceFingerprints(
      makeFingerprint(),
      makeFingerprint({ bootIdSha256: "2".repeat(64) }),
    );
    expect(restarted).toMatchObject({
      ok: false,
      error: { kind: "fingerprint_mismatch", field: "bootIdSha256" },
    });
  });

  it("derives a reboot-stable recovery identity from immutable service definition", () => {
    const baseline = computeProductionServiceRecoveryDigest(makeFingerprint());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(
      computeProductionServiceRecoveryDigest(
        makeFingerprint({
          bootIdSha256: "2".repeat(64),
          propertySnapshotSha256: "3".repeat(64),
        }),
      ),
    ).toEqual({ ok: true, value: baseline.value });
    expect(
      computeProductionServiceRecoveryDigest(
        makeFingerprint({ executionDefinitionSha256: "4".repeat(64) }),
      ),
    ).not.toEqual({ ok: true, value: baseline.value });
    expect(
      computeProductionServiceRecoveryDigest(makeFingerprint({ role: "target" })),
    ).not.toEqual({ ok: true, value: baseline.value });
  });

  it("binds target service samples to a distinct invocation and digest role", () => {
    const target = buildProductionServiceFingerprintInvocation({
      host: "target.example",
      role: "target",
      expectedMachineIdSha256: MACHINE,
      service: "comis",
    });

    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.value.label).toBe("fingerprint-target-service");
    expect(target.value.args.at(-1)).toBe("target");
    expect(makeFingerprint({ role: "target" }).fingerprintSha256).not.toBe(
      makeFingerprint().fingerprintSha256,
    );
  });
});
