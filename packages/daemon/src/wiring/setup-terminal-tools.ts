// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-side wiring for the interactive terminal driver (v2.11, Phase 119 P0 +
 * Phase 120 P1 interaction).
 *
 * The daemon is the composition root — the only package that may value-import
 * `@comis/infra` — so it constructs the per-agent `TerminalSessionRegistry`
 * (injecting the real logger + the production worker-spawn posture) and pushes
 * the nine terminal tools (eight implemented + one stub [`status`]) into the agent
 * tool set. The eight implemented tools (create/read/list/kill + the four
 * interaction tools send_text/send_key/wait/resize) all share one `sharedDeps`
 * (the injected registry + allow-set + provider + logger/bus/clock); `status` is
 * the lone no-arg stub (Phase 124). All nine are registered
 * `mcpExportPolicy:"never-export"` (119-01), so they stay inside Comis's trust
 * boundary and never reach MCP.
 *
 * Extracted from `setup-tools.ts` to keep that file under the 800-line
 * architecture cap. State (the per-agent registry map) lives in the `setupTools`
 * closure and is threaded in here — there is NO module-global mutable state.
 *
 * SEC-01 / SEC-16 fail-closed by construction at this phase: the operator
 * `TerminalDriverConfig.allow[]` is not yet threaded into `PerAgentConfig` (that
 * config-plumbing + the worker process entrypoint are later P0/P-phase work), so
 * the wired allow-set is EMPTY — every `terminal_session_create` is rejected by
 * the allowlist gate (`matchAllowEntry` returns undefined) before any worker is
 * spawned. The surface is live + governed; the worker is never spawned until both
 * the allow-set and the worker main land. The seam is clean.
 *
 * @module
 */

import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ComisLogger } from "@comis/infra";
import { createTerminalEgressProxy } from "./terminal-egress-proxy.js";
// The daemon does not depend on the pi SDK directly — it references the tool
// array type via @comis/skills' PlatformToolProvider (= () => AgentTool[]), the
// same way setup-tools.ts types its `tools` array.
import type { PlatformToolProvider } from "@comis/skills";

/** The daemon tool-assembly array element type (an `AgentTool`), via skills. */
type AgentToolArray = ReturnType<PlatformToolProvider>;
import {
  createTerminalSessionRegistry,
  buildProductionSpawnWorker,
  createTerminalSessionCreateTool,
  createTerminalSessionReadTool,
  createTerminalSessionListTool,
  createTerminalSessionKillTool,
  createTerminalSessionSendTextTool,
  createTerminalSessionSendKeyTool,
  createTerminalSessionWaitTool,
  createTerminalSessionStatusTool,
  createTerminalSessionResizeTool,
  type TerminalSessionRegistry,
  type TerminalEventBus,
  type AllowEntryLike,
  type TerminalScope,
  type SandboxProvider,
} from "@comis/skills/tools";
import {
  systemNowMs,
  type TerminalAllowEntry,
  type ApprovalGate,
  type EgressControlPort,
} from "@comis/core";

/** Dependencies the terminal-driver wiring needs from the composition root. */
export interface TerminalWiringDeps {
  /** Base data dir (~/.comis) — scopes the worker's durable-state fs-write. */
  readonly dataDir: string;
  /** Module-bound skills logger (the real `@comis/infra` logger). */
  readonly skillsLogger: ComisLogger;
  /** The daemon's typed event bus (structurally compatible with `TerminalEventBus`). */
  readonly eventBus: TerminalEventBus;
  /**
   * The daemon's once-detected sandbox provider (MR-03). Detected ONCE at daemon
   * startup (the same value the exec path threads via `sandboxCfg.sandbox`) and
   * reused here — so the create gate's SEC-16 fail-closed branch reads the cached
   * provider instead of re-running the blocking `detectSandboxProvider()`
   * (`spawnSync("bwrap")` smoke test) on every create. `undefined` ⇒ no sandbox
   * runtime ⇒ create fail-closes (the fail-closed posture is unchanged).
   */
  readonly sandboxProvider: SandboxProvider | undefined;
  /**
   * The daemon's operator approval gate (SEC-06). The same `ApprovalGate` the
   * exec path uses (constructed once in `setup-tools.ts`). Threaded into the
   * terminal tools' `sharedDeps` so a `approveOnCreate` entry gates `session_create`
   * on operator consent. Optional: when absent, an `approveOnCreate` entry
   * fail-closes (reject) — it never runs unauthorized.
   */
  readonly approvalGate?: ApprovalGate;
  /**
   * The host-side no-secret allowlist egress proxy (SEC-07), constructed at the
   * composition root (`createTerminalEgressProxy`) and injected here as the
   * {@link EgressControlPort}. Threaded toward the worker path so 122-06 can call
   * `materialize(scope.hosts)` for `network: listed-hosts` and bind-mount the
   * returned socket. Optional: absent => no `listed-hosts` egress is materialized
   * (the create gate + scope still enforce `none`/`full`); never a silent open.
   */
  readonly egressControl?: EgressControlPort;
  /**
   * The resolved `bwrap` binary path (the daemon detects it ONCE at startup, the
   * same value the sandbox provider resolves via `which bwrap`). Threaded toward
   * the worker path so 122-06 can pass it to `buildScopeArgs({ bwrapPath, ... })`
   * (the scope->argv composer needs the explicit path; it is NOT implicit). Made
   * EXPLICIT here per the W1 plan-checker — do not leave bwrapPath implicit.
   */
  readonly bwrapPath?: string;
}

/**
 * Map a parsed config `TerminalAllowEntry` onto the skills-side `AllowEntryLike`
 * (SEC-02/03) — the SINGLE site config scope becomes an `AllowEntryLike`.
 *
 * Copies `{ id, match, scope }`: the operator-declared scope is carried verbatim so
 * it threads on to the create frame (RESEARCH Pitfall 4 — scope must NOT be dropped
 * at the daemon boundary). The config schema already applied the least-privilege
 * `.default(...)` to every scope sub-field, so this is a pure passthrough — no
 * defaulting / widening here (scope is operator-only, never agent-dialable). When
 * the config-plumbing step lands it does `config.allow.map(mapAllowEntry)` and scope
 * flows automatically; until then the wired allow-set stays empty (fail-closed).
 *
 * The `scope` cast is structural-identity: the config `scope` strictObject and the
 * skills `TerminalScope` are the same closed union (the latter hand-mirrors the
 * former); the daemon bridges the two package types at this composition seam.
 */
export function mapAllowEntry(entry: TerminalAllowEntry): AllowEntryLike {
  return {
    id: entry.id,
    match: entry.match,
    scope: entry.scope as TerminalScope,
    // SEC-06: carry the operator's approveOnCreate consent flag verbatim (a sibling
    // of scope) so the create tool can gate on it — never dropped at the boundary.
    approveOnCreate: entry.approveOnCreate,
  };
}

/**
 * Resolve the worker entry's runtime JS path (the dist sibling of the
 * `terminal-worker-entry` source). The production worker-spawn posture forks
 * `node <permission-args> <workerJs>`; this is never invoked while the allow-set
 * is empty (the gate rejects every create first), but the registry is
 * constructed with the correct posture so a later phase only has to populate the
 * allow-set + ship the worker main.
 */
function resolveWorkerJsPath(dataDir: string): string {
  // Placeholder under the data dir until the standalone worker main lands
  // (the worker is currently an in-process factory; the separate-process entry
  // is wired in a later P0 step). Never spawned while the allow-set is empty.
  return resolve(dataDir, "terminal-worker", "worker-main.js");
}

/**
 * Get (or lazily create) the per-agent `TerminalSessionRegistry`. The map lives
 * in the `setupTools` closure (passed in) — no module-global state. The registry
 * is constructed with the 118-proven `--permission` worker-spawn posture
 * (`buildProductionSpawnWorker`) scoped to the agent's data dir.
 */
function getOrCreateTerminalRegistry(
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
): TerminalSessionRegistry {
  let registry = registries.get(agentId);
  if (!registry) {
    registry = createTerminalSessionRegistry({
      spawnWorker: buildProductionSpawnWorker(resolveWorkerJsPath(deps.dataDir), deps.dataDir),
      logger: deps.skillsLogger,
      nowMs: systemNowMs,
      // HR-03 / OPS-07: turn a worker backend-spawn failure (an `ok:false` create
      // reply, which the registry uses to flip the session to `lost`) into the
      // `terminal:spawn_failed` bus event. The registry already logged the WARN +
      // flipped the handle; this closes the observability loop on the bus.
      onSpawnFailed: ({ sessionId, error }) => {
        deps.eventBus.emit("terminal:spawn_failed", {
          sessionId,
          agentId,
          hint: error ?? "worker backend spawn failed",
          errorKind: "dependency",
          timestamp: systemNowMs(),
        });
      },
    });
    registries.set(agentId, registry);
  }
  return registry;
}

/**
 * Construct the per-agent registry + push all nine terminal-driver tools onto
 * the agent's tool array — the single entry point the composition root calls.
 *
 * The eight implemented tools (create/read/list/kill + send_text/send_key/wait/
 * resize) share the injected registry + the (currently empty) operator allow-set
 * + the daemon's once-detected cached `sandboxProvider` (fail-closed when
 * `undefined`) + the real logger/bus; `status` is the lone stub that rejects
 * `not_implemented`. The four interaction tools delegate to the registry's
 * forwarding methods (120-03) — they do not re-gate the allowlist (the session was
 * gated at create). Mirrors how exec/process/apply-patch join the same array.
 */
/**
 * The net-new SEC-07 egress dimensions, constructed ONCE at the composition root
 * (not per-agent): the host-side no-secret allowlist proxy (the
 * {@link EgressControlPort} impl) + the resolved `bwrap` binary path.
 */
export interface TerminalEgressDeps {
  /** The host-side allowlist egress proxy (materializes `listed-hosts` per session). */
  readonly egressControl: EgressControlPort;
  /** The resolved bwrap path (Linux + provider==bwrap), else undefined (fail-closed downstream). */
  readonly bwrapPath: string | undefined;
}

/**
 * Construct the SEC-07 egress dependencies ONCE for the daemon (the composition
 * root), to inject into every agent's terminal wiring. The proxy materializes
 * `listed-hosts` egress on demand (per session) in 122-06; constructing the port
 * once avoids re-standing-up a server factory per agent/per create. `bwrapPath` is
 * resolved only when the provider IS bwrap (Linux) — matching
 * `BwrapProvider.available()`'s `which bwrap` so the terminal scope composer
 * (122-06 `buildScopeArgs`) binds the SAME binary the exec sandbox uses; on
 * macOS/no-sandbox it stays undefined (the create gate already fail-closes there).
 */
export function buildTerminalEgressDeps(
  logger: ComisLogger,
  sandboxProvider: SandboxProvider | undefined,
): TerminalEgressDeps {
  const egressControl = createTerminalEgressProxy({ logger });
  let bwrapPath: string | undefined;
  if (sandboxProvider?.name === "bwrap") {
    try {
      // eslint-disable-next-line no-restricted-syntax -- one-shot bwrap path resolve at daemon startup
      bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
    } catch {
      bwrapPath = undefined; // provider reported bwrap but PATH lost it — fail-closed downstream
    }
  }
  return { egressControl, bwrapPath };
}

/**
 * Build the shared deps object the nine terminal tools receive — the SINGLE seam
 * where the per-agent registry, the operator allow-set, the cached sandbox
 * provider, the approval gate, AND the net-new egress dimensions (the
 * {@link EgressControlPort} impl + the resolved `bwrapPath`) flow toward the
 * worker path. Extracted so the egress wiring is testable in isolation (122-05
 * Task 3) and so 122-06 has one obvious place to read `egressControl` +
 * `bwrapPath` when composing the `listed-hosts` jail. No module-global state — the
 * registry map is passed in.
 */
export function buildTerminalSharedDeps(
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
) {
  const registry = getOrCreateTerminalRegistry(registries, agentId, deps);

  // SEC-01 trust source: the operator allow-set. Empty until the config is
  // threaded into PerAgentConfig (a later step) — so every create fail-closes.
  // When that lands it becomes `config.allow.map(mapAllowEntry)`, so the per-entry
  // scope (SEC-02) rides along via the single mapping site above (no silent drop).
  const allowEntries: AllowEntryLike[] = [];

  return {
    registry,
    allowEntries,
    // MR-03: reuse the daemon's once-detected cached provider — do NOT re-run the
    // blocking `detectSandboxProvider()` (`spawnSync("bwrap")`) on every create.
    // This mirrors how `setup-tools.ts` feeds `sandboxCfg.sandbox = sandboxProvider`
    // to the exec path. Fail-closed is intact: `undefined` ⇒ the create gate's
    // SEC-16 branch rejects (never an unsandboxed spawn).
    detectProvider: () => deps.sandboxProvider,
    logger: deps.skillsLogger,
    eventBus: deps.eventBus,
    nowMs: systemNowMs,
    agentId,
    // SEC-06: the operator approval gate — consulted only when a matched entry sets
    // approveOnCreate (else the create path is unchanged); a demanding entry with no
    // gate fail-closes in the tool.
    approvalGate: deps.approvalGate,
    // SEC-07 (122-05): the net-new egress dimensions, threaded toward the worker.
    // The PORT impl (the no-secret allowlist proxy) + the resolved bwrap path; the
    // worker (122-06) calls `egressControl.materialize(scope.hosts)` for
    // `listed-hosts` and passes `bwrapPath` to `buildScopeArgs`. EXPLICIT, not
    // implicit (W1 plan-checker). Today unused by the eight tools — they carry it
    // through the seam so the worker composer has it.
    egressControl: deps.egressControl,
    bwrapPath: deps.bwrapPath,
  };
}

export function wireTerminalTools(
  tools: AgentToolArray,
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
): void {
  const sharedDeps = buildTerminalSharedDeps(registries, agentId, deps);

  tools.push(
    createTerminalSessionCreateTool(sharedDeps),
    createTerminalSessionReadTool(sharedDeps),
    createTerminalSessionListTool(sharedDeps),
    createTerminalSessionKillTool(sharedDeps),
    createTerminalSessionSendTextTool(sharedDeps),
    createTerminalSessionSendKeyTool(sharedDeps),
    createTerminalSessionWaitTool(sharedDeps),
    createTerminalSessionStatusTool(),
    createTerminalSessionResizeTool(sharedDeps),
  );
}
