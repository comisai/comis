// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";

import {
  createProductionBinarySshBridge,
  type ProductionBinarySshBridge,
} from "./production-binary-ssh.js";
import type { ProductionRemoteExecutor } from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";
import {
  createProductionRemoteLeaseClient,
  type ProductionRemoteLeaseClient,
} from "./production-remote-lease.js";
import {
  createProductionRuntimeVaultReceiptStore,
  type ProductionRuntimeVaultReceiptStore,
  type ProductionRuntimeVaultReceiptStoreError,
} from "./production-runtime-vault-receipt-store.js";
import {
  recoverProductionRuntimeVault,
  sealProductionRuntime,
  type ProductionRuntimeVaultError,
  type ProductionRuntimeVaultRecoveryReport,
  type ProductionRuntimeVaultReport,
  type RecoverProductionRuntimeVaultRequest,
  type SealProductionRuntimeRequest,
} from "./production-runtime-vault.js";
import { createProductionSshExecutor } from "./production-ssh.js";

export type ProductionRuntimeVaultControllerError =
  | ProductionRuntimeVaultError
  | {
      readonly kind: "invalid_controller_options";
      readonly stage: "create-runtime-vault-controller";
      readonly message: string;
    }
  | {
      readonly kind: "controller_disposed";
      readonly stage: "seal-runtime-vault" | "recover-runtime-vault";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_controller_time";
      readonly stage: "create-runtime-vault-receipt";
      readonly message: string;
    }
  | {
      readonly kind: "receipt_store_failure";
      readonly stage:
        | "create-runtime-vault-receipt-store"
        | "read-runtime-vault-receipt"
        | "dispose-runtime-vault-receipt-store";
      readonly message: string;
      readonly cause: ProductionRuntimeVaultReceiptStoreError;
    };

export interface ProductionRuntimeVaultControllerRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly profile: ProductionReplayProfile;
}

export interface ProductionRuntimeVaultController {
  readonly seal: (
    request: ProductionRuntimeVaultControllerRequest,
  ) => Promise<Result<ProductionRuntimeVaultReport, ProductionRuntimeVaultControllerError>>;
  readonly recover: (
    request: ProductionRuntimeVaultControllerRequest,
  ) => Promise<
    Result<ProductionRuntimeVaultRecoveryReport, ProductionRuntimeVaultControllerError>
  >;
  readonly dispose: () => Result<void, ProductionRuntimeVaultControllerError>;
}

export interface CreateProductionRuntimeVaultControllerOptions {
  readonly stateRoot: string;
}

export interface ProductionRuntimeVaultControllerDependencies {
  readonly receiptStore: ProductionRuntimeVaultReceiptStore;
  readonly executor: ProductionRemoteExecutor;
  readonly bridge: ProductionBinarySshBridge;
  readonly leaseClient: ProductionRemoteLeaseClient;
  readonly nowMs: () => number;
  readonly seal: (
    request: SealProductionRuntimeRequest,
  ) => Promise<Result<ProductionRuntimeVaultReport, ProductionRuntimeVaultError>>;
  readonly recover: (
    request: RecoverProductionRuntimeVaultRequest,
  ) => Promise<Result<ProductionRuntimeVaultRecoveryReport, ProductionRuntimeVaultError>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptStoreFailure(
  stage:
    | "create-runtime-vault-receipt-store"
    | "read-runtime-vault-receipt"
    | "dispose-runtime-vault-receipt-store",
  cause: ProductionRuntimeVaultReceiptStoreError,
): ProductionRuntimeVaultControllerError {
  return {
    kind: "receipt_store_failure",
    stage,
    message: "Runtime vault controller authority state is unavailable",
    cause,
  };
}

function disposed(
  stage: "seal-runtime-vault" | "recover-runtime-vault",
): Result<never, ProductionRuntimeVaultControllerError> {
  return err({
    kind: "controller_disposed",
    stage,
    message: "Runtime vault controller is closed",
  });
}

function createController(
  deps: ProductionRuntimeVaultControllerDependencies,
): Result<ProductionRuntimeVaultController, ProductionRuntimeVaultControllerError> {
  let isDisposed = false;
  let disposalResult: Result<void, ProductionRuntimeVaultControllerError> | undefined;

  async function seal(
    request: ProductionRuntimeVaultControllerRequest,
  ): Promise<Result<ProductionRuntimeVaultReport, ProductionRuntimeVaultControllerError>> {
    if (isDisposed) return disposed("seal-runtime-vault");
    const existing = deps.receiptStore.readReceipt(request.runId, request.attemptId);
    let createdAtMs: number;
    if (existing.ok) {
      createdAtMs = existing.value.createdAtMs;
    } else if (existing.error.kind === "not_found") {
      createdAtMs = deps.nowMs();
    } else {
      return err(receiptStoreFailure("read-runtime-vault-receipt", existing.error));
    }
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      return err({
        kind: "invalid_controller_time",
        stage: "create-runtime-vault-receipt",
        message: "Runtime vault controller time is invalid",
      });
    }
    return deps.seal({
      ...request,
      createdAtMs,
      executor: deps.executor,
      bridge: deps.bridge,
      leaseClient: deps.leaseClient,
      receiptStore: deps.receiptStore,
    });
  }

  async function recover(
    request: ProductionRuntimeVaultControllerRequest,
  ): Promise<
    Result<ProductionRuntimeVaultRecoveryReport, ProductionRuntimeVaultControllerError>
  > {
    if (isDisposed) return disposed("recover-runtime-vault");
    return deps.recover({
      ...request,
      executor: deps.executor,
      leaseClient: deps.leaseClient,
      receiptStore: deps.receiptStore,
    });
  }

  function dispose(): Result<void, ProductionRuntimeVaultControllerError> {
    if (disposalResult !== undefined) return disposalResult;
    isDisposed = true;
    const closed = deps.receiptStore.dispose();
    disposalResult = closed.ok
      ? ok(undefined)
      : err(
          receiptStoreFailure(
            "dispose-runtime-vault-receipt-store",
            closed.error,
          ),
        );
    return disposalResult;
  }

  return ok({ seal, recover, dispose });
}

export function createProductionRuntimeVaultControllerForTests(
  deps: ProductionRuntimeVaultControllerDependencies,
): Result<ProductionRuntimeVaultController, ProductionRuntimeVaultControllerError> {
  return createController(deps);
}

export function createProductionRuntimeVaultController(
  options: CreateProductionRuntimeVaultControllerOptions,
): Result<ProductionRuntimeVaultController, ProductionRuntimeVaultControllerError> {
  if (!isRecord(options) || typeof options.stateRoot !== "string") {
    return err({
      kind: "invalid_controller_options",
      stage: "create-runtime-vault-controller",
      message: "Runtime vault controller options are invalid",
    });
  }
  const receiptStore = createProductionRuntimeVaultReceiptStore({
    stateRoot: options.stateRoot,
  });
  if (!receiptStore.ok) {
    return err(
      receiptStoreFailure(
        "create-runtime-vault-receipt-store",
        receiptStore.error,
      ),
    );
  }
  return createController({
    receiptStore: receiptStore.value,
    executor: createProductionSshExecutor(),
    bridge: createProductionBinarySshBridge(),
    leaseClient: createProductionRemoteLeaseClient(),
    nowMs: () => Date.now(),
    seal: sealProductionRuntime,
    recover: recoverProductionRuntimeVault,
  });
}
