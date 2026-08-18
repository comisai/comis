// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import { CAPABILITY_SERVICE_BUNDLE_DIGEST } from "@comis/capability-service-sdk";
import {
  buildCapabilityServiceActivationPlan,
  resolveEffectiveCapabilityServiceLimits,
  safePath,
  type CapabilityServiceActivationPlan,
  type CapabilityServiceContributionRegistration,
  type CapabilityServicesConfig,
  type CapabilityServiceControlPort,
  type ClockPort,
  type ComisLogger,
  type ExecutionAttachmentPort,
  type ManagedRunContentPort,
  type ManagedRunStorePort,
  type PlannedCapabilityServiceDefinition,
  type SecretManager,
  type TimerPort,
  type TypedEventBus,
  type WorkspaceLeasePort,
} from "@comis/core";
import {
  createSqliteExecutionAttachmentStore,
  createSqliteManagedRunContentStore,
  createSqliteManagedRunStore,
  createSqliteWorkspaceLeaseStore,
} from "@comis/memory";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import {
  createCapabilityServiceRuntime,
  type CapabilityServiceRuntime,
} from "./capability-service-runtime.js";
import {
  createManagedRunActivationCoordinator,
  type ManagedRunActivationControlIds,
  type ManagedRunActivationCoordinator,
  type ManagedRunActivationIds,
  type ManagedRunActivationRecoverySummary,
} from "./managed-run-activation-coordinator.js";
import {
  createManagedRunEvidenceBridge,
  type ManagedRunEvidenceBridge,
} from "./managed-run-evidence-bridge.js";
import { createManagedAttentionResponseBridge } from "./managed-attention-response-bridge.js";
import {
  createManagedRunReportBridge,
  type ManagedRunReportBridge,
} from "./managed-run-report-bridge.js";
import { createUnixCapabilityServiceHostRuntime } from "./capability-service-unix-host.js";
import { validateWorkspaceLeasePath } from "./workspace-lease-path-validator.js";
import {
  createExecutionAttachmentAuthority,
  type ExecutionAttachmentAuthority,
  type ExecutionAttachmentRecoverySummary,
} from "./execution-attachment-authority.js";
import type { ManagedTerminalRevoker } from "./managed-terminal-revoker.js";
import { createManagedRunResourceRevoker } from "./managed-run-resource-revoker.js";
import { createManagedRunCancellationCoordinator, type ManagedRunCancellationCoordinator } from "./managed-run-cancellation-coordinator.js";
import { createManagedRunLivenessBridge } from "./managed-run-liveness-bridge.js";
import { createManagedRunReleaseCoordinator } from "./managed-run-release-coordinator.js";

const SECRET_REFERENCE_PREFIX = "secret://";

const EMPTY_RECOVERY_SUMMARY: ManagedRunActivationRecoverySummary = {
  activated: [],
  cancelled: [],
  unknown: [],
  invalid: [],
  failed: [],
};

function mergeRecoverySummary(
  aggregate: ManagedRunActivationRecoverySummary,
  page: ManagedRunActivationRecoverySummary,
): ManagedRunActivationRecoverySummary {
  return {
    activated: [...aggregate.activated, ...page.activated],
    cancelled: [...aggregate.cancelled, ...page.cancelled],
    unknown: [...aggregate.unknown, ...page.unknown],
    invalid: [...aggregate.invalid, ...page.invalid],
    failed: [...aggregate.failed, ...page.failed],
  };
}

async function recoverAllPreparations(
  coordinator: ManagedRunActivationCoordinator,
  updatedBeforeMs: number,
  limit: number,
): Promise<Result<ManagedRunActivationRecoverySummary, Error>> {
  let summary = EMPTY_RECOVERY_SUMMARY;
  let afterManagedRunId: string | undefined;
  do {
    const page = await coordinator.recoverPreparations({
      updatedBeforeMs,
      limit,
      ...(afterManagedRunId === undefined ? {} : { afterManagedRunId }),
    });
    if (!page.ok) return page;
    summary = mergeRecoverySummary(summary, page.value);
    afterManagedRunId = page.value.nextAfterManagedRunId;
  } while (afterManagedRunId !== undefined);
  return ok(summary);
}

async function purgeAllExpiredContent(
  contentStore: ManagedRunContentPort,
  expiredBeforeMs: number,
  limit: number,
): Promise<Result<number, Error>> {
  let purgedCount = 0;
  for (;;) {
    const page = await invoke(contentStore.purgeExpired({
      kind: "recovery",
      expiredBeforeMs,
      limit,
    }));
    if (!page.ok) return page;
    purgedCount += page.value;
    if (page.value < limit) return ok(purgedCount);
  }
}

/**
 * The definition an activated instance was planned from. Obligations the host
 * enforces per run — required evidence kinds, declared liveness — are properties
 * of the definition, so both resolvers must read the same planned record.
 */
export function definitionForInstance(
  plan: CapabilityServiceActivationPlan,
  serviceInstanceId: string,
): PlannedCapabilityServiceDefinition | undefined {
  const instance = plan.orderedInstances.find(
    (candidate) => candidate.serviceInstanceId === serviceInstanceId,
  );
  return instance === undefined
    ? undefined
    : plan.orderedDefinitions.find(
      (definition) => definition.serviceDefinitionId === instance.serviceDefinitionId,
    );
}

export interface CapabilityServicePlatform {
  readonly plan: CapabilityServiceActivationPlan;
  readonly runtime: CapabilityServiceRuntime;
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
  readonly workspaceLeases: WorkspaceLeasePort;
  readonly attachments: ExecutionAttachmentPort;
  readonly attachmentAuthority: ExecutionAttachmentAuthority;
  readonly control: CapabilityServiceControlPort;
  readonly activationCoordinator: ManagedRunActivationCoordinator;
  readonly cancellationCoordinator: ManagedRunCancellationCoordinator;
  readonly reportBridge: ManagedRunReportBridge;
  readonly evidenceBridge: ManagedRunEvidenceBridge;
  readonly recoverySummary: ManagedRunActivationRecoverySummary;
  readonly attachmentRecoverySummary: ExecutionAttachmentRecoverySummary;
  readonly purgedContentCount: number;
  bindTerminalRevoker(revoker: ManagedTerminalRevoker): void;
  shutdown(): Promise<Result<void, Error>>;
}

export interface SetupCapabilityServicesDeps {
  readonly contributions: readonly CapabilityServiceContributionRegistration[];
  readonly config: CapabilityServicesConfig;
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly secretManager: Pick<SecretManager, "get">;
  readonly eventBus: TypedEventBus;
  readonly logger: ComisLogger;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
}

function digest(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
}

function controlIds(managedRunId: string): ManagedRunActivationControlIds {
  const id = (kind: string): string => `${kind}-${digest(kind, managedRunId).slice(0, 48)}`;
  return Object.freeze({
    workspaceLeaseId: id("workspace-lease"),
    attachmentOperationId: id("execution-attachment"),
    activationOperationId: id("activate"),
    abandonOperationId: id("abandon"),
    leaseReleaseOperationId: id("lease-release"),
    leaseRecoveryOperationId: id("lease-recover"),
    rejectionOperationId: id("reject"),
    joinMissingOperationId: id("join-missing"),
    outcomeUnknownOperationId: id("outcome-unknown"),
    unavailableOperationId: id("unavailable"),
  });
}

function operationIds(operationId: string): Pick<
  ManagedRunActivationIds,
  "managedRunId" | "activationDescriptorRef"
> {
  return Object.freeze({
    managedRunId: `managed-run-${digest("managed-run", operationId).slice(0, 48)}`,
    activationDescriptorRef: `activation-${digest("activation", operationId).slice(0, 48)}`,
  });
}

function validateOwnerOnlyDirectory(path: string, label: string): Result<void, Error> {
  const checked = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- setup validates only an absolute composition-root path before deriving children
    const stat = lstatSync(path);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- canonicality is checked against the same composition-root path
    const canonical = realpathSync(path);
    return { stat, canonical };
  });
  if (!checked.ok) return err(checked.error);
  if (
    !checked.value.stat.isDirectory()
    || checked.value.stat.isSymbolicLink()
    || (checked.value.stat.mode & 0o077) !== 0
    || checked.value.canonical !== path
  ) {
    return err(new Error(`${label} must be a real owner-only canonical directory`));
  }
  return ok(undefined);
}

function createOwnerOnlyDirectory(path: string, label: string): Result<void, Error> {
  const created = tryCatch(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is safePath-confined or a confined socket parent validated by the caller
    mkdirSync(path, { recursive: true, mode: 0o700 });
  });
  return created.ok ? validateOwnerOnlyDirectory(path, label) : err(created.error);
}

function confinedPath(root: string, target: string): Result<string, Error> {
  if (!isAbsolute(target) || normalize(target) !== target) {
    return err(new Error("capability-service socket path must be absolute and normalized"));
  }
  const child = relative(root, target);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return err(new Error("capability-service socket path must remain beneath dataDir"));
  }
  const reconstructed = tryCatch(() => safePath(root, ...child.split(sep)));
  return reconstructed.ok && reconstructed.value === target
    ? ok(target)
    : err(new Error("capability-service socket path failed dataDir confinement"));
}

function prepareDirectories(
  dataDir: string,
  config: CapabilityServicesConfig,
): Result<string, Error> {
  const root = validateOwnerOnlyDirectory(dataDir, "capability-service dataDir");
  if (!root.ok) return root;
  const contentPath = tryCatch(() => safePath(dataDir, ...config.privateContentDirectory.split("/")));
  if (!contentPath.ok) return err(contentPath.error);
  const contentDirectory = createOwnerOnlyDirectory(contentPath.value, "managed-run private content directory");
  if (!contentDirectory.ok) return contentDirectory;

  for (const instance of config.instances) {
    const confined = confinedPath(dataDir, instance.control.socketPath);
    if (!confined.ok) return confined;
    if (!instance.enabled) continue;
    const parent = createOwnerOnlyDirectory(
      dirname(confined.value),
      `capability-service socket parent for ${instance.serviceInstanceId}`,
    );
    if (!parent.ok) return parent;
  }
  return ok(contentPath.value);
}

async function invoke<T>(operation: Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const settled = await fromPromise(operation);
  return settled.ok ? settled.value : err(settled.error);
}

function logSetupFailure(deps: SetupCapabilityServicesDeps, step: string, errorKind: "config" | "dependency" | "internal"): void {
  deps.logger.error({
    step,
    errorKind,
    hint: "Check capabilityServices topology, per-instance secret references, confined socket paths, and the managed-run SQLite store before restarting",
  }, "Capability-service platform setup failed");
}

/** Assemble and recover the durable capability-service platform at daemon startup. */
export async function setupCapabilityServices(
  deps: SetupCapabilityServicesDeps,
): Promise<Result<CapabilityServicePlatform, Error>> {
  const startedAtMs = deps.clock.now();
  const plan = buildCapabilityServiceActivationPlan(deps.contributions, deps.config.instances);
  if (!plan.ok) {
    logSetupFailure(deps, "capability-service-plan", "config");
    return err(new Error(`capability-service activation plan failed: ${plan.error.kind}`));
  }
  const directories = prepareDirectories(deps.dataDir, deps.config);
  if (!directories.ok) {
    logSetupFailure(deps, "capability-service-directories", "config");
    return directories;
  }

  const stores = tryCatch(() => {
    const store = createSqliteManagedRunStore(deps.db);
    const workspaceLeases = createSqliteWorkspaceLeaseStore(deps.db);
    const attachments = createSqliteExecutionAttachmentStore(deps.db);
    const contentStore = createSqliteManagedRunContentStore(deps.db, {
      directoryPath: directories.value,
      nowMs: () => deps.clock.now(),
    });
    return { store, workspaceLeases, attachments, contentStore };
  });
  if (!stores.ok) {
    logSetupFailure(deps, "capability-service-stores", "internal");
    return err(stores.error);
  }
  if (!stores.value.contentStore.ok) {
    logSetupFailure(deps, "capability-service-stores", "internal");
    return err(stores.value.contentStore.error);
  }
  const store = stores.value.store;
  const workspaceLeases = stores.value.workspaceLeases;
  const attachments = stores.value.attachments;
  const contentStore = stores.value.contentStore.value;
  const definitionByInstance = new Map(plan.value.orderedInstances.map((instance) => [
    instance.serviceInstanceId,
    definitionForInstance(plan.value, instance.serviceInstanceId),
  ]));
  // Effective self-declared bounds per instance: the instance override, then the
  // definition, then the global protocol ceiling at the bridge. Resolved once.
  const limitsByInstance = new Map(plan.value.orderedInstances.map((instance) => [
    instance.serviceInstanceId,
    resolveEffectiveCapabilityServiceLimits(
      definitionByInstance.get(instance.serviceInstanceId)?.limits,
      instance.limits,
    ),
  ]));
  const reportBridge = createManagedRunReportBridge({
    store,
    contentStore,
    nowMs: () => deps.clock.now(),
    retentionMs: deps.config.reportRetentionMs,
    maxObservedClockSkewMs: deps.config.maxObservedClockSkewMs,
    resolveMaxReportBytes: (serviceInstanceId) => limitsByInstance.get(serviceInstanceId)?.maxReportBytes,
    resolveMaxReportsPerMinute: (serviceInstanceId) => limitsByInstance.get(serviceInstanceId)?.maxReportsPerMinute,
    eventBus: deps.eventBus,
    logger: deps.logger,
  });
  const evidenceBridge = createManagedRunEvidenceBridge({
    store,
    contentStore,
    nowMs: () => deps.clock.now(),
    maxObservedClockSkewMs: deps.config.maxObservedClockSkewMs,
    resolveEvidencePolicies: (serviceInstanceId) => definitionByInstance.get(serviceInstanceId)?.evidencePolicies,
    resolveMaxEvidenceBytes: (serviceInstanceId) => limitsByInstance.get(serviceInstanceId)?.maxEvidenceBytes,
    eventBus: deps.eventBus,
    logger: deps.logger,
  });
  const attentionResponseBridge = createManagedAttentionResponseBridge({
    store,
    contentStore,
    nowMs: () => deps.clock.now(),
    eventBus: deps.eventBus,
    logger: deps.logger,
  });
  let terminalRevoker: ManagedTerminalRevoker | undefined;
  const revokeManagedTerminals: ManagedTerminalRevoker = async (record) => {
    if (record.terminalSessionIds.length === 0) return ok(undefined);
    return terminalRevoker === undefined
      ? err(new Error("managed terminal revoker is unavailable"))
      : terminalRevoker(record);
  };
  const revokeBoundResources = createManagedRunResourceRevoker({
    store,
    attachments,
    revokeManagedTerminals,
    nowMs: () => deps.clock.now(),
    logger: deps.logger,
  });
  const releaseCoordinator = createManagedRunReleaseCoordinator({
    store,
    workspaceLeases,
    revokeBoundResources,
  });
  const livenessBridge = createManagedRunLivenessBridge({ store, clock: deps.clock });

  const credentials = new Map<string, () => string | undefined>();
  for (const instance of plan.value.orderedInstances) {
    const secretName = instance.control.credentialRef.slice(SECRET_REFERENCE_PREFIX.length);
    const resolveCredential = (): string | undefined => deps.secretManager.get(secretName);
    if (!resolveCredential()) {
      logSetupFailure(deps, "capability-service-credentials", "config");
      return err(new Error(`capability-service credential is unavailable for ${instance.serviceInstanceId}`));
    }
    credentials.set(instance.serviceInstanceId, resolveCredential);
  }
  let recoverAuthenticatedSession = async (_serviceInstanceId: string): Promise<Result<void, Error>> => ok(undefined);
  const host = createUnixCapabilityServiceHostRuntime({
    definitions: plan.value.orderedDefinitions,
    instances: plan.value.orderedInstances,
    credentials,
    bundleDigest: CAPABILITY_SERVICE_BUNDLE_DIGEST,
    socketRoot: deps.dataDir,
    reportBridge,
    evidenceBridge,
    attentionResponseBridge,
    livenessBridge,
    releaseCoordinator,
    requestDeadlineMs: deps.config.requestDeadlineMs,
    clock: deps.clock,
    timers: deps.timers,
    logger: deps.logger,
    onAuthenticatedSession: (serviceInstanceId) => recoverAuthenticatedSession(serviceInstanceId),
  });
  if (!host.ok) {
    logSetupFailure(deps, "capability-service-host", "config");
    return host;
  }
  const runtime = createCapabilityServiceRuntime({
    activators: host.value.activators,
    eventBus: deps.eventBus,
    logger: deps.logger,
    nowMs: () => deps.clock.now(),
  });
  const activated = await runtime.replace(plan.value);
  if (!activated.ok) {
    await runtime.shutdown();
    logSetupFailure(deps, "capability-service-activation", "dependency");
    return err(new Error(`capability-service runtime activation failed: ${activated.error.kind}`));
  }

  const attachmentAuthority = createExecutionAttachmentAuthority({
    runs: store,
    leases: workspaceLeases,
    attachments,
    instances: plan.value.orderedInstances,
    dataDir: deps.dataDir,
    nowMs: () => deps.clock.now(),
    isServiceActive: (serviceInstanceId) => runtime.getActiveView().instances.some(
      (instance) => instance.serviceInstanceId === serviceInstanceId && instance.state === "active",
    ),
    logger: deps.logger,
  });
  recoverAuthenticatedSession = async (serviceInstanceId) => {
    const startedAtMs = deps.clock.now();
    const reconciled = await attachmentAuthority.reconcileService({
      serviceInstanceId,
      updatedBeforeMs: startedAtMs,
      limit: deps.config.recoveryBatchSize,
    });
    if (!reconciled.ok) return reconciled;
    deps.logger.info({
      serviceInstanceId,
      recoveredAttachmentCount: reconciled.value.recovered.length,
      preservedAttachmentCount: reconciled.value.preserved.length,
      durationMs: Math.max(0, deps.clock.now() - startedAtMs),
    }, "Capability-service reconnect attachments reconciled");
    return ok(undefined);
  };
  const activationCoordinator = createManagedRunActivationCoordinator({
    store,
    contentStore,
    workspaceLeases,
    attachments,
    attachmentAuthority,
    revokeManagedTerminals,
    control: host.value.control,
    activeView: runtime,
    validateWorkspacePath: (requestedPath, allowedWorkspaceRoots) =>
      validateWorkspaceLeasePath({ requestedPath, allowedWorkspaceRoots, dataDir: deps.dataDir }),
    resolveMaxConcurrentRuns: (serviceInstanceId) => limitsByInstance.get(serviceInstanceId)?.maxConcurrentRuns,
    ids: { forOperation: operationIds, forManagedRun: controlIds },
    nowMs: () => deps.clock.now(),
    eventBus: deps.eventBus,
    logger: deps.logger,
  });
  const recoverySnapshotMs = deps.clock.now();
  const recovered = await recoverAllPreparations(
    activationCoordinator,
    recoverySnapshotMs,
    deps.config.recoveryBatchSize,
  );
  if (!recovered.ok) {
    await runtime.shutdown();
    logSetupFailure(deps, "managed-run-recovery", "internal");
    return recovered;
  }
  const attachmentRecovered = await attachmentAuthority.reconcileAll({
    updatedBeforeMs: recoverySnapshotMs,
    limit: deps.config.recoveryBatchSize,
  });
  if (!attachmentRecovered.ok) {
    await runtime.shutdown();
    logSetupFailure(deps, "execution-attachment-recovery", "internal");
    return attachmentRecovered;
  }
  const purged = await purgeAllExpiredContent(
    contentStore,
    recoverySnapshotMs,
    deps.config.recoveryBatchSize,
  );
  if (!purged.ok) {
    await runtime.shutdown();
    logSetupFailure(deps, "managed-run-content-purge", "internal");
    return purged;
  }

  deps.logger.info({
    activeCount: activated.value.instances.filter((instance) => instance.state === "active").length,
    failedCount: activated.value.instances.filter((instance) => instance.state === "failed").length,
    recoveredCount: recovered.value.activated.length,
    cancelledCount: recovered.value.cancelled.length,
    unknownCount: recovered.value.unknown.length,
    recoveredAttachmentCount: attachmentRecovered.value.recovered.length,
    preservedAttachmentCount: attachmentRecovered.value.preserved.length,
    purgedContentCount: purged.value,
    durationMs: Math.max(0, deps.clock.now() - startedAtMs),
  }, "Capability-service platform setup completed");

  const cancellationCoordinator = createManagedRunCancellationCoordinator({
    store,
    control: host.value.control,
    eventBus: deps.eventBus,
    nowMs: () => deps.clock.now(),
  });

  let stopped = false;
  return ok(Object.freeze({
    plan: plan.value,
    runtime,
    store,
    contentStore,
    workspaceLeases,
    attachments,
    attachmentAuthority,
    control: host.value.control,
    activationCoordinator,
    cancellationCoordinator,
    reportBridge,
    evidenceBridge,
    recoverySummary: recovered.value,
    attachmentRecoverySummary: attachmentRecovered.value,
    purgedContentCount: purged.value,
    bindTerminalRevoker: (revoker: ManagedTerminalRevoker) => { terminalRevoker = revoker; },
    shutdown: async () => {
      if (stopped) return ok(undefined);
      stopped = true;
      const result = await runtime.shutdown();
      return result.ok
        ? ok(undefined)
        : err(new Error(`capability-service shutdown failed for ${result.error.cleanupFailures.length} instance(s)`));
    },
  }));
}
