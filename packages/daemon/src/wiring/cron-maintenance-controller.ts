// SPDX-License-Identifier: Apache-2.0
/** Guarded per-agent cron authority lifecycle and reset orchestration. */
import type { ClockPort, ComisLogger, ErrorKind, TypedEventBus } from "@comis/core";
import type {
  BuiltInCronJob,
  CronAuthorityInspection,
  CronAuthorityMaintenance,
  CronAuthorityMaintenanceErrorCode,
  CronAuthorityResetRequest,
  CronAuthorityResetResult,
  CronAuthorityResetTarget,
  CronOwnershipReconciliationResult,
  CronScheduler,
  CronStore,
  ExecutionTracker,
} from "@comis/scheduler";
import { err, ok, type Result } from "@comis/shared";
import { emitSchedulerOperatorAudit } from "./scheduler-operator-audit.js";

export type CronMaintenanceState =
  | "initializing"
  | "disabled"
  | "ready"
  | "active"
  | "maintenance"
  | "failed";

export type CronMaintenanceControllerErrorCode =
  | CronAuthorityMaintenanceErrorCode
  | "initialization_failed"
  | "ownership_reconciliation_failed"
  | "built_in_reconciliation_failed"
  | "snapshot_failed"
  | "active_execution"
  | "unsafe_single_file"
  | "post_reset_initialization_failed"
  | "dependency_not_ready"
  | "activation_failed";

export type CronMaintenanceControllerError = {
  code: CronMaintenanceControllerErrorCode;
  errorKind: ErrorKind;
  message: string;
};

export type CronMaintenanceStatus = {
  state: CronMaintenanceState;
  configuredEnabled: boolean;
  strictAuthoritiesValid: boolean;
  ownershipReconciled: boolean;
  jobCount: number;
  activeClaimCount: number;
  store: CronAuthorityInspection["store"];
  ledger: CronAuthorityInspection["ledger"];
  intent: CronAuthorityInspection["intent"];
  lastError?: { code: CronMaintenanceControllerErrorCode; errorKind: ErrorKind };
};

export type CronMaintenanceResetRequest = CronAuthorityResetRequest & {
  actorScope: "admin";
};

export type CronMaintenanceResetResult = CronAuthorityResetResult & {
  state: "disabled" | "ready" | "active";
  reactivated: boolean;
};

export interface CronMaintenanceController {
  initialize(): Promise<Result<void, CronMaintenanceControllerError>>;
  activate(): Result<void, CronMaintenanceControllerError>;
  status(): Promise<Result<CronMaintenanceStatus, CronMaintenanceControllerError>>;
  reset(
    request: CronMaintenanceResetRequest,
  ): Promise<Result<CronMaintenanceResetResult, CronMaintenanceControllerError>>;
}

export interface CronMaintenanceControllerDeps {
  agentId: string;
  tenantId: string;
  configuredEnabled: boolean;
  authority: CronAuthorityMaintenance;
  store: CronStore;
  tracker?: ExecutionTracker;
  scheduler?: CronScheduler;
  reconcileOwnership: () => Promise<Result<CronOwnershipReconciliationResult, {
    errorKind: ErrorKind;
    message: string;
  }>>;
  desiredBuiltIns: () => readonly BuiltInCronJob[];
  dependenciesReady: () => boolean;
  onReady: (input: {
    agentId: string;
    seed: string;
    scheduler?: CronScheduler;
    tracker?: ExecutionTracker;
  }) => void;
  onQuiesced: (agentId: string) => void;
  emitReset: (input: {
    agentId: string;
    operationId: string;
    target: CronAuthorityResetTarget;
    beforeDigests: CronAuthorityResetResult["beforeDigests"];
    afterDigests: CronAuthorityResetResult["afterDigests"];
    reactivated: boolean;
    timestamp: number;
  }) => void;
  eventBus: Pick<TypedEventBus, "emitSafely">;
  logger: ComisLogger;
  clock: ClockPort;
}

export function createCronMaintenanceController(
  deps: CronMaintenanceControllerDeps,
): CronMaintenanceController {
  let state: CronMaintenanceState = "initializing";
  let strictAuthoritiesValid = false;
  let ownershipReconciled = false;
  let activationRequested = false;
  let currentSeed: string | undefined;
  let lastError: CronMaintenanceControllerError | undefined;

  async function initialize(): Promise<Result<void, CronMaintenanceControllerError>> {
    const recovered = await deps.authority.recoverPendingReset();
    if (!recovered.ok) {
      return fail(recovered.error.code, recovered.error.errorKind, recovered.error.message, "failed");
    }
    return loadStrict("initialize", "failed", true);
  }

  async function loadStrict(
    mode: "initialize" | "reload",
    failureState: "failed" | "maintenance",
    publish: boolean,
  ): Promise<Result<void, CronMaintenanceControllerError>> {
    strictAuthoritiesValid = false;
    ownershipReconciled = false;
    if (deps.configuredEnabled) {
      if (deps.scheduler === undefined || deps.tracker === undefined) {
        return fail(
          mode === "reload" ? "post_reset_initialization_failed" : "initialization_failed",
          "internal",
          "Enabled cron maintenance is missing its scheduler or execution tracker",
          failureState,
        );
      }
      const loaded = mode === "initialize"
        ? await deps.scheduler.initialize()
        : await deps.scheduler.reload();
      if (!loaded.ok) {
        return fail(
          mode === "reload" ? "post_reset_initialization_failed" : "initialization_failed",
          loaded.error.errorKind,
          loaded.error.message,
          failureState,
        );
      }
      strictAuthoritiesValid = true;
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
    } else {
      const loaded = await deps.store.initialize();
      if (!loaded.ok) {
        return fail(
          mode === "reload" ? "post_reset_initialization_failed" : "initialization_failed",
          loaded.error.errorKind,
          loaded.error.message,
          failureState,
        );
      }
    }

    const builtIns = await deps.store.reconcileBuiltIns(deps.desiredBuiltIns());
    if (!builtIns.ok) {
      return fail("built_in_reconciliation_failed", builtIns.error.errorKind, builtIns.error.message, failureState);
    }
    const snapshot = deps.store.getSnapshot();
    if (!snapshot.ok) {
      return fail("snapshot_failed", snapshot.error.errorKind, snapshot.error.message, failureState);
    }
    lastError = undefined;
    state = deps.configuredEnabled ? "ready" : "disabled";
    currentSeed = snapshot.value.agentSchedulerSeed;
    if (publish) publishReady();
    return ok(undefined);
  }

  function activate(): Result<void, CronMaintenanceControllerError> {
    activationRequested = true;
    if (!deps.configuredEnabled) return ok(undefined);
    if (state !== "ready" || deps.scheduler === undefined) {
      return err(controllerError("activation_failed", "precondition", "Cron subsystem is not ready for activation"));
    }
    if (!deps.dependenciesReady()) {
      return err(controllerError("dependency_not_ready", "precondition", "Cron runtime dependencies are not ready"));
    }
    const activated = deps.scheduler.activate();
    if (!activated.ok) {
      return fail("activation_failed", activated.error.errorKind, activated.error.message, "failed");
    }
    state = "active";
    return ok(undefined);
  }

  async function status(): Promise<Result<CronMaintenanceStatus, CronMaintenanceControllerError>> {
    const inspected = await deps.authority.inspect();
    if (!inspected.ok) {
      return err(controllerError(inspected.error.code, inspected.error.errorKind, inspected.error.message));
    }
    const snapshot = deps.store.getSnapshot();
    const jobCount = snapshot.ok ? snapshot.value.jobs.length : 0;
    const activeClaimCount = snapshot.ok ? snapshot.value.activeClaims.length : 0;
    return ok({
      state,
      configuredEnabled: deps.configuredEnabled,
      strictAuthoritiesValid,
      ownershipReconciled,
      jobCount,
      activeClaimCount,
      store: inspected.value.store,
      ledger: inspected.value.ledger,
      intent: inspected.value.intent,
      ...(lastError === undefined
        ? {}
        : { lastError: { code: lastError.code, errorKind: lastError.errorKind } }),
    });
  }

  async function reset(
    request: CronMaintenanceResetRequest,
  ): Promise<Result<CronMaintenanceResetResult, CronMaintenanceControllerError>> {
    deps.onQuiesced(deps.agentId);
    state = "maintenance";
    if (deps.scheduler !== undefined) {
      const maintenance = deps.scheduler.enterMaintenance();
      if (!maintenance.ok) {
        return rejectReset(request, "active_execution", maintenance.error.errorKind, maintenance.error.message);
      }
      if (maintenance.value.activeExecutions > 0) {
        return rejectReset(
          request,
          "active_execution",
          "precondition",
          "Cron reset is blocked until every accepted current-boot execution settles",
        );
      }
    }

    if (request.target !== "all") {
      const snapshot = deps.store.getSnapshot();
      if (
        !strictAuthoritiesValid
        || !ownershipReconciled
        || !snapshot.ok
        || snapshot.value.activeClaims.length > 0
      ) {
        return rejectReset(
          request,
          "unsafe_single_file",
          "precondition",
          "Single-file reset requires two valid authorities, completed ownership reconciliation, and zero active claims",
        );
      }
    }

    strictAuthoritiesValid = false;
    ownershipReconciled = false;
    currentSeed = undefined;
    const authorityRequest = authorityRequestOf(request);
    const resetResult = await deps.authority.reset(authorityRequest);
    if (!resetResult.ok) {
      return rejectReset(request, resetResult.error.code, resetResult.error.errorKind, resetResult.error.message);
    }
    const reloaded = await loadStrict("reload", "maintenance", false);
    if (!reloaded.ok) {
      auditReset(request, "rejected", reloaded.error.code, resetResult.value);
      return reloaded;
    }

    let reactivated = false;
    if (activationRequested && deps.configuredEnabled) {
      if (!deps.dependenciesReady()) {
        deps.onQuiesced(deps.agentId);
        state = "maintenance";
        return rejectReset(
          request,
          "dependency_not_ready",
          "precondition",
          "Cron runtime dependencies are not ready after strict reset reload",
          resetResult.value,
        );
      }
      const activated = deps.scheduler?.activate();
      if (activated === undefined || !activated.ok) {
        deps.onQuiesced(deps.agentId);
        state = "maintenance";
        return rejectReset(
          request,
          "activation_failed",
          activated?.error.errorKind ?? "internal",
          activated?.error.message ?? "Cron scheduler is unavailable after strict reset reload",
          resetResult.value,
        );
      }
      state = "active";
      reactivated = true;
    }
    publishReady();
    const result: CronMaintenanceResetResult = {
      ...resetResult.value,
      state: resultState(),
      reactivated,
    };
    auditReset(request, "accepted", undefined, resetResult.value);
    deps.emitReset({
      agentId: deps.agentId,
      operationId: result.operationId,
      target: result.target,
      beforeDigests: result.beforeDigests,
      afterDigests: result.afterDigests,
      reactivated,
      timestamp: deps.clock.now(),
    });
    return ok(result);
  }

  function rejectReset(
    request: CronMaintenanceResetRequest,
    code: CronMaintenanceControllerErrorCode,
    errorKind: ErrorKind,
    message: string,
    evidence?: CronAuthorityResetResult,
  ): Result<never, CronMaintenanceControllerError> {
    const failure = controllerError(code, errorKind, message);
    lastError = failure;
    auditReset(request, "rejected", code, evidence);
    return err(failure);
  }

  function auditReset(
    request: CronMaintenanceResetRequest,
    outcome: "accepted" | "rejected",
    code: CronMaintenanceControllerErrorCode | undefined,
    evidence?: CronAuthorityResetResult,
  ): void {
    emitSchedulerOperatorAudit({
      tenantId: deps.tenantId,
      eventBus: deps.eventBus,
      logger: deps.logger,
      nowMs: () => deps.clock.now(),
    }, {
      agentId: deps.agentId,
      actionType: "cron.reset",
      classification: "destructive",
      decision: outcome === "accepted" ? "accepted" : "rejected",
      metadata: {
        target: request.target,
        expectedDigests: request.expectedDigests,
        ...(code === undefined ? {} : { code }),
        ...(evidence === undefined
          ? {}
          : {
            operationId: evidence.operationId,
            beforeDigests: evidence.beforeDigests,
            afterDigests: evidence.afterDigests,
          }),
      },
    });
  }

  function fail(
    code: CronMaintenanceControllerErrorCode,
    errorKind: ErrorKind,
    message: string,
    nextState: "failed" | "maintenance",
  ): Result<never, CronMaintenanceControllerError> {
    const failure = controllerError(code, errorKind, message);
    lastError = failure;
    state = nextState;
    deps.onQuiesced(deps.agentId);
    return err(failure);
  }

  function resultState(): CronMaintenanceResetResult["state"] {
    if (!deps.configuredEnabled) return "disabled";
    return state === "active" ? "active" : "ready";
  }

  function publishReady(): void {
    if (currentSeed === undefined) return;
    deps.onReady({
      agentId: deps.agentId,
      seed: currentSeed,
      ...(deps.scheduler === undefined ? {} : { scheduler: deps.scheduler }),
      ...(deps.tracker === undefined ? {} : { tracker: deps.tracker }),
    });
  }

  return { initialize, activate, status, reset };
}

function authorityRequestOf(request: CronMaintenanceResetRequest): CronAuthorityResetRequest {
  switch (request.target) {
    case "store": return {
      target: "store",
      expectedDigests: request.expectedDigests,
      confirmed: request.confirmed,
    };
    case "ledger": return {
      target: "ledger",
      expectedDigests: request.expectedDigests,
      confirmed: request.confirmed,
    };
    case "all": return {
      target: "all",
      expectedDigests: request.expectedDigests,
      confirmed: request.confirmed,
    };
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

function controllerError(
  code: CronMaintenanceControllerErrorCode,
  errorKind: ErrorKind,
  message: string,
): CronMaintenanceControllerError {
  return { code, errorKind, message };
}
