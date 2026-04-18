/**
 * Reusable config persistence utility for management RPC handlers.
 * Reads current YAML config, deep-merges a patch, validates against
 * AppConfigSchema, and atomically writes the result (temp file + rename).
 * Bypasses immutable key check -- this is an internal utility for authorized
 * management handlers (agents, tokens, channels), never exposed as a public
 * RPC endpoint. The calling handler is responsible for authorization.
 * On any failure (validation, I/O), returns err() Result -- never throws.
 * The caller can log a warning, but the in-memory change remains intact.
 * @module
 */

import {
  deepMerge,
  AppConfigSchema,
  type AppContainer,
  type ConfigGitManager,
  type GitCommitMetadata,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";

// ---------------------------------------------------------------------------
// Module-scoped debounce timer for SIGUSR2 coalescing.
// Multiple rapid persistToConfig calls (e.g., 8 agent creates) coalesce
// into a single restart signal. The 2-second window allows batch operations
// to complete before triggering one restart.
// ---------------------------------------------------------------------------

let sigusr1Timer: ReturnType<typeof setTimeout> | undefined;

/** Reset the module-scoped SIGUSR2 debounce timer. For test isolation only. */
export function _resetSigusr1Timer(): void {
  if (sigusr1Timer !== undefined) {
    clearTimeout(sigusr1Timer);
    sigusr1Timer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Config mutation fence.
// While pendingConfigMutations > 0, SIGUSR2 is deferred. This prevents
// batch agent creation (N parallel tool calls) from firing SIGUSR2
// mid-batch, which would lose N-1 agents.
// ---------------------------------------------------------------------------

let pendingConfigMutations = 0;

/** Increment the config mutation fence counter. While > 0, SIGUSR2 is deferred. */
export function enterConfigMutationFence(): void {
  pendingConfigMutations++;
}

/** Decrement the config mutation fence counter. */
export function leaveConfigMutationFence(): void {
  pendingConfigMutations = Math.max(0, pendingConfigMutations - 1);
}

/** Reset the mutation fence counter. For test isolation only. */
export function _resetMutationFence(): void {
  pendingConfigMutations = 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for persistToConfig, following the same pattern
 * as ConfigHandlerDeps in config-handlers.ts.
 */
export interface PersistToConfigDeps {
  /** Application container (provides config, eventBus, tenantId) */
  container: AppContainer;
  /** Layered config file paths (last entry is the local override file) */
  configPaths: string[];
  /** Fallback config file paths if configPaths is empty */
  defaultConfigPaths: string[];
  /** Optional git-backed config versioning manager */
  configGitManager?: ConfigGitManager;
  /** Structured Pino logger */
  logger: ComisLogger;
}

/**
 * Per-call options describing the config mutation to persist.
 */
export interface PersistToConfigOpts {
  /** Config mutation to deep-merge into the local YAML file (e.g., { agents: { myAgent: { ... } } }) */
  patch: Record<string, unknown>;
  /** Paths to delete from the local YAML after merging (e.g., [["agents", "myAgent"]] removes agents.myAgent). Used for delete operations where deepMerge cannot remove keys. */
  removePaths?: string[][];
  /** Management action identifier for audit/git (e.g., "agents.create", "tokens.revoke") */
  actionType: string;
  /** Entity being changed (e.g., agent ID, token name) */
  entityId: string;
  /** User or agent initiating the change */
  actingUser?: string;
  /** Request trace ID for correlation */
  traceId?: string;
  /** When true, skip scheduling SIGUSR2 after persist. Used when the caller handles the mutation in-process (hot-add) and no restart is needed. */
  skipRestart?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Persist a config mutation to the local YAML config file.
 * Steps:
 * 1. Determine the local config file path (last entry from configPaths)
 * 2. Read and parse existing YAML (or start with empty object)
 * 3. Deep-merge the patch into the local file contents
 * 4. Validate the full merged config (patch applied to in-memory config) against AppConfigSchema
 * 5. Atomically write the updated local file (write to temp, rename)
 * Bypasses immutable key check -- this is an internal utility for authorized
 * management handlers, never exposed as a public RPC endpoint.
 * @param deps - Injected dependencies (container, config paths, logger)
 * @param opts - Per-call options (patch, actionType, entityId)
 * @returns ok({ configPath }) on success, err(message) on failure
 */
export async function persistToConfig(
  deps: PersistToConfigDeps,
  opts: PersistToConfigOpts,
): Promise<Result<{ configPath: string }, string>> {
  const startMs = Date.now();

  try {
    // 1. Determine local config file path (last entry, same as config.patch)
    const configPath =
      deps.configPaths.length > 0
        ? deps.configPaths[deps.configPaths.length - 1]!
        : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;

    // 2. Read existing local YAML file
    let existingLocal: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = parseYaml(raw) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") {
          existingLocal = parsed;
        }
      } catch {
        // If read/parse fails, start with empty object
      }
    }

    // 3. Deep-merge patch into local file contents
    const updatedLocal = deepMerge(existingLocal, opts.patch);

    // 3b. Process removePaths: delete specified nested keys from the local YAML
    if (opts.removePaths) {
      for (const path of opts.removePaths) {
        let target: Record<string, unknown> = updatedLocal;
        for (let i = 0; i < path.length - 1; i++) {
          const next = target[path[i]!];
          if (!next || typeof next !== "object") break;
          target = next as Record<string, unknown>;
        }
        if (path.length > 0) {
          delete target[path[path.length - 1]!];
        }
      }
    }

    // 4. Validate full merged config (patch applied to current in-memory config)
    const fullMerged = deepMerge(
      structuredClone(deps.container.config as unknown as Record<string, unknown>),
      opts.patch,
    );

    // 4b. Apply removePaths to fullMerged so validation reflects the deletion
    if (opts.removePaths) {
      for (const path of opts.removePaths) {
        let target: Record<string, unknown> = fullMerged;
        for (let i = 0; i < path.length - 1; i++) {
          const next = target[path[i]!];
          if (!next || typeof next !== "object") break;
          target = next as Record<string, unknown>;
        }
        if (path.length > 0) {
          delete target[path[path.length - 1]!];
        }
      }
    }

    const validation = AppConfigSchema.safeParse(fullMerged);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return err(`Config validation failed: ${issues}`);
    }

    // 5. Atomic write: create parent dir, write to temp file, rename
    const localDir = dirname(configPath);
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, yamlStringify(updatedLocal), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, configPath);

    // Best-effort git versioning
    if (deps.configGitManager) {
      const gitStart = Date.now();
      const section = Object.keys(opts.patch)[0] ?? "config";
      const meta: GitCommitMetadata = {
        section,
        key: opts.entityId,
        agent: opts.actingUser,
        user: opts.actingUser,
        traceId: opts.traceId,
        summary: `${opts.actionType}: ${opts.entityId}`,
      };
      deps.configGitManager.commit(meta).then(() => {
        deps.logger.debug({ method: "persistToConfig", durationMs: Date.now() - gitStart, outcome: "success" }, "Git commit recorded");
      }).catch((gitErr: unknown) => {
        deps.logger.debug({ method: "persistToConfig", durationMs: Date.now() - gitStart, outcome: "failure", err: gitErr, hint: "Git commit failed (best-effort)", errorKind: "internal" as const }, "Git commit failed (best-effort)");
      });
    }

    const durationMs = Date.now() - startMs;

    // Emit audit event on success
    deps.container.eventBus.emit("audit:event", {
      timestamp: Date.now(),
      agentId: opts.actingUser ?? "system",
      tenantId: deps.container.config.tenantId ?? "default",
      actionType: opts.actionType,
      classification: "destructive" as const,
      outcome: "success" as const,
      metadata: { entityId: opts.entityId, configPath },
    });

    deps.logger.info(
      { method: "persistToConfig", actionType: opts.actionType, entityId: opts.entityId, durationMs, outcome: "success" },
      "Config persisted",
    );

    // Schedule daemon restart so all subsystems pick up new config atomically.
    // Debounced: multiple rapid calls coalesce into a single SIGUSR2.
    // The 2-second window allows batch operations to complete before triggering one restart.
    // Skip restart when caller handles the mutation in-process (hot-add/hot-remove).
    if (!opts.skipRestart) {
      if (sigusr1Timer !== undefined) {
        clearTimeout(sigusr1Timer);
      }
      sigusr1Timer = setTimeout(function fireSigusr1() {
        if (pendingConfigMutations > 0) {
          // Re-arm: fence still held, retry in 500ms
          sigusr1Timer = setTimeout(fireSigusr1, 500);
          return;
        }
        sigusr1Timer = undefined;
        process.kill(process.pid, "SIGUSR2");
      }, 2000);
    }

    return ok({ configPath });
  } catch (e: unknown) {
    const durationMs = Date.now() - startMs;
    const errMsg = e instanceof Error ? e.message : String(e);

    // Emit audit event on failure
    deps.container.eventBus.emit("audit:event", {
      timestamp: Date.now(),
      agentId: opts.actingUser ?? "system",
      tenantId: deps.container.config.tenantId ?? "default",
      actionType: opts.actionType,
      classification: "destructive" as const,
      outcome: "failure" as const,
      metadata: { entityId: opts.entityId, error: errMsg },
    });

    deps.logger.warn(
      { method: "persistToConfig", actionType: opts.actionType, entityId: opts.entityId, durationMs, outcome: "failure", err: e, hint: "Config persistence failed; in-memory change intact", errorKind: "config" as const },
      "Config persist failed",
    );

    return err(`persistToConfig failed: ${errMsg}`);
  }
}
