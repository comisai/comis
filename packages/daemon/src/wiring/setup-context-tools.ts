// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-side wiring for the in-session expansion-loop `ctx_*` tools:
 * `ctx_search` / `ctx_inspect` / `ctx_expand`.
 *
 * The daemon is the composition root — it constructs the concrete LCD store
 * (`createLcdStore`, in `setup-memory`) and injects it here AS the core
 * `ContextStorePort` TYPE, then pushes the three tools onto the agent tool array
 * sharing ONE `ContextToolDeps`. This mirrors the terminal-driver wiring
 * (`wireTerminalTools`) exactly: a direct-injection, never-export, owner-scoped
 * tool set wired OUTSIDE the platform-tool parity registry — it is structurally
 * DISTINCT from the cross-session recall layer (no in-process RPC dispatch, no
 * recall-store dispatch path, no cross-package recall import). The
 * agent-to-store cut holds: skills + agent see only the core `ContextStorePort`
 * type; the concrete adapter is the daemon's.
 *
 * The factories + `ContextToolDeps` live on the `@comis/skills/tools` subpath
 * (the terminal-driver precedent — `createTerminalSession*` ride the same
 * subpath); `PlatformToolProvider` is on the `.` barrel, the same way
 * `setup-terminal-tools.ts` types its tool array. There is NO module-global
 * mutable state — the deps are threaded in from the `setupTools` closure.
 *
 * @module
 */

import type { ContextStorePort } from "@comis/core";
// The daemon does not depend on the pi SDK directly — it references the tool
// array type via @comis/skills' PlatformToolProvider (= () => AgentTool[]), the
// same way setup-tools.ts and setup-terminal-tools.ts type their tool arrays.
import type { PlatformToolProvider } from "@comis/skills";
// Direct-injection ctx_* factories + the shared deps contract. These live on the
// `./tools` subpath (NOT the `.` barrel) — the terminal-driver precedent.
import {
  createCtxSearchTool,
  createCtxInspectTool,
  createCtxExpandTool,
  depthForTier,
  type ContextToolDeps,
} from "@comis/skills/tools";
// The capability-axis resolver (frontier/mid/small/nano) — the same
// minimal {id, provider} the memory-ops capability resolver uses. The capability
// axis ignores contextWindow, so a bare model object is correct.
import { resolveModelProfile } from "@comis/agent";
import type { CapabilityClass } from "@comis/agent";

/** The daemon tool-assembly array element type (an `AgentTool`), via skills. */
type AgentToolArray = ReturnType<PlatformToolProvider>;

/**
 * The daemon-supplied slice of `ContextToolDeps` (everything except the `store`,
 * which is passed positionally so the call site reads `wireContextTools(tools,
 * store, …)` like `wireTerminalTools(tools, registries, …)`). `skillsLogger` is
 * the daemon's `ComisLogger` — structurally assignable to the tools'
 * structural `ToolLogger`.
 */
export interface ContextWiringDeps {
  /** The daemon's module-bound skills logger (a `ComisLogger`, structurally a `ToolLogger`). */
  readonly skillsLogger: ContextToolDeps["logger"];
  /** Injected clock — the sanctioned-root `systemNowMs`; never a raw wall-clock global. */
  readonly nowMs: () => number;
  /** Inline-output cap before `ctx_expand` spills to a file (from `ContextEngineConfig`, default 4000). */
  readonly maxExpandTokens: number;
  /**
   * Tier-gated max BFS hop depth for the `ctx_expand` multi-hop walk
   * (nano1/small2/mid3/frontier4). The daemon resolves it from the agent's
   * `ModelProfile` at `setup-tools.ts` (a capacity knob — wiring-time is correct;
   * the read scope stays per-call). Absent ⇒ a conservative single-hop depth of 1.
   */
  readonly maxExpandDepth?: number;
  /** Per-call session tool-results dir resolver (the hoisted exec-tool precedent). */
  readonly getToolResultsDir: () => string | undefined;
  /**
   * Optional structural event bus — the daemon's real `TypedEventBus`,
   * passed structurally so the skills layer never value-imports it. Threaded
   * onto the shared `ContextToolDeps` so each ctx_* hit emits a content-free
   * `context:dag_expanded`. Absent ⇒ a silent no-op.
   */
  readonly eventBus?: { emit(event: string, data: unknown): void };
}

/**
 * Wire the three never-export, dag-mode in-session expansion tools.
 * Mirrors `wireTerminalTools`: build one shared `ContextToolDeps` from the
 * injected store + the daemon deps, then push the three factories onto the
 * agent tool array. The `store` is the concrete `createLcdStore` adapter the
 * daemon constructed, injected here AS the core `ContextStorePort` TYPE — the
 * agent-to-store cut holds. DISTINCT from the cross-session recall layer: no
 * in-process RPC dispatch, no recall-store dispatch path.
 */
export function wireContextTools(
  tools: AgentToolArray,
  store: ContextStorePort,
  _agentId: string,
  deps: ContextWiringDeps,
): void {
  // `_agentId` stays UNUSED. The ctx_* tools read the live agentId
  // (+ tenantId) from the per-call RequestContext (`tryGetContext()`), NOT from
  // this wiring-time closure — multi-agent-safe. One wiring can serve
  // multiple agents per channel, so a closure-captured agentId would scope every
  // agent's reads to whichever agent wired the tools (the exact cross-agent
  // threat). The store read scope therefore comes from the live turn, never here.
  const shared: ContextToolDeps = {
    store,
    logger: deps.skillsLogger,
    nowMs: deps.nowMs,
    maxExpandTokens: deps.maxExpandTokens,
    // The tier-gated multi-hop depth cap (resolved wiring-time from the
    // agent's ModelProfile). A capacity knob — the read scope is still per-call.
    maxExpandDepth: deps.maxExpandDepth,
    getToolResultsDir: deps.getToolResultsDir,
    // The daemon's real bus (structurally assignable) so each ctx_* hit
    // emits a content-free context:dag_expanded. `undefined` ⇒ silent no-op.
    eventBus: deps.eventBus,
  };
  tools.push(
    createCtxSearchTool(shared),
    createCtxInspectTool(shared),
    createCtxExpandTool(shared),
  );
}

/** The minimal per-agent shape {@link maybeWireContextTools} reads. */
export interface CtxToolAgentConfig {
  contextEngine?: { maxExpandTokens?: number };
  model?: string;
  provider?: string;
}

/**
 * Wire the canonical in-session `ctx_*` tools when a context store is present.
 * The operator `capabilityClassOverride` (the
 * same `providers.entries.<id>.capabilities.capabilityClass` source pi-executor uses, supplied
 * by the caller) governs the tier-gated `ctx_expand` walk depth; absent ⇒ provider-family
 * heuristic. No-op when no store is available.
 */
export function maybeWireContextTools(
  tools: AgentToolArray,
  store: ContextStorePort | undefined,
  agentId: string,
  agentConfig: CtxToolAgentConfig | undefined,
  deps: Omit<ContextWiringDeps, "maxExpandTokens" | "maxExpandDepth"> & {
    capabilityClassOverride?: CapabilityClass;
  },
): void {
  if (!store) return;
  const maxExpandTokens = agentConfig?.contextEngine?.maxExpandTokens ?? 4000;
  // Tier-gated multi-hop depth (capacity knob → wiring-time; read scope per-call).
  const maxExpandDepth = resolveCtxExpandDepth(
    agentConfig?.model,
    agentConfig?.provider,
    deps.capabilityClassOverride,
  );
  wireContextTools(tools, store, agentId, {
    skillsLogger: deps.skillsLogger,
    nowMs: deps.nowMs,
    maxExpandTokens,
    maxExpandDepth,
    getToolResultsDir: deps.getToolResultsDir,
    eventBus: deps.eventBus, // ctx_* context:dag_expanded
  });
}

/**
 * Resolve the tier-gated `ctx_expand` multi-hop walk depth
 * (nano1/small2/mid3/frontier4) from an agent's `model`/`provider`.
 *
 * `RequestContext` carries NO `capabilityClass`, so the cap is
 * resolved HERE at wiring time from the agent's `ModelProfile`. The DEPTH cap is
 * a CAPACITY knob, NOT a scope — wiring-time resolution is correct even when one
 * `wireContextTools` call serves multiple agents per channel; the read
 * scope still comes per-call from `requireCtxScope()` inside each tool. The
 * capability axis ignores `contextWindow`, so the minimal `{ id, provider }` the
 * memory-ops resolver uses is correct here too (resolve-memory-ops-capability.ts).
 *
 * `model`/`provider` default to "default" on a parsed agent config; an undefined
 * or unknown model fails closed to the most-locked profile (nano → depth 1).
 *
 * `capabilityClassOverride` is the operator's per-provider
 * `providers.entries.<id>.capabilities.capabilityClass` pin (the same source pi-executor
 * threads into the live ModelProfile). When supplied it wins over the provider-family
 * heuristic, so an operator who pins a large quantized ollama model "mid" gets the mid
 * walk depth (3) here too — not the ollama→small→2 heuristic. Absent ⇒ heuristic.
 */
export function resolveCtxExpandDepth(
  model: string | undefined,
  provider: string | undefined,
  capabilityClassOverride?: CapabilityClass,
): number {
  // Thread the operator capabilityClass override (the same
  // providers.entries.<id>.capabilities.capabilityClass pin pi-executor.ts:359-364 honors)
  // into resolveModelProfile so a pinned tier governs the ctx_expand walk depth consistently
  // with the rest of the platform — not the provider-family heuristic alone. Absent ⇒ the
  // heuristic (back-compat). The override wins unconditionally (model-profile.ts:158).
  const profile = resolveModelProfile(
    { id: model ?? "", provider: provider ?? "" },
    capabilityClassOverride,
  );
  return depthForTier(profile.capabilityClass);
}
