// SPDX-License-Identifier: Apache-2.0
/** Guarded lifecycle and recovery-only reset orchestration for inferred tasks. */
import type { ClockPort, ComisLogger, ErrorKind, TypedEventBus } from "@comis/core";
import type {
  FollowupTaskStore,
  FollowupTaskStoreError,
  TaskAuthorityInspection,
  TaskAuthorityMaintenance,
  TaskAuthorityMaintenanceErrorCode,
  TaskAuthorityResetResult,
  TaskOwnershipRecoveryResult,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";
import { emitSchedulerOperatorAudit } from "./scheduler-operator-audit.js";

export type TaskMaintenanceState = "initializing" | "disabled" | "ready" | "maintenance" | "failed";

export type TaskMaintenanceControllerErrorCode =
  | TaskAuthorityMaintenanceErrorCode
  | "initialization_failed"
  | "ownership_reconciliation_failed"
  | "feature_enabled"
  | "ownership_unproven"
  | "active_execution"
  | "active_attempt"
  | "store_state_unknown"
  | "runtime_quiescence_failed"
  | "post_reset_initialization_failed";

export interface TaskMaintenanceControllerError {
  readonly code: TaskMaintenanceControllerErrorCode;
  readonly errorKind: ErrorKind;
  readonly message: string;
}

export interface TaskMaintenanceStatus {
  readonly state: TaskMaintenanceState;
  readonly configuredEnabled: boolean;
  readonly strictAuthorityValid: boolean;
  readonly ownershipReconciled: boolean;
  readonly taskCount: number;
  readonly activeAttemptCount: number;
  readonly store: TaskAuthorityInspection["store"];
  readonly intent: TaskAuthorityInspection["intent"];
  readonly lastError?: { readonly code: TaskMaintenanceControllerErrorCode; readonly errorKind: ErrorKind };
}

export interface TaskMaintenanceResetRequest {
  readonly expectedDigest: string | null;
  readonly confirmed: boolean;
  readonly actorScope: "admin";
}

export interface TaskMaintenanceResetResult extends TaskAuthorityResetResult {
  readonly state: "disabled";
  readonly reinitialized: true;
}

export interface TaskMaintenanceRuntimeStatus {
  readonly taskCheckActiveCount: number;
  readonly extractionActiveCount: number;
}

export interface TaskMaintenanceController {
  initialize(): Promise<Result<void, TaskMaintenanceControllerError>>;
  status(): Promise<Result<TaskMaintenanceStatus, TaskMaintenanceControllerError>>;
  reset(
    request: TaskMaintenanceResetRequest,
  ): Promise<Result<TaskMaintenanceResetResult, TaskMaintenanceControllerError>>;
}

export interface TaskMaintenanceControllerDeps {
  readonly agentId: string;
  readonly tenantId: string;
  readonly configuredEnabled: boolean;
  readonly authority: TaskAuthorityMaintenance;
  readonly store: FollowupTaskStore;
  readonly exclusiveDataDirLockOwned: () => boolean;
  readonly reconcileOwnership: () => Promise<Result<
    TaskOwnershipRecoveryResult,
    { readonly errorKind: ErrorKind; readonly message: string }
  >>;
  readonly enterMaintenance: (
    agentId: string,
  ) => Promise<Result<TaskMaintenanceRuntimeStatus, { readonly errorKind: ErrorKind; readonly message: string }>>;
  readonly emitReset: (input: {
    readonly agentId: string;
    readonly operationId: string;
    readonly beforeDigest: string | null;
    readonly afterDigest: string;
    readonly durationMs: number;
    readonly timestamp: number;
  }) => void;
  readonly eventBus: Pick<TypedEventBus, "emitSafely">;
  readonly logger: Pick<ComisLogger, "warn">;
  readonly clock: ClockPort;
}

type StoreValidity = "valid" | "invalid" | "unknown";

export function createTaskMaintenanceController(
  deps: TaskMaintenanceControllerDeps,
): TaskMaintenanceController {
  let state: TaskMaintenanceState = "initializing";
  let storeValidity: StoreValidity = "unknown";
  let ownershipReconciled = false;
  let lastError: TaskMaintenanceControllerError | undefined;

  async function initialize(): Promise<Result<void, TaskMaintenanceControllerError>> {
    const recovered = await deps.authority.recoverPendingReset();
    if (!recovered.ok) {
      return fail(recovered.error.code, recovered.error.errorKind, recovered.error.message, "failed");
    }
    return loadStrict("initialization_failed", "failed");
  }

  async function loadStrict(
    initializationCode: "initialization_failed" | "post_reset_initialization_failed",
    failureState: "failed" | "maintenance",
  ): Promise<Result<void, TaskMaintenanceControllerError>> {
    storeValidity = "unknown";
    ownershipReconciled = false;
    const initialized = await deps.store.initialize();
    if (!initialized.ok) {
      storeValidity = initialized.error.errorKind === "validation" ? "invalid" : "unknown";
      return fail(initializationCode, initialized.error.errorKind, initialized.error.message, failureState);
    }
    storeValidity = "valid";
    const ownership = await deps.reconcileOwnership();
    if (!ownership.ok) {
      return fail(
        "ownership_reconciliation_failed",
        ownership.error.errorKind,
        ownership.error.message,
        failureState,
      );
    }
    ownershipReconciled = true;
    lastError = undefined;
    state = deps.configuredEnabled ? "ready" : "disabled";
    return ok(undefined);
  }

  async function status(): Promise<Result<TaskMaintenanceStatus, TaskMaintenanceControllerError>> {
    const raw = await deps.authority.inspect();
    if (!raw.ok) return err(controllerError(raw.error.code, raw.error.errorKind, raw.error.message));
    let taskCount = 0;
    let activeAttemptCount = 0;
    if (storeValidity === "valid") {
      const inspected = await deps.store.inspect();
      if (inspected.ok) {
        taskCount = inspected.value.tasks.length;
        activeAttemptCount = inspected.value.tasks.filter(isActiveTask).length;
      } else if (inspected.error.errorKind === "validation") {
        storeValidity = "invalid";
        ownershipReconciled = false;
      }
    }
    return ok({
      state,
      configuredEnabled: deps.configuredEnabled,
      strictAuthorityValid: storeValidity === "valid",
      ownershipReconciled,
      taskCount,
      activeAttemptCount,
      store: raw.value.store,
      intent: raw.value.intent,
      ...(lastError === undefined
        ? {}
        : { lastError: { code: lastError.code, errorKind: lastError.errorKind } }),
    });
  }

  async function reset(
    request: TaskMaintenanceResetRequest,
  ): Promise<Result<TaskMaintenanceResetResult, TaskMaintenanceControllerError>> {
    const startedAtMs = deps.clock.now();
    if (deps.configuredEnabled) {
      return rejectReset(request, "feature_enabled", "precondition", "Task reset requires inferred tasks to be disabled");
    }
    if (!deps.exclusiveDataDirLockOwned()) {
      return rejectReset(
        request,
        "ownership_unproven",
        "precondition",
        "Task reset requires exclusive ownership of the configured data directory",
      );
    }
    if (!request.confirmed) {
      return rejectReset(request, "confirmation_required", "precondition", "Task authority reset requires explicit confirmation");
    }

    state = "maintenance";
    const quiesced = await deps.enterMaintenance(deps.agentId);
    if (!quiesced.ok) {
      return rejectReset(
        request,
        "runtime_quiescence_failed",
        quiesced.error.errorKind,
        quiesced.error.message,
      );
    }
    if (quiesced.value.taskCheckActiveCount > 0 || quiesced.value.extractionActiveCount > 0) {
      return rejectReset(
        request,
        "active_execution",
        "precondition",
        "Task reset is blocked until current-boot task-check and extraction executions settle",
      );
    }

    const safeToReset = await verifyParsedAuthorityForReset();
    if (!safeToReset.ok) {
      return rejectReset(request, safeToReset.error.code, safeToReset.error.errorKind, safeToReset.error.message);
    }
    const resetResult = await deps.authority.reset({
      expectedDigest: request.expectedDigest,
      confirmed: request.confirmed,
    });
    if (!resetResult.ok) {
      if (resetMayHaveMutatedAuthority(resetResult.error.code)) {
        storeValidity = "unknown";
        ownershipReconciled = false;
      }
      return rejectReset(request, resetResult.error.code, resetResult.error.errorKind, resetResult.error.message);
    }
    storeValidity = "unknown";
    ownershipReconciled = false;
    const reinitialized = await loadStrict("post_reset_initialization_failed", "maintenance");
    if (!reinitialized.ok) {
      auditReset(request, "rejected", reinitialized.error.code, resetResult.value);
      return reinitialized;
    }
    const result: TaskMaintenanceResetResult = {
      ...resetResult.value,
      state: "disabled",
      reinitialized: true,
    };
    auditReset(request, "accepted", undefined, resetResult.value);
    const timestamp = deps.clock.now();
    deps.emitReset({
      agentId: deps.agentId,
      operationId: result.operationId,
      beforeDigest: result.beforeDigest,
      afterDigest: result.afterDigest,
      durationMs: Math.max(0, timestamp - startedAtMs),
      timestamp,
    });
    return ok(result);
  }

  async function verifyParsedAuthorityForReset(): Promise<Result<void, TaskMaintenanceControllerError>> {
    if (storeValidity === "unknown") {
      return err(controllerError(
        "store_state_unknown",
        "precondition",
        "Task authority could not be classified as strictly valid or schema-invalid",
      ));
    }
    if (storeValidity === "invalid") return ok(undefined);
    if (!ownershipReconciled) {
      return err(controllerError(
        "ownership_reconciliation_failed",
        "precondition",
        "Valid task authority reset requires completed ownership reconciliation",
      ));
    }
    const inspected = await deps.store.inspect();
    if (!inspected.ok) return classifyInspectionFailure(inspected.error);
    if (inspected.value.tasks.some(isActiveTask)) {
      return err(controllerError(
        "active_attempt",
        "precondition",
        "Task reset is blocked while a durable task attempt remains active",
      ));
    }
    return ok(undefined);
  }

  function classifyInspectionFailure(
    failure: FollowupTaskStoreError,
  ): Result<void, TaskMaintenanceControllerError> {
    if (failure.errorKind === "validation") {
      storeValidity = "invalid";
      ownershipReconciled = false;
      return ok(undefined);
    }
    storeValidity = "unknown";
    ownershipReconciled = false;
    return err(controllerError("store_state_unknown", failure.errorKind, failure.message));
  }

  function rejectReset(
    request: TaskMaintenanceResetRequest,
    code: TaskMaintenanceControllerErrorCode,
    errorKind: ErrorKind,
    message: string,
  ): Result<never, TaskMaintenanceControllerError> {
    const failure = controllerError(code, errorKind, message);
    lastError = failure;
    auditReset(request, "rejected", code);
    return err(failure);
  }

  function auditReset(
    request: TaskMaintenanceResetRequest,
    outcome: "accepted" | "rejected",
    code?: TaskMaintenanceControllerErrorCode,
    evidence?: TaskAuthorityResetResult,
  ): void {
    emitSchedulerOperatorAudit({
      tenantId: deps.tenantId,
      eventBus: deps.eventBus,
      logger: deps.logger,
      nowMs: () => deps.clock.now(),
    }, {
      agentId: deps.agentId,
      actionType: "tasks.reset",
      classification: "destructive",
      decision: outcome === "accepted" ? "accepted" : "rejected",
      metadata: {
        expectedDigest: request.expectedDigest,
        ...(code === undefined ? {} : { code }),
        ...(evidence === undefined
          ? {}
          : {
            operationId: evidence.operationId,
            beforeDigest: evidence.beforeDigest,
            afterDigest: evidence.afterDigest,
          }),
      },
    });
  }

  function fail(
    code: TaskMaintenanceControllerErrorCode,
    errorKind: ErrorKind,
    message: string,
    nextState: "failed" | "maintenance",
  ): Result<never, TaskMaintenanceControllerError> {
    const failure = controllerError(code, errorKind, message);
    lastError = failure;
    state = nextState;
    return err(failure);
  }

  return { initialize, status, reset };
}

function isActiveTask(task: { readonly status: string }): boolean {
  return task.status === "checking" || task.status === "delivering";
}

function resetMayHaveMutatedAuthority(code: TaskAuthorityMaintenanceErrorCode): boolean {
  return code === "interrupted" || code === "io" || code === "intent_ambiguous";
}

function controllerError(
  code: TaskMaintenanceControllerErrorCode,
  errorKind: ErrorKind,
  message: string,
): TaskMaintenanceControllerError {
  return { code, errorKind, message };
}
