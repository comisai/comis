// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-side wiring for the interactive terminal driver (v2.11, Phase 119 P0).
 *
 * The daemon is the composition root — the only package that may value-import
 * `@comis/infra` — so it constructs the per-agent `TerminalSessionRegistry`
 * (injecting the real logger + the production worker-spawn posture) and pushes
 * the nine terminal tools (four implemented + five stubs) into the agent tool
 * set. All nine are registered `mcpExportPolicy:"never-export"` (119-01), so they
 * stay inside Comis's trust boundary and never reach MCP.
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
import type { ComisLogger } from "@comis/infra";
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
  detectSandboxProvider,
  type TerminalSessionRegistry,
  type TerminalEventBus,
  type AllowEntryLike,
} from "@comis/skills/tools";
import { systemNowMs } from "@comis/core";

/** Dependencies the terminal-driver wiring needs from the composition root. */
export interface TerminalWiringDeps {
  /** Base data dir (~/.comis) — scopes the worker's durable-state fs-write. */
  readonly dataDir: string;
  /** Module-bound skills logger (the real `@comis/infra` logger). */
  readonly skillsLogger: ComisLogger;
  /** The daemon's typed event bus (structurally compatible with `TerminalEventBus`). */
  readonly eventBus: TerminalEventBus;
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
    });
    registries.set(agentId, registry);
  }
  return registry;
}

/**
 * Construct the per-agent registry + push all nine terminal-driver tools onto
 * the agent's tool array — the single entry point the composition root calls.
 *
 * The four implemented tools (create/read/list/kill) share the injected registry
 * + the (currently empty) operator allow-set + the fail-closed
 * `detectSandboxProvider` + the real logger/bus; the five stubs reject
 * `not_implemented`. Mirrors how exec/process/apply-patch join the same array.
 */
export function wireTerminalTools(
  tools: AgentToolArray,
  registries: Map<string, TerminalSessionRegistry>,
  agentId: string,
  deps: TerminalWiringDeps,
): void {
  const registry = getOrCreateTerminalRegistry(registries, agentId, deps);

  // SEC-01 trust source: the operator allow-set. Empty until the config is
  // threaded into PerAgentConfig (a later step) — so every create fail-closes.
  const allowEntries: AllowEntryLike[] = [];

  const sharedDeps = {
    registry,
    allowEntries,
    detectProvider: () => detectSandboxProvider(deps.skillsLogger),
    logger: deps.skillsLogger,
    eventBus: deps.eventBus,
    nowMs: systemNowMs,
    agentId,
  };

  tools.push(
    createTerminalSessionCreateTool(sharedDeps),
    createTerminalSessionReadTool(sharedDeps),
    createTerminalSessionListTool(sharedDeps),
    createTerminalSessionKillTool(sharedDeps),
    createTerminalSessionSendTextTool(),
    createTerminalSessionSendKeyTool(),
    createTerminalSessionWaitTool(),
    createTerminalSessionStatusTool(),
    createTerminalSessionResizeTool(),
  );
}
