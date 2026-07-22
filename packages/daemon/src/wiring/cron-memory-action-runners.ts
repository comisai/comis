// SPDX-License-Identifier: Apache-2.0
/** Owning-service adapters for the three config-owned cron memory actions. */
import type {
  AppContainer,
  ClockPort,
  ComisLogger,
  ContextBrowsePort,
  ContextStorePort,
  MemoryCausalStore,
  MemoryEntityStore,
  MemoryLifecyclePort,
  MemoryPort,
  SessionStorePort,
} from "@comis/core";
import { tryGetContext } from "@comis/core";
import {
  classifyError,
  classifyReflectOutcome,
  createLlmReflectionAdapter,
  PROCEDURE_REFLECT_PROMPT,
  PROFILE_REFLECT_PROMPT,
  REFLECT_PROMPT,
  runMemoryReview,
  runReflection,
  TOPIC_REFLECT_PROMPT,
  type AuthStorage,
  type ReflectionSourceTrajectory,
} from "@comis/agent";
import type { MemoryApi } from "@comis/memory";
import { err, ok } from "@comis/shared";
import { buildReviewSessionSource } from "./setup-channels/review-session-source.js";
import {
  cronCredentialSkipHint,
  cronCustomModelOpt,
  resolveCronJobCredential,
} from "./setup-channels/setup-channels-cron-credential.js";
import type { ReflectionCronDeps } from "./setup-channels/setup-channels-skill-synthesis-deps.js";
import { resolveMemoryOpsCapability } from "./setup-channels/resolve-memory-ops-capability.js";
import type {
  CronActionServiceError,
  CronKeylessActionRequest,
  CronModelActionRequest,
  CronMemoryActionServicesDeps,
} from "./cron-memory-action-services.js";

export interface CronMemoryActionRunnerDeps {
  container: AppContainer;
  tenantId: string;
  clock: ClockPort;
  logger: ComisLogger;
  workspaceDirs: ReadonlyMap<string, string>;
  memoryAdapter: MemoryPort;
  sessionStore: Pick<SessionStorePort, "listDetailed" | "loadByRef">;
  lcdStore?: Pick<ContextStorePort, "getMessages">;
  contextBrowse?: ContextBrowsePort;
  entityStore?: MemoryEntityStore;
  causalStore?: MemoryCausalStore;
  memoryLifecycleStore?: MemoryLifecyclePort;
  memoryApi?: Pick<MemoryApi, "inspect">;
  reflection?: ReflectionCronDeps;
  authStorages?: ReadonlyMap<string, Pick<AuthStorage, "read">>;
  resolveAccessToken?: (agentId: string, provider: string) => Promise<string | undefined>;
}

export type CronMemoryActionRunners = Pick<
  CronMemoryActionServicesDeps,
  "executeMemoryReview" | "executeMemoryLifecycle" | "executeReflection"
>;

export function createCronMemoryActionRunners(
  deps: CronMemoryActionRunnerDeps,
): CronMemoryActionRunners {
  return {
    executeMemoryReview,
    executeMemoryLifecycle,
    executeReflection,
  };

  async function executeMemoryReview(
    request: CronModelActionRequest,
  ): Promise<ReturnType<CronMemoryActionServicesDeps["executeMemoryReview"]> extends Promise<infer T> ? T : never> {
    const agentId = request.input.job.agentId;
    const agentConfig = deps.container.config.agents[agentId];
    const config = agentConfig?.memoryReview;
    if (!agentConfig || !config) return err(serviceError("config", "Memory review configuration is unavailable"));
    const credential = await resolveCronJobCredential(
      deps.container,
      agentId,
      request.resolution.provider,
      deps.authStorages?.get(agentId),
      deps.resolveAccessToken,
    );
    if (credential.source === "none") {
      deps.logger.warn({
        agentId,
        provider: request.resolution.provider,
        errorKind: "config" as const,
        hint: cronCredentialSkipHint(credential, request.resolution.provider, "memory review"),
      }, "Cron memory review credential is unavailable");
      return err(serviceError("config", "Memory review credential is unavailable"));
    }
    const context = tryGetContext();
    if (
      context?.rootRunId !== request.input.rootRunId
      || context.agentId !== agentId
      || context.turnScope === undefined
    ) {
      return err(serviceError("precondition", "Memory review cron context is unavailable or mismatched"));
    }
    const providerEntry = deps.container.config.providers?.entries?.[request.resolution.provider];
    const result = await runMemoryReview({
      agentId,
      tenantId: deps.tenantId,
      agentName: agentConfig.name ?? agentId,
      config,
      memoryPort: deps.memoryAdapter,
      memoryScope: {
        turnScope: context.turnScope,
        visibility: { kind: "agent-shared" },
        operatorPermission: {
          kind: "operator-memory-visibility",
          tenantId: deps.tenantId,
          agentId,
        },
      },
      ...resolveMemoryOpsCapability(request.resolution, providerEntry?.capabilities),
      sessionStore: buildReviewSessionSource({
        sessionStore: deps.sessionStore,
        lcdStore: deps.lcdStore,
        contextBrowse: deps.contextBrowse,
      }),
      eventBus: deps.container.eventBus,
      workspacePath: deps.workspaceDirs.get(agentId) ?? "",
      provider: request.resolution.provider,
      modelId: request.resolution.modelId,
      ...(credential.apiKey === undefined ? {} : { apiKey: credential.apiKey }),
      ...(credential.providerEnv === undefined ? {} : { providerEnv: credential.providerEnv }),
      ...cronCustomModelOpt(providerEntry, request.resolution.provider, request.resolution.modelId),
      clock: deps.clock,
      entityStore: deps.entityStore,
      causalStore: deps.causalStore,
      signal: request.signal,
      onUsage: request.onUsage,
      logger: deps.logger.child({ agentId, submodule: "memory-review" }),
    });
    if (!result.ok) {
      return ok({ status: "failed", errorKind: modelActionErrorKind(result.error), counters: [] });
    }
    return ok({ status: "completed", counters: [] });
  }

  async function executeMemoryLifecycle(
    request: CronKeylessActionRequest,
  ): Promise<ReturnType<CronMemoryActionServicesDeps["executeMemoryLifecycle"]> extends Promise<infer T> ? T : never> {
    const agentId = request.input.job.agentId;
    const agentConfig = deps.container.config.agents[agentId];
    if (deps.memoryLifecycleStore === undefined) {
      return err(serviceError("config", "Memory lifecycle store is unavailable"));
    }
    if (request.signal.aborted) return err(serviceError("timeout", "Memory lifecycle was cancelled"));
    const learning = agentConfig?.learning;
    const policy = learning?.enabled
      ? { evictionEnabled: true, failureEvictionFloor: learning.forget?.failureEvictionFloor }
      : undefined;
    const result = await deps.memoryLifecycleStore.runLifecycleSweep({
      tenantId: deps.tenantId,
      agentId,
      now: deps.clock.now(),
      ...(policy === undefined ? {} : { policy }),
    });
    if (!result.ok) return ok({ status: "failed", errorKind: "internal", counters: [] });
    const value = result.value;
    deps.container.eventBus.emit("learning:memory_demoted", { agentId, count: value.demoted, timestamp: deps.clock.now() });
    deps.container.eventBus.emit("learning:memory_evicted", { agentId, count: value.evicted, timestamp: deps.clock.now() });
    deps.container.eventBus.emit("learning:lifecycle_swept", { agentId, ...value, timestamp: deps.clock.now() });
    return ok({
      status: "completed",
      counters: [
        { name: "scanned", value: value.scanned },
        { name: "promoted", value: value.promoted },
        { name: "demoted", value: value.demoted },
        { name: "evicted", value: value.evicted },
      ],
    });
  }

  async function executeReflection(
    request: CronModelActionRequest,
  ): Promise<ReturnType<CronMemoryActionServicesDeps["executeReflection"]> extends Promise<infer T> ? T : never> {
    const agentId = request.input.job.agentId;
    const agentConfig = deps.container.config.agents[agentId];
    const config = agentConfig?.learning;
    if (!agentConfig || !config || deps.reflection === undefined) {
      return err(serviceError("config", "Reflection configuration or storage is unavailable"));
    }
    const credential = await resolveCronJobCredential(
      deps.container,
      agentId,
      request.resolution.provider,
      deps.authStorages?.get(agentId),
      deps.resolveAccessToken,
    );
    if (credential.source === "none") {
      deps.logger.warn({
        agentId,
        provider: request.resolution.provider,
        errorKind: "config" as const,
        hint: cronCredentialSkipHint(credential, request.resolution.provider, "reflection"),
      }, "Cron reflection credential is unavailable");
      return err(serviceError("config", "Reflection credential is unavailable"));
    }

    const kinds: ReadonlyArray<{
      kind: "skill" | "profile" | "topic";
      systemPrompt: string;
      source: "learned_skill_reflection" | "learned_profile_reflection" | "learned_topic_reflection" | "learned_procedure_reflection";
      groupKey?: (trajectory: ReflectionSourceTrajectory) => string;
      populateProcedureMetadata?: boolean;
    }> = [
      { kind: "skill", systemPrompt: REFLECT_PROMPT, source: "learned_skill_reflection" },
      { kind: "profile", systemPrompt: PROFILE_REFLECT_PROMPT, source: "learned_profile_reflection", groupKey: (trajectory) => trajectory.sender },
      { kind: "topic", systemPrompt: TOPIC_REFLECT_PROMPT, source: "learned_topic_reflection" },
      {
        kind: "skill",
        systemPrompt: PROCEDURE_REFLECT_PROMPT,
        source: "learned_procedure_reflection",
        groupKey: (trajectory) => trajectory.procedureDescriptor?.key ?? "",
        populateProcedureMetadata: true,
      },
    ];
    const totals = emptyReflectionTotals();
    let failedPasses = 0;
    for (const pass of kinds) {
      if (request.signal.aborted) return err(serviceError("timeout", "Reflection was cancelled"));
      const adapter = createLlmReflectionAdapter({
        provider: request.resolution.provider,
        modelId: request.resolution.modelId,
        ...(credential.apiKey === undefined ? {} : { apiKey: credential.apiKey }),
        ...(credential.providerEnv === undefined ? {} : { providerEnv: credential.providerEnv }),
        clock: deps.clock,
        logger: deps.logger.child({ agentId, submodule: "reflection", reflectKind: pass.kind }),
        systemPrompt: pass.systemPrompt,
        source: pass.source,
        signal: request.signal,
        onUsage: request.onUsage,
        ...cronCustomModelOpt(
          deps.container.config.providers?.entries?.[request.resolution.provider],
          request.resolution.provider,
          request.resolution.modelId,
        ),
      });
      const sources = await deps.reflection.buildSourceTrajectories(pass.kind, agentId, deps.tenantId);
      const result = await runReflection({
        agentId,
        tenantId: deps.tenantId,
        scope: { tenantId: deps.tenantId, agentId },
        kind: pass.kind,
        ...(pass.groupKey === undefined ? {} : { groupKey: pass.groupKey }),
        ...(pass.populateProcedureMetadata === undefined ? {} : { populateProcedureMetadata: pass.populateProcedureMetadata }),
        config: {
          enabled: config.enabled,
          minConfidence: config.reflect.minConfidence,
          maxDocsPerRun: config.reflect.maxDocsPerRun,
          corroboration: config.reflect.corroboration,
        },
        sourceTrajectories: sources,
        signal: request.signal,
        reflectionAdapter: adapter,
        outcomeSignal: deps.reflection.outcomeSignal,
        mentalModelStore: deps.reflection.learnedSkillStore,
        clock: deps.clock,
        logger: deps.logger.child({ agentId, submodule: "reflection", reflectKind: pass.kind }),
        eventBus: deps.container.eventBus,
      });
      if (!result.ok) {
        failedPasses += 1;
        continue;
      }
      addReflectionTotals(totals, result.value);
    }
    const admissionOutcome = classifyReflectOutcome(totals);
    deps.container.eventBus.emit("reflect:admitted", { agentId, count: totals.admitted, timestamp: deps.clock.now() });
    deps.container.eventBus.emit("reflect:funnel", {
      agentId,
      synthesized: totals.selected,
      validated: totals.admitted,
      admitted: totals.admitted,
      maxClusterCardinality: totals.maxTopicCardinality,
      singleOwnerCorroborated: totals.singleOwnerCorroborated,
      distinctTopicKeys: totals.distinctTopicKeys,
      untrustedDrops: totals.untrustedDrops,
      nameLengthRejections: totals.nameLengthRejections,
      skipped: totals.skipped,
      sourceTrajectoryCount: totals.sourceTrajectoryCount,
      totalSourceChars: totals.totalSourceChars,
      admissionOutcome,
      timestamp: deps.clock.now(),
    });
    const counters = reflectionCounters(totals, failedPasses);
    return failedPasses > 0
      ? ok({ status: "failed", errorKind: "dependency", counters })
      : ok({ status: "completed", counters });
  }
}

interface ReflectionTotals {
  selected: number;
  admitted: number;
  maxTopicCardinality: number;
  singleOwnerCorroborated: number;
  distinctTopicKeys: number;
  skipped: number;
  emptyReflections: number;
  untrustedDrops: number;
  nameLengthRejections: number;
  sourceTrajectoryCount: number;
  totalSourceChars: number;
}

function emptyReflectionTotals(): ReflectionTotals {
  return {
    selected: 0, admitted: 0, maxTopicCardinality: 0,
    singleOwnerCorroborated: 0, distinctTopicKeys: 0, skipped: 0,
    emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0,
    sourceTrajectoryCount: 0, totalSourceChars: 0,
  };
}

function addReflectionTotals(totals: ReflectionTotals, value: ReflectionTotals): void {
  totals.selected += value.selected;
  totals.admitted += value.admitted;
  totals.maxTopicCardinality = Math.max(totals.maxTopicCardinality, value.maxTopicCardinality);
  totals.singleOwnerCorroborated += value.singleOwnerCorroborated;
  totals.distinctTopicKeys += value.distinctTopicKeys;
  totals.skipped += value.skipped;
  totals.emptyReflections += value.emptyReflections;
  totals.untrustedDrops += value.untrustedDrops;
  totals.nameLengthRejections += value.nameLengthRejections;
  totals.sourceTrajectoryCount += value.sourceTrajectoryCount;
  totals.totalSourceChars += value.totalSourceChars;
}

function reflectionCounters(totals: ReflectionTotals, failedPasses: number) {
  return [
    { name: "selected", value: totals.selected },
    { name: "admitted", value: totals.admitted },
    { name: "skipped", value: totals.skipped },
    { name: "empty_reflections", value: totals.emptyReflections },
    { name: "untrusted_drops", value: totals.untrustedDrops },
    { name: "name_length_rejections", value: totals.nameLengthRejections },
    { name: "max_topic_cardinality", value: totals.maxTopicCardinality },
    { name: "single_owner_corroborated", value: totals.singleOwnerCorroborated },
    { name: "distinct_topic_keys", value: totals.distinctTopicKeys },
    { name: "source_trajectories", value: totals.sourceTrajectoryCount },
    { name: "source_chars", value: totals.totalSourceChars },
    { name: "failed_passes", value: failedPasses },
  ] as const;
}

function modelActionErrorKind(error: Error): CronActionServiceError["errorKind"] {
  const category = classifyError(error).category;
  switch (category) {
    case "prompt_timeout": return "timeout";
    case "auth_invalid":
    case "aws_auth_invalid":
    case "aws_auth_expired": return "auth";
    case "client_request":
    case "client_request_signed_replay":
    case "tool_schema_unsupported":
    case "context_too_long": return "validation";
    case "credit_exhausted": return "resource";
    case "rate_limited":
    case "aws_model_access":
    case "aws_region_or_model":
    case "overloaded":
    case "content_filtered":
    case "empty_response":
    case "model_not_available":
    case "provider_unreachable": return "dependency";
    case "unknown": return "internal";
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

function serviceError(
  errorKind: CronActionServiceError["errorKind"],
  message: string,
): CronActionServiceError {
  return { errorKind, message };
}
