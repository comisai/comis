// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC dispatcher boundary itself (line 304 unknown-method + line 320 re-throw); the re-throw IS the JSON-RPC error path -- gateway/method-router catches and converts to JSON-RPC error response.
/**
 * Central RPC dispatch router.
 * Merges all 14 domain handler modules into a single dispatch function
 * that routes method names to the correct handler.
 *
 * The aggregator dependency type is `ApiDispatchDeps`, defined in
 * `./types.js` as the union of 11 per-domain `*ApiDeps` cluster slices.
 * This file re-exports it for call-site convenience and never duplicates
 * the field set inline.
 * @module
 */

import type { ErrorKind } from "@comis/infra";
import type { RpcCall } from "@comis/skills/platform-tools";

import type { ApiDispatchDeps } from "./types.js";
export type { ApiDispatchDeps };

import {
  classifyTypedRpcError,
  API_CONTRACTS_ORDERED,
  HANDLER_CAPABILITY_MAP,
  CapabilityDeniedError,
  parseFormattedSessionKey,
  // Phase 217-05 (the keystone): the never-hang mode-aware deny decision.
  // resolveEffectiveMode = the EVICT-02 fail-closed primitive (Plan 01);
  // resolveAutonomy = the jail-leg server-side mode resolve (Plan 03); systemNowMs
  // = the execution:aborted timestamp (mirrors bridge-safety-controls.ts).
  resolveEffectiveMode,
  resolveAutonomy,
  systemNowMs,
  type AutonomyMode,
} from "@comis/core";
// ORIGIN-01 deny-by-origin chokepoint: the in-process agent loop dispatches
// straight through this closure (bypassing the gateway scope-router's
// checkScope), so the positive control-plane boundary MUST live here in the
// dispatch closure — the convergence point of the in-process and gateway legs.
import { assertNotAgentOrigin } from "./shared/assert-not-agent-origin.js";
// AUDIT-01 (Phase 215): the per-cap audit emitter — emits audit:event (the
// durable AUDIT-02 trail) + capability:audited (the spawn-tree producer) for an
// allowed AND a denied gated call at THIS chokepoint. The in-process leg has no
// lease (G1): rootRunId via resolveRootRunId, leaseId honestly absent.
import { emitCapabilityAudit } from "./shared/emit-capability-audit.js";

import { createCronHandlers } from "./cron-handlers.js";
import { createMemoryHandlers } from "./memory-handlers.js";
// memory.ask extracted from memory-handlers.ts for the file-size cap — composed
// HERE (handler files never import each other; daemon architecture invariant).
import { bindMemoryAskHandler } from "./memory-ask-handlers.js";
import { createContextHandlers } from "./context-handlers.js";
// Memory sub-handlers extracted from memory-handlers.ts for the file-size cap.
// Composed here (not via memory-handlers.ts importing them) so handler files
// stay siblings — see the "*-handlers.ts never imports another *-handlers.ts"
// architecture invariant in __tests__/architecture.test.ts.
import { createMemoryPortabilityHandlers } from "./memory-portability-handlers.js";
import { createMemoryPinningHandlers } from "./memory-pinning-handlers.js";
import { createSessionHandlers } from "./session-handlers/index.js";
import { createMessageHandlers } from "./message-handlers.js";
import { createMediaHandlers } from "./media-handlers.js";
import { createConfigHandlers } from "./config-handlers/index.js";
import { createEnvHandlers } from "./env-handlers.js";
import { createSecretsHandlers } from "./secrets-handlers.js";
import { createAuthHandlers } from "./auth-handlers.js";
import { createBrowserHandlers } from "./browser-handlers.js";
import { createSubagentHandlers } from "./subagent-handlers.js";
// Phase 213-06 (REVOKE-01/03): the operator-facing live-control RPC handlers.
// lease.revoke / run.kill are scopes:["admin"] (Plan 03) → ADMIN_METHODS →
// deny-by-origin is automatic via the chokepoint below (no manual _agentId check
// in the handler). They drive the LeaseManager revoke fan-outs + the runner's
// killByRootRun.
import { createAutonomyHandlers } from "./autonomy-handlers.js";
// INTRO-01/02 (Phase 215-04): capabilities.introspect — the read-only,
// agent-reachable `comis whoami` surface. scopes:["rpc"] + "ungated" (NO
// requireCapability, NOT in ADMIN_METHODS), self-scoped to the caller's
// _agentId. Gated on deps.boundedAutonomy being wired (the snapshot source).
import { createCapabilitiesHandlers } from "./capabilities-handlers.js";
import { createApprovalHandlers } from "./approval-handlers.js";
import { createAgentHandlers } from "./agent-handlers.js";
import { createObsHandlers } from "./obs-handlers/index.js";
import { createCacheHandlers } from "./cache-handlers.js";
import { createModelHandlers } from "./model-handlers.js";
import { createChannelHandlers } from "./channel-handlers.js";
import { createTokenHandlers } from "./token-handlers.js";
import { createDaemonHandlers } from "./daemon-handlers.js";
import { createMcpHandlers } from "./mcp-handlers.js";
import { createMcpOauthHandlers } from "./mcp-oauth-handlers.js";
import { createGraphHandlers } from "./graph-handlers/index.js";
// AUTHOR-01 (Phase 174-03): the daemon composition site is the boundary-clean
// place to import @comis/agent and inject the conservative repair matcher into
// the graph handlers (buildGraphInput receives it via deps.repairMatch — never a
// direct daemon→agent import in the pure helper).
import { matchRawGraphToTemplate, capabilityClassFromProvider } from "@comis/agent";
import { createWorkspaceHandlers } from "./workspace-handlers.js";
import { createHeartbeatHandlers } from "./heartbeat-handlers.js";
import { createSkillHandlers } from "./skill-handlers.js";
import { createNotificationHandlers } from "./notification-handlers.js";
import { createImageHandlers } from "./image-handlers.js";
import { createVideoHandlers } from "./video-handlers.js";
import { createVideoStatusHandlers } from "./video-status-handlers.js";
import { createProviderHandlers } from "./provider-handlers.js";

// ---------------------------------------------------------------------------
// Aggregator type
// ---------------------------------------------------------------------------
//
// `ApiDispatchDeps` lives in `./types.js` as the union of 11 per-domain
// `*ApiDeps` cluster slices. It is re-exported at the top of this file for
// call-site convenience. The field set is partitioned across SessionsApiDeps,
// MemoryApiDeps, ChannelsApiDeps, AgentsApiDeps, OrchestratorApiDeps,
// WorkspaceApiDeps, ConfigApiDeps, AuthApiDeps, MediaApiDeps,
// ObservabilityApiDeps, DaemonApiDeps.
//
// Any remaining legacy `*HandlerDeps` interfaces in api/*-handlers.ts are
// assignable from ApiDispatchDeps via structural subtyping.

// ---------------------------------------------------------------------------
// WR-04: media methods whose params carry a large base64/binary payload
// (`source`/`image`/`video`/`audio`/`file`). The dispatcher error log writes
// `params` for triage, but Pino's key-name redaction does NOT cover these
// fields, so on a throw branch the whole image/video/audio body would land in
// the daemon log — a content-hygiene violation (never log message bodies). For
// these methods, omit the binary fields before logging; the method name + the
// remaining small params still aid diagnosis.
// ---------------------------------------------------------------------------

const BINARY_PARAM_METHODS = new Set<string>([
  "image.analyze",
  "media.test.vision",
  "media.test.video",
  "media.test.document",
  "media.test.stt",
  "audio.transcribe",
]);

/** The large binary param keys stripped from the log payload for the methods above. */
const BINARY_PARAM_KEYS = ["source", "image", "video", "audio", "file"] as const;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an RPC error for structured logging.
 *
 * Returns an ErrorKind, an actionable hint, AND a `level` (`"warn" | "error"`) that the
 * dispatcher uses to pick `logger.warn` vs `logger.error`. The goal is to keep operator
 * alerts meaningful: caller mistakes / policy / security refusals (`PreconditionError`,
 * `ValidationError`, `AuthorizationError`, `RequiredToolsUnreachableError`,
 * `SandboxDowngradeError`) are warn-level; unmatched cases fall through to `error/internal`.
 *
 * The typed-refusal → kind/hint/level mapping lives in `@comis/core`
 * ({@link classifyTypedRpcError}) as the SINGLE source of truth, because the SAME error is
 * ALSO classified by the `@comis/gateway` method-router trace wrapper — which cannot
 * `instanceof` these classes (dependency direction) and so keys off `Error.name`. Before
 * that shared classifier the two layers drifted and the gateway kept logging intentional
 * refusals as internal/ERROR after this layer was fixed (OBS-RPC-REFUSAL-CLASS,
 * orchestration-excellence-20260701). **Add a new typed refusal in `@comis/core`, not
 * here.** The legacy substring-match fallbacks remain deleted; typed errors are the
 * sanctioned path (OBS-10: admin-trust denials throw `AuthorizationError`; bare-Error
 * handlers still classify internal/error until migrated to a typed class).
 */
export function classifyRpcError(err: unknown): { errorKind: ErrorKind; hint: string; level: "warn" | "error" } {
  const typed = classifyTypedRpcError(err);
  if (typed) return typed;
  return { errorKind: "internal", hint: "Check the RPC method handler and its dependencies", level: "error" };
}

// ---------------------------------------------------------------------------
// ORIGIN-01 deny-by-origin: the authoritative admin-method set.
// ---------------------------------------------------------------------------
//
// Derived ONCE from the contract registry (`scopes.includes("admin")`) — the
// single source of truth for the ~146 admin-scoped control-plane methods. This
// is drift-proof: a NEW admin contract is automatically covered by the
// chokepoint below; there is NO hand-maintained method list to fall out of
// sync. The chokepoint (in the dispatch closure) calls `assertNotAgentOrigin`
// for exactly the methods in this set, so an agent-origin (`_agentId`-bearing)
// call can never reach an admin handler, INDEPENDENT of its ALS `_trustLevel`
// (v8 §3.1 / §22.3 floor item 1). Non-admin methods are NOT in this set, so an
// agent's own `_agentId` rides them untouched for self-scoping (Pitfall 2).
const ADMIN_METHODS: ReadonlySet<string> = new Set(
  API_CONTRACTS_ORDERED.filter((c) => c.scopes.includes("admin")).map((c) => c.method),
);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the central RPC dispatch function.
 * Merges all 14 domain handler maps into a single lookup table and returns
 * an async function that routes method names to the correct handler.
 * @param deps - Superset of all handler dependencies
 * @returns RpcCall function that dispatches to domain handlers
 */
export function createRpcDispatch(deps: ApiDispatchDeps): RpcCall {
  // Build handler maps from each domain factory
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    ...createCronHandlers(deps),
    ...createMemoryHandlers(deps),
    ...bindMemoryAskHandler(deps),
    // context.* operator-browse RPCs (conversations + tree). Shares the
    // MemoryApiDeps slice; lcdStore + contextBrowse ride deps from setup-memory.
    ...createContextHandlers(deps),
    ...createMemoryPortabilityHandlers(deps),
    ...createMemoryPinningHandlers(deps),
    ...createSessionHandlers(deps),
    ...createMessageHandlers(deps),
    ...createMediaHandlers(deps),
    // Thread the daemon-level OAuth credential store into config.patch's
    // credential guard so model/provider patches on OAuth-only providers
    // (e.g. openai-codex) can resolve via Source C
    // (agents.<id>.oauthProfiles -> ~/.comis/auth-profiles.json). Explicit
    // pass-through mirrors the createAgentHandlers wiring below; do not
    // simplify back to `...createConfigHandlers(deps)` (the structural-typing
    // inheritance is fragile to future deps-shape narrowing).
    //
    // Wire auditEnabled from diagnostics.configAudit.enabled. Default-true
    // semantics via the `!== false` check preserves the schema's
    // default-true contract; operators who omit the knob (undefined via
    // optional-chain) or explicitly set true see the audit line; only an
    // explicit `enabled: false` skips the JSONL append in config-write.ts.
    ...createConfigHandlers({
      ...deps,
      oauthCredentialStore: deps.oauthCredentialStore,
      auditEnabled:
        deps.container.config.diagnostics?.configAudit?.enabled !== false,
    }),
    ...createEnvHandlers(deps),
    // Encrypted secret management. Admin scope is enforced both at
    // registration (setup-gateway-api.ts) and inside each handler
    // (params._trustLevel === "admin" check).
    ...createSecretsHandlers(deps),
    // Encrypted OAuth-profile management. Admin scope enforced at
    // registration + per-handler. The un-projected OAuthProfile[] (with
    // access/refresh/accountId) lives in handler closure scope ONLY; the
    // projection strips tokens before the RPC response. See
    // api/auth-handlers.ts. Spread `...deps` so the auth cluster slice's
    // required fields (tokenRegistry, addToTokenStore, removeFromTokenStore)
    // are present alongside the auth-specific narrow wiring.
    ...createAuthHandlers({
      ...deps,
      oauthCredentialStore: deps.oauthCredentialStore,
      container: deps.container,
      logger: deps.logger,
    }),
    ...createBrowserHandlers(deps),
    ...createSubagentHandlers(deps),
    // Phase 213-06: lease.revoke + run.kill. Gated on deps.leaseManager being
    // wired (Plan 07 constructs it at the composition root); subAgentRunner +
    // logger ride the OrchestratorApiDeps slice. Deny-by-origin fires in the
    // dispatch chokepoint below for these admin-scoped methods (no manual check).
    // When leaseManager is absent (a partial boot) the methods are simply not
    // registered — the dispatcher's unknown-method path handles a stray call.
    ...(deps.leaseManager
      ? createAutonomyHandlers({
          ...deps,
          leaseManager: deps.leaseManager,
          // FLEET-03: the LIVE autonomy:revoked/killed bus (the same typed bus the
          // execution:aborted emit uses below, ~:678) + systemNowMs as the
          // wiring-layer clock (globals-gate-safe; no Date.now() here). Without
          // this the handler's optional eventBus? is absent in prod → the daemon
          // emits nothing → Plan 03's counts are silently zero.
          eventBus: deps.container.eventBus,
          now: systemNowMs,
        })
      : {}),
    // INTRO-01/02 (Phase 215-04): capabilities.introspect (the `comis whoami`
    // read). Gated on deps.boundedAutonomy (the remaining-budget snapshot
    // source, Plan 02). The handler resolves the CALLER's per-agent
    // AutonomyConfig itself from deps.agents (caps are per-caller; the handler is
    // built once) — do NOT pre-resolve a single config at wiring time. It is
    // scopes:["rpc"] + "ungated" (no requireCapability, NOT in ADMIN_METHODS) so
    // the agent reaches it; the spread closes the contract↔handler parity gate
    // via [CapabilitiesIntrospectContract.method] in the SAME wave the handler +
    // codegen land (the 188 BLOCKER-1 same-wave rule).
    // Finding E (30uc-20260624): register UNCONDITIONALLY (no longer gated on deps.boundedAutonomy).
    // When no autonomy agent is wired, the handler returns a clean disabled-state ({enabled:false,
    // caps:[]}) — `comis whoami` / capabilities.introspect must never be "Unknown RPC method".
    // The budget snapshot is omitted when boundedAutonomy is absent (handler guards it).
    ...createCapabilitiesHandlers({
      boundedAutonomy: deps.boundedAutonomy,
      resolveRootRunId: deps.resolveRootRunId,
      agents: deps.agents,
      defaultAgentId: deps.defaultAgentId,
      logger: deps.logger,
    }),
    ...((deps.graphCoordinator || deps.namedGraphStore) ? createGraphHandlers({
      // Handler factory consumes OrchestratorApiDeps (narrowed to require
      // graphCoordinator). Spread `...deps` so broader slice fields
      // (cronSchedulers, executionTrackers, etc.) are present alongside the
      // narrow per-graph wiring below. The non-null assertion on
      // graphCoordinator preserves the long-standing behavior: graph.list /
      // save / load handlers can run with only namedGraphStore set, but
      // graph.execute / status / cancel handlers crash at runtime.
      ...deps,
      graphCoordinator: deps.graphCoordinator!,
      defaultAgentId: deps.defaultAgentId,
      securityConfig: deps.securityConfig,
      logger: deps.logger,
      namedGraphStore: deps.namedGraphStore,
      tenantId: deps.tenantId,
      dataDir: deps.container.config.dataDir || ".",
      nodeTypeRegistry: deps.nodeTypeRegistry,
      // TELEM-01 (Phase 173-02): construct the per-agent capabilityClass
      // resolver for the daemon-side `pipeline:authored` emit. Resolve the tier
      // server-side from the agent's provider (deps.agents[agentId].provider →
      // getProviderCapabilityClass) — NEVER a tool-supplied param (Spoofing
      // mitigation T-173-03). Constructing it HERE (not just typing it) is the
      // load-bearing guard against the 172-WR-02 silent-dead-metric class
      // (T-173-13): without this line every emit fail-defaults to "unknown".
      resolveCapabilityClass: (agentId) =>
        // IN-02 (Phase 173 review): a dynamic-key READ (not a write) on the typed
        // Record<string, PerAgentConfig>; the key is the server-trusted agentId.
        // A key like "__proto__" returns the prototype's `provider` (undefined) →
        // fail-safes to "unknown", never a pollution write. No eslint-disable is
        // needed (unlike the sibling object-injection sites): security/detect-
        // object-injection does NOT flag a logical-expression key (`agentId ?? ""`),
        // so adding the directive here is reported as unused — this plain comment
        // documents the intentional safe read instead.
        //
        // TELEM-01 fix (2026-06-19): fall back to the provider-family heuristic when no operator
        // `providers.entries.<p>.capabilities.capabilityClass` override is pinned. Without this
        // fallback the override-only resolver returned undefined for every un-pinned config (the
        // common case), so `pipeline:authored` always emitted capabilityClass:"unknown" and P1's
        // small-model-authoring-rate metric was dead. The heuristic (anthropic/openai→frontier,
        // google→mid, else→small) is the same one the executor's live ModelProfile derives.
        (() => {
          const provider = deps.agents[agentId ?? ""]?.provider;
          return deps.getProviderCapabilityClass?.(provider) ?? capabilityClassFromProvider(provider);
        })(),
      // AUTHOR-01 (Phase 174-03): thread the orchestration.authoring gate +
      // inject the conservative repair matcher. The daemon→agent boundary is
      // crossed HERE (the composition site legitimately imports @comis/agent),
      // never inside buildGraphInput — mirroring the resolveCapabilityClass
      // injection above. With repairProducer:false (the default) the gate is off
      // and buildGraphInput is byte-identical to pre-174.
      authoringConfig: deps.container.config.orchestration?.authoring,
      repairMatch: matchRawGraphToTemplate,
    }) : {}),
    // approval-handlers consumes WorkspaceApiDeps; spread `...deps` so the
    // cluster slice's required fields (e.g. mcpClientManager, execGit,
    // container) are present alongside the guarded approvalGate.
    ...(deps.approvalGate ? createApprovalHandlers({ ...deps, approvalGate: deps.approvalGate }) : {}),
    ...createAgentHandlers({
      ...deps,
      secretManager: deps.container?.secretManager,
      providerEntries: deps.container.config.providers.entries,
      // Thread the daemon-level OAuth credential store into agents.update
      // so the oauthProfiles existence check can run via has(). When unset
      // (e.g. unwired test setups) the validation block in agent-handlers
      // becomes a no-op.
      oauthCredentialStore: deps.oauthCredentialStore,
      // Resolves `provider: "default"` to `models.defaultProvider` in the
      // credential check, mirroring `resolveAgentModel` runtime resolution.
      modelsConfig: deps.container.config.models,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    // provider-handlers consumes AgentsApiDeps; spread `...deps` so required
    // slice fields (suspendedAgents, modelCatalog) are present alongside the
    // explicit provider-handler wiring.
    ...createProviderHandlers({
      ...deps,
      agents: deps.agents,
      providerEntries: deps.container.config.providers.entries,
      secretManager: deps.container?.secretManager,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createObsHandlers(deps),
    // Durable cache-stats window aggregator. Distinct from obs-handlers
    // (in-memory) — reads from `obs_token_usage` SQLite.
    ...createCacheHandlers(deps),
    ...createModelHandlers({
      ...deps,
      providerEntries: deps.container.config.providers.entries,
    }),
    ...createChannelHandlers({
      ...deps,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createTokenHandlers({
      ...deps,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    // mcp-handlers consumes WorkspaceApiDeps; spread `...deps` so cluster
    // slice's required fields (e.g. execGit, approvalGate-bearer-context)
    // are present alongside the mcp-specific wiring.
    ...createMcpHandlers({
      ...deps,
      mcpClientManager: deps.mcpClientManager,
      logger: deps.logger,
      // Thread the same token-store factory mcp-oauth-handlers uses, so
      // mcp.connect can pre-check whether a token exists for an
      // `auth:"oauth"` server and short-circuit to needs_oauth_login
      // when not. Without this, the SDK's DCR call would run with
      // `redirect_uris:[]` (the loopback is only started by
      // mcp.oauth_login) and Higgsfield-class providers return 400
      // `at least one redirect_uri is required`, masking the real
      // "user must run mcp_login" signal. See mcp-handlers.ts for the
      // gate.
      createTokenStore: deps.createTokenStore,
      // Threaded for env-ref validation on mcp.connect. Same pattern as
      // agent/provider handlers above. When undefined the validator becomes
      // a no-op.
      secretManager: deps.container?.secretManager,
      // Threaded for static-secret header extraction. ApiDispatchDeps
      // already carries secretStore (from AuthApiDeps) which is populated from
      // c.secretStore at daemon.ts:1071. When undefined the extraction
      // fails-safe (throws [plaintext_secret_in_headers]) rather than
      // persisting plaintext.
      secretStore: deps.secretStore,
      // Thread persistDeps so mcp.connect/disconnect can route through
      // persistToConfig. Mirrors the heartbeat-handlers wiring at
      // :280-290. When deps.container is missing (test harnesses) persist
      // is short-circuited to persistence:"skipped".
      persistDeps: deps.container ? {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      } : undefined,
    }),
    // mcp-oauth-handlers consumes WorkspaceApiDeps (mcpClientManager + logger +
    // container for the persisted server config). oauth_login runs the
    // server-side discovery + loopback callback + SDK auth() flow (via
    // the @comis/skills runOauthLogin orchestrator — the daemon has no direct SDK
    // dep) and returns the authUrl for the CLI to open; oauth_logout clears the
    // three token files. The browser is NEVER launched daemon-side (the injected
    // openUrl defaults to a no-op). The login orchestrator + token-store factory
    // default to the real @comis/skills exports.
    ...createMcpOauthHandlers({
      ...deps,
      mcpClientManager: deps.mcpClientManager,
      logger: deps.logger,
      // Fix 9: push a completion message back to the operator's chat after a
      // headless OAuth + manager.connect succeeds. Same chokepoint
      // message.send uses (deliveryService → resolveAdapter →
      // adaptersByType[channelType]). Skips silently if the channel adapter
      // for the operator's channelType isn't registered (e.g., the adapter
      // was disabled between RPC entry and OAuth completion).
      notifyOperatorChannel: async (target, text) => {
        const adapter = deps.adaptersByType.get(target.channelType);
        if (adapter === undefined) {
          deps.logger.warn(
            {
              method: "mcp.oauth_login",
              channelType: target.channelType,
              hint: "Adapter not registered at OAuth-completion time; notification skipped",
              errorKind: "platform" as const,
            },
            "Headless-OAuth completion notification skipped (no adapter)",
          );
          return;
        }
        const deliveryResult = await deps.deliveryService.deliverToChannel(
          adapter,
          target.channelId,
          text,
          { origin: "mcp.oauth_login.headless_completed" },
        );
        if (!deliveryResult.ok) throw deliveryResult.error;
      },
    }),
    // daemon-handlers consumes DaemonApiDeps; spread `...deps` so the
    // cluster slice's required `logger` is present alongside the
    // daemon-specific narrow wiring (logLevelManager).
    ...createDaemonHandlers({ ...deps, logLevelManager: deps.logLevelManager }),
    // workspace-handlers consumes WorkspaceApiDeps; spread `...deps` so
    // cluster slice's required fields are present.
    ...createWorkspaceHandlers({
      ...deps,
      agents: deps.agents,
      workspaceDirs: deps.workspaceDirs,
      defaultWorkspaceDir: deps.defaultWorkspaceDir,
      logger: deps.logger,
      execGit: deps.execGit,
      memoryApi: deps.memoryApi,
      memoryAdapter: deps.memoryAdapter,
      tenantId: deps.tenantId,
    }),
    // Heartbeat management handlers — consumes OrchestratorApiDeps.
    ...createHeartbeatHandlers({
      ...deps,
      perAgentRunner: deps.perAgentRunner,
      agents: deps.agents,
      persistDeps: deps.container ? {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      } : undefined,
      globalHeartbeatConfig: deps.globalHeartbeatConfig,
    }),
    // Skill management handlers — consumes WorkspaceApiDeps.
    ...createSkillHandlers({
      ...deps,
      skillRegistries: deps.skillRegistries,
      workspaceDirs: deps.workspaceDirs,
      defaultAgentId: deps.defaultAgentId,
      container: deps.container,
      eventBus: deps.container.eventBus,
    }),
    // Proactive v1: Notification handlers — consumes WorkspaceApiDeps.
    ...(deps.notificationService
      ? createNotificationHandlers({ ...deps, notificationService: deps.notificationService })
      : {}),
    // Proactive v1: Image generation handlers
    ...(deps.imageHandlerDeps
      ? createImageHandlers(deps.imageHandlerDeps)
      : {}),
    // v2.24 Phase 188: Video generation handler (video.generate). Gated on the
    // video bundle being wired (provider + rate limiter present); the spread
    // closes the contract↔handler parity gate via [VideoGenerateContract.method].
    ...(deps.videoHandlerDeps
      ? createVideoHandlers(deps.videoHandlerDeps)
      : {}),
    // v2.24 Phase 189 (JOB-04): Video status handler (video.status). Gated on the
    // status deps being wired (the agent-scoped store + logger); the spread closes
    // the contract↔handler parity gate via [VideoStatusContract.method] in the SAME
    // wave the contract is declared (no cross-wave strand — the 188 BLOCKER-1 class).
    ...(deps.videoStatusHandlerDeps
      ? createVideoStatusHandlers(deps.videoStatusHandlerDeps)
      : {}),
  };

  // Return the dispatch function
  // All handler errors are caught and logged through Pino with structured fields
  // before re-throwing, ensuring errors never escape to raw stderr.
  const dispatch: RpcCall = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    try {
      // ORIGIN-01 deny-by-origin chokepoint. BOTH the in-process agent path
      // (createAgentRpcCall -> the same injected rpcCall) AND the gateway path
      // funnel through this one closure to reach every handler — so this is the
      // single seam at which an agent-origin call to an admin-scoped method is
      // rejected. `params._agentId` is the trusted agent-origin signal (Plan 03
      // strips external forgeries, so presence == agent-origin). The guard fires
      // only for ADMIN_METHODS; a non-admin method's `_agentId` passes untouched.
      // assertNotAgentOrigin emits the content-free audited denial and throws;
      // the catch below logs + re-throws it as the JSON-RPC error (so the denial
      // is both audited AND structured-logged for full observability).
      if (ADMIN_METHODS.has(method)) {
        assertNotAgentOrigin(params, deps, method);
      }

      // AUDIT-01 (Phase 215): the per-CAPABILITY audit. Emit ONLY when the
      // method maps to a real AgentCapability in HANDLER_CAPABILITY_MAP (skip
      // "ungated" + "deny-by-origin" — the latter already audits via
      // assertNotAgentOrigin above, so excluding it here avoids the double-audit
      // for the admin path). The in-process leg has NO lease (G1): source
      // rootRunId from the synthetic-root resolver; leaseId is honestly ABSENT.
      const classification = HANDLER_CAPABILITY_MAP[method as keyof typeof HANDLER_CAPABILITY_MAP];
      const isCapGated =
        classification !== undefined &&
        classification !== "ungated" &&
        classification !== "deny-by-origin";
      // The trusted agent-origin signal — present only on the in-process leg.
      const agentOrigin = typeof params._agentId === "string" ? params._agentId : undefined;
      // ≈ the call's run id (the formatted caller session key), if present.
      const callerSessionKey =
        typeof params._callerSessionKey === "string" ? params._callerSessionKey : undefined;
      // The synthetic per-session root (setup-capability-endpoint-boot.ts). Omit
      // the whole record when there is no session key + no resolver — never fabricate.
      const parsedKey = callerSessionKey ? parseFormattedSessionKey(callerSessionKey) : undefined;
      const rootRunId =
        parsedKey !== undefined ? deps.resolveRootRunId?.(parsedKey) : undefined;
      // WR-02: gate the durable AUDIT-02 trail on a real cap + agent origin ONLY —
      // a gated decision is a security fact regardless of tree-root resolution.
      // emitCapabilityAudit emits `audit:event` unconditionally and SUPPRESSES the
      // `capability:audited` tree producer when rootRunId is absent (an unplaceable
      // node), so a missing _callerSessionKey no longer silently drops the security
      // row — only the tree node. rootRunId is honestly absent in-process when
      // unresolvable (never fabricated, G1).
      const shouldAudit = isCapGated && agentOrigin !== undefined;

      // Phase 217-05 (the keystone): the run's EFFECTIVE autonomy mode at THIS gate
      // decision (research Pattern 3 + EVICT-02/03). The order is load-bearing:
      //   1. evicted (operator's autonomy.evict) → "default" FIRST — the demotion
      //      overrides any injected/resolved mode and takes effect at the NEXT gate
      //      decision (mid-run, EVICT-03), not next spawn.
      //   2. else the trusted in-process-injected `_autonomyMode` (Plan 03) →
      //      resolveEffectiveMode (valid passthrough; absent/forged/unknown →
      //      "default", EVICT-02 fail-closed).
      //   3. else (the jail leg injects no mode — Plan 03) → server-resolve from
      //      deps.agents[agentOrigin] (this chokepoint HAS deps.agents in scope,
      //      unlike the boot file) → resolveEffectiveMode (unresolvable → "default").
      // TODO(2026-06-24, T-217-06/T-217-15): wire evictRegistry.clear + denialBreaker.evict on NORMAL run-end (not just the trip/kill path). The chokepoint is per-call and has no clean run-end hook; the durable run-lifecycle / sessionEnd seam (setup-durable-resume / the runner's run-complete) is the right place to drop a completed root's breaker counter + evict flag so the in-memory maps cannot grow under a storm of per-cron-fire roots. The trip/kill path already clears; this TODO covers the happy-path completion only.
      const effectiveMode = (): AutonomyMode => {
        if (rootRunId !== undefined && deps.evictRegistry?.isEvicted(rootRunId)) return "default";
        const injected = params._autonomyMode;
        if (typeof injected === "string") return resolveEffectiveMode(injected);
        // Jail leg: no injected mode → server-resolve from deps.agents. Fail-CLOSED
        // (EVICT-02): an absent agents map or a missing/unresolvable agent entry
        // yields `undefined` → resolveEffectiveMode → "default" (never the broader
        // standard profile resolveAutonomy(undefined) would return).
        const agentEntry =
          agentOrigin !== undefined ? deps.agents?.[agentOrigin] : undefined;
        const serverMode =
          agentEntry !== undefined ? resolveAutonomy(agentEntry.autonomy).mode : undefined;
        return resolveEffectiveMode(serverMode);
      };

      try {
        const result = await handler(params);
        if (shouldAudit) {
          emitCapabilityAudit(deps, {
            agentId: agentOrigin,
            capability: classification,
            method,
            ...(callerSessionKey !== undefined ? { runId: callerSessionKey } : {}),
            ...(rootRunId !== undefined ? { rootRunId } : {}),
            // leaseId honestly ABSENT in-process (G1) — never fabricated.
            decision: "allow",
          });
        }
        // Phase 217-05 (BREAK reset): a successful gated call resets the per-root
        // consecutive-floor-block counter, so a single deny inside a PRODUCTIVE
        // loop never accumulates to a trip (the productive run is not aborted).
        if (rootRunId !== undefined) deps.denialBreaker?.recordAllow(rootRunId);
        return result;
      } catch (innerErr) {
        // A capability denial (the handler's requireCapability) is a first-class
        // audited deny — emit it, then rethrow for the normal classify/log path.
        if (shouldAudit && innerErr instanceof CapabilityDeniedError) {
          emitCapabilityAudit(deps, {
            agentId: agentOrigin,
            capability: classification,
            method,
            ...(callerSessionKey !== undefined ? { runId: callerSessionKey } : {}),
            ...(rootRunId !== undefined ? { rootRunId } : {}),
            decision: "deny",
          });
        }
        // Phase 217-05 (the keystone): the mode-aware deny-vs-escalate + breaker
        // drive. COUNT-ONLY-FLOOR-BLOCKS — this branch fires ONLY for a genuine
        // CapabilityDeniedError. `assertNotAgentOrigin` (admin deny-by-origin)
        // throws a PLAIN Error and a generic handler error is a non-CapabilityDeniedError,
        // so neither reaches recordDenial (research recommendation #5, BY CONSTRUCTION
        // via this instanceof guard). The throw at the end is UNCHANGED — the run
        // ALWAYS sees the deny and adapts (never hangs); NO escalation is awaited.
        if (innerErr instanceof CapabilityDeniedError) {
          const mode = effectiveMode();
          if (rootRunId !== undefined && deps.denialBreaker) {
            const verdict = deps.denialBreaker.recordDenial(rootRunId);
            if (verdict.tripped) {
              // BREAK-02: the Nth consecutive floor-block → ABORT the tree (not an
              // infinite retry loop) + escalate. Mirror bridge-safety-controls.ts's
              // execution:aborted emit shape; the obs layer consumes the reason.
              if (parsedKey !== undefined) {
                deps.container.eventBus.emit("execution:aborted", {
                  sessionKey: parsedKey,
                  reason: "denial_breaker",
                  agentId: agentOrigin ?? "",
                  timestamp: systemNowMs(),
                });
              }
              // FLEET-02 (Phase 220-05): ALSO emit the dedicated content-free
              // autonomy:denial_breaker_tripped event so `comis fleet` surfaces the
              // trip as a separable `denialBreakerTrips` count. The execution:aborted
              // emit above flips a UI phase only (no fleet-ingestion path) and its
              // `denial_breaker` reason is never a session endReason/breakerTripCount,
              // so the trip would otherwise be INVISIBLE to the fleet lens (the
              // milestone-audit gap). rootRunId is in scope (the `!== undefined` guard
              // above); systemNowMs is the globals-gate-safe wiring clock (no Date.now).
              // Content-free: the rootRunId (an id) + timestamp ONLY — the deny reason
              // rides the escalate() below, never the typed event.
              deps.container.eventBus.emit("autonomy:denial_breaker_tripped", {
                rootRunId,
                timestamp: systemNowMs(),
              });
              deps.subAgentRunner.killByRootRun(rootRunId);
              deps.escalate?.({
                kind: "denial_breaker_tripped",
                rootRunId,
                reason: "consecutive floor-blocks reached denialBreakerN",
                hint: "the run was aborted to avoid burning the budget on a deny loop (autonomy.denialBreakerN)",
              });
              // LOW-2: the tree is now dead — drop its per-root breaker + evict state
              // so the in-memory maps cannot leak (the trip/kill cleanup path).
              deps.evictRegistry?.clear(rootRunId);
              deps.denialBreaker.evict(rootRunId);
            } else if (mode === "unattended") {
              // UNATT-01/03: a would-ask deny under unattended escalates (out-of-band
              // + auditable) and the run CONTINUES (the re-throw below). Content-free.
              deps.escalate?.({
                kind: "would_ask_denied",
                rootRunId,
                reason: `capability/quota denied: ${classification}`,
                hint: "an unattended run hit a ceiling; the platform escalated to the operator and the run continues (adapt or await operator action)",
              });
            }
          } else if (mode === "unattended" && deps.escalate) {
            // No rootRunId (no breaker scope) but unattended → still escalate the
            // would-ask deny (the never-hang escalate is not gated on a tree root).
            deps.escalate({
              kind: "would_ask_denied",
              rootRunId: "",
              reason: `capability/quota denied: ${classification}`,
              hint: "unattended deny escalated",
            });
          }
        }
        throw innerErr;
      }
    } catch (err) {
      // Classify by raw object (instanceof) and severity-dispatch
      // warn vs error. `params` joins the payload so subsequent
      // operator debugging (e.g., `context.expand id=abc-123`) doesn't
      // need a separate grep — the offending input is on the same log line.
      const classified = classifyRpcError(err);
      // Defense-in-depth: auth.set params carry bare `access` and
      // `refresh` OAuth token fields at the RPC boundary. Strip them
      // before logging so a transient failure (SQLITE_BUSY, admin-gate
      // rejection) does not write raw bearer tokens to the daemon log.
      // This is defense-in-depth — Part A (CREDENTIAL_KEYS) is the
      // primary, cross-cutting fix; this per-method projection is the
      // second layer that survives any future sanitizer bypass or new
      // credential-bearing field in the auth.set contract.
      // Omit rather than replace: the operator sees method + err; the
      // token value itself is never diagnostic for a write-failure path.
      let safeParams: Record<string, unknown> = params;
      if (method === "auth.set") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional destructuring to omit credential fields
        const { access: _a, refresh: _r, accountId: _id, ...rest } = params;
        safeParams = rest;
      } else if (BINARY_PARAM_METHODS.has(method)) {
        // WR-04: omit large base64/binary payload fields (image/video/audio
        // bytes) from the log payload — content-hygiene (never log message
        // bodies). Shallow-copy minus the binary keys; the method + small
        // params (prompt, mimeType, language) remain for triage.
        const rest: Record<string, unknown> = { ...params };
        for (const key of BINARY_PARAM_KEYS) delete rest[key];
        safeParams = rest;
      }
      deps.logger[classified.level](
        {
          method,
          params: safeParams,
          err,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "JSON-RPC method error",
      );
      throw err;
    }
  };

  return dispatch;
}
