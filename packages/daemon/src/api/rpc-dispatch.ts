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

import { PreconditionError, ValidationError } from "./errors.js";
import { RequiredToolsUnreachableError } from "@comis/core";

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
 * Accepts the raw error object (not just its message) so `instanceof`
 * checks against `PreconditionError` / `ValidationError` resolve. Returns
 * an ErrorKind, an actionable hint, AND a `level` (`"warn" | "error"`)
 * that the dispatcher uses to pick `logger.warn` vs `logger.error`. The
 * goal is to keep operator alerts meaningful: caller mistakes
 * (preconditions, validation) are warn-level via typed-class throws;
 * unmatched cases fall through to `error/internal`.
 *
 * The legacy message-pattern (substring-match) fallbacks were deleted.
 * Handlers that still `throw new Error("Admin access required" |
 * "immutable" | ...)` will now classify as `internal`/`error` until they
 * are migrated to `throw new PreconditionError(...)` /
 * `throw new ValidationError(...)`. The typed-error migration of the
 * remaining bare-Error handlers in packages/daemon/src/api/ is deferred.
 * The deletion is intentional — keeping the substring fallbacks was the BC
 * shim; the migration is incremental hardening.
 */
export function classifyRpcError(err: unknown): { errorKind: ErrorKind; hint: string; level: "warn" | "error" } {
  // Typed errors: instanceof checks. Add new typed classes here as
  // handlers migrate; do NOT re-introduce substring-match fallbacks.
  if (err instanceof PreconditionError) return { errorKind: "precondition", hint: "Caller precondition not met; check resource state before retry", level: "warn" };
  if (err instanceof ValidationError) return { errorKind: "validation", hint: "Check parameter types and values against the schema", level: "warn" };
  // RequiredToolsUnreachableError is a caller-side validation failure (caller passed
  // invalid required_tools). Classify as validation/warn — NOT internal/error.
  if (err instanceof RequiredToolsUnreachableError) return { errorKind: "validation", hint: "Adjust required_tools and/or tool_groups per the per-tool hints in the error message", level: "warn" };
  return { errorKind: "internal", hint: "Check the RPC method handler and its dependencies", level: "error" };
}

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
      return await handler(params);
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
