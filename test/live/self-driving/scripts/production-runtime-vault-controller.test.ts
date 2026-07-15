import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";

import type { ProductionReplayProfile } from "./production-profile.js";
import type { ProductionRemoteLeaseClient } from "./production-remote-lease.js";
import type { ProductionRuntimeVaultRecoveryReceipt } from "./production-runtime-vault-authority.js";
import {
  createProductionRuntimeVaultController,
  createProductionRuntimeVaultControllerForTests,
  type ProductionRuntimeVaultControllerDependencies,
} from "./production-runtime-vault-controller.js";
import type {
  ProductionRuntimeVaultReceiptStore,
  ProductionRuntimeVaultReceiptStoreError,
} from "./production-runtime-vault-receipt-store.js";
import type {
  ProductionRuntimeVaultRecoveryReport,
  ProductionRuntimeVaultReport,
  RecoverProductionRuntimeVaultRequest,
  SealProductionRuntimeRequest,
} from "./production-runtime-vault.js";

const ATTEMPT_ID = "1".repeat(32);
const CREATED_AT_MS = 1_752_560_000_321;

function profile(): ProductionReplayProfile {
  return {
    source: {
      ssh: "source-host",
      role: "production",
      comisUser: "comis",
      dataDir: "/home/comis/.comis",
      service: "comis",
      expectedMachineIdSha256: "a".repeat(64),
    },
    target: {
      ssh: "target-host",
      role: "test",
      comisUser: "comis-test",
      dataDir: "/home/comis-test/.comis",
      service: "comis-test",
      expectedMachineIdSha256: "b".repeat(64),
    },
  };
}

function sealReport(): ProductionRuntimeVaultReport {
  return {
    disposition: "published",
    bytesTransferred: 42,
    payload: {
      digestSha256: "c".repeat(64),
      entryCount: 2,
      bytes: 42,
      version: "1.0.0",
    },
    payloadPath: `/opt/comis-replay/runtimes/sha256/${"c".repeat(64)}/payload`,
    recoveryAuthorityDigestSha256: "d".repeat(64),
    recoveryAuthorityKeyIdSha256: "e".repeat(64),
    compatibility: {
      compatible: true,
      schema: "comis-runtime-vault-toolchain-contract",
      schemaVersion: 1,
      schemaDigestSha256: "1".repeat(64),
      probeProgramSha256: "2".repeat(64),
      environmentSha256: "3".repeat(64),
      executionContractSha256: "4".repeat(64),
      featureDigestSha256: "5".repeat(64),
      sourceMachineIdSha256: "a".repeat(64),
      targetMachineIdSha256: "b".repeat(64),
      sourceToolchainDigestSha256: "6".repeat(64),
      targetToolchainDigestSha256: "7".repeat(64),
      sourceToolchainRecoveryDigestSha256: "8".repeat(64),
      targetToolchainRecoveryDigestSha256: "9".repeat(64),
    },
    sourceConsistency: { method: "bounded_multi_scan", atomicSnapshot: false },
    targetInstallationPreserved: true,
    normalServiceTouched: false,
  };
}

function recoveryReport(): ProductionRuntimeVaultRecoveryReport {
  const sealed = sealReport();
  return {
    disposition: "published",
    payload: sealed.payload,
    payloadPath: sealed.payloadPath,
    recoveryAuthorityDigestSha256: sealed.recoveryAuthorityDigestSha256,
    recoveryAuthorityKeyIdSha256: sealed.recoveryAuthorityKeyIdSha256,
    sourceConsistency: { method: "authenticated_receipt_only", atomicSnapshot: false },
    targetInstallationPreserved: true,
    normalServiceTouched: false,
  };
}

function storeError(
  kind: ProductionRuntimeVaultReceiptStoreError["kind"] = "not_found",
): ProductionRuntimeVaultReceiptStoreError {
  if (kind === "not_found") {
    return { kind, field: "receipt", message: "Stored recovery receipt does not exist" };
  }
  return { kind: "io_failure", operation: "read_file", message: "Receipt store I/O failed" };
}

function makeHarness(overrides: {
  readonly readReceipt?: ProductionRuntimeVaultReceiptStore["readReceipt"];
  readonly dispose?: ProductionRuntimeVaultReceiptStore["dispose"];
  readonly nowMs?: () => number;
  readonly seal?: ProductionRuntimeVaultControllerDependencies["seal"];
  readonly recover?: ProductionRuntimeVaultControllerDependencies["recover"];
} = {}) {
  const receiptStore = {
    readReceipt:
      overrides.readReceipt ?? (() => err(storeError())),
    dispose: overrides.dispose ?? (() => ok(undefined)),
    createAndPersistReceipt: vi.fn(),
    paths: vi.fn(),
    recordTerminal: vi.fn(),
    readTerminal: vi.fn(),
  } as unknown as ProductionRuntimeVaultReceiptStore;
  const executor = { run: vi.fn() } as unknown as ProductionRuntimeVaultControllerDependencies["executor"];
  const bridge = { transfer: vi.fn() } as unknown as ProductionRuntimeVaultControllerDependencies["bridge"];
  const leaseClient = { acquire: vi.fn() } as unknown as ProductionRemoteLeaseClient;
  const seal = overrides.seal ?? vi.fn(async () => ok(sealReport()));
  const recover = overrides.recover ?? vi.fn(async () => ok(recoveryReport()));
  const created = createProductionRuntimeVaultControllerForTests({
    receiptStore,
    executor,
    bridge,
    leaseClient,
    nowMs: overrides.nowMs ?? (() => CREATED_AT_MS),
    seal,
    recover,
  });
  if (!created.ok) throw new Error("controller test harness could not be created");
  return { controller: created.value, receiptStore, executor, bridge, leaseClient, seal, recover };
}

describe("production runtime vault controller composition", () => {
  it("rejects a missing controller state root without throwing", () => {
    expect(
      createProductionRuntimeVaultController(
        undefined as unknown as { readonly stateRoot: string },
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_controller_options" },
    });
  });

  it("uses a fresh boundary timestamp only before the attempt receipt exists", async () => {
    const nowMs = vi.fn(() => CREATED_AT_MS);
    let request: SealProductionRuntimeRequest | undefined;
    const harness = makeHarness({
      nowMs,
      seal: async (value) => {
        request = value;
        return ok(sealReport());
      },
    });

    const result = await harness.controller.seal({
      runId: "runtime-controller-a",
      attemptId: ATTEMPT_ID,
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    expect(nowMs).toHaveBeenCalledOnce();
    expect(request).toMatchObject({
      runId: "runtime-controller-a",
      attemptId: ATTEMPT_ID,
      createdAtMs: CREATED_AT_MS,
      executor: harness.executor,
      bridge: harness.bridge,
      leaseClient: harness.leaseClient,
      receiptStore: harness.receiptStore,
    });
  });

  it("reuses the authenticated receipt timestamp across controller restarts", async () => {
    const nowMs = vi.fn(() => CREATED_AT_MS + 99_999);
    let request: SealProductionRuntimeRequest | undefined;
    const harness = makeHarness({
      nowMs,
      readReceipt: () =>
        ok({
          runId: "runtime-controller-a",
          attemptId: ATTEMPT_ID,
          createdAtMs: CREATED_AT_MS,
        } as unknown as ProductionRuntimeVaultRecoveryReceipt),
      seal: async (value) => {
        request = value;
        return ok(sealReport());
      },
    });

    const result = await harness.controller.seal({
      runId: "runtime-controller-a",
      attemptId: ATTEMPT_ID,
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    expect(nowMs).not.toHaveBeenCalled();
    expect(request?.createdAtMs).toBe(CREATED_AT_MS);
  });

  it("fails before mutation when authenticated receipt lookup is indeterminate", async () => {
    const seal = vi.fn(async () => ok(sealReport()));
    const harness = makeHarness({
      readReceipt: () => err(storeError("io_failure")),
      seal,
    });

    const result = await harness.controller.seal({
      runId: "runtime-controller-a",
      attemptId: ATTEMPT_ID,
      profile: profile(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "receipt_store_failure", stage: "read-runtime-vault-receipt" },
    });
    expect(seal).not.toHaveBeenCalled();
  });

  it("recovers through controller-owned execution and lease dependencies without a bridge", async () => {
    let request: RecoverProductionRuntimeVaultRequest | undefined;
    const harness = makeHarness({
      recover: async (value) => {
        request = value;
        return ok(recoveryReport());
      },
    });

    const result = await harness.controller.recover({
      runId: "runtime-controller-a",
      attemptId: ATTEMPT_ID,
      profile: profile(),
    });

    expect(result.ok).toBe(true);
    expect(request).toMatchObject({
      runId: "runtime-controller-a",
      attemptId: ATTEMPT_ID,
      executor: harness.executor,
      leaseClient: harness.leaseClient,
      receiptStore: harness.receiptStore,
    });
    expect(request).not.toHaveProperty("bridge");
  });

  it("disposes owned authority state once and closes every later operation", async () => {
    const dispose = vi.fn(() => ok(undefined));
    const harness = makeHarness({ dispose });

    expect(harness.controller.dispose()).toEqual(ok(undefined));
    expect(harness.controller.dispose()).toEqual(ok(undefined));
    expect(dispose).toHaveBeenCalledOnce();
    expect(
      await harness.controller.recover({
        runId: "runtime-controller-a",
        attemptId: ATTEMPT_ID,
        profile: profile(),
      }),
    ).toMatchObject({ ok: false, error: { kind: "controller_disposed" } });
    expect(
      await harness.controller.seal({
        runId: "runtime-controller-a",
        attemptId: ATTEMPT_ID,
        profile: profile(),
      }),
    ).toMatchObject({ ok: false, error: { kind: "controller_disposed" } });
  });

  it("preserves a disposal failure as the controller terminal result", () => {
    const dispose = vi.fn(() => err(storeError("io_failure")));
    const harness = makeHarness({ dispose });

    expect(harness.controller.dispose()).toMatchObject({
      ok: false,
      error: { kind: "receipt_store_failure", stage: "dispose-runtime-vault-receipt-store" },
    });
    expect(harness.controller.dispose()).toMatchObject({
      ok: false,
      error: { kind: "receipt_store_failure", stage: "dispose-runtime-vault-receipt-store" },
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
