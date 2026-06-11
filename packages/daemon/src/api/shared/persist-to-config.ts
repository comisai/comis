// SPDX-License-Identifier: Apache-2.0
/**
 * Reusable config persistence utility for management RPC handlers.
 * Reads current YAML config, deep-merges a patch, validates against
 * AppConfigSchema, and atomically writes the result (temp file + rename).
 * Bypasses immutable key check -- this is an internal utility for authorized
 * management handlers (agents, tokens, channels), never exposed as a public
 * RPC endpoint. The calling handler is responsible for authorization.
 * On any failure (validation, I/O), returns err() Result -- never throws.
 * The caller can log a warning, but the in-memory change remains intact.
 *
 * MODULE-LEVEL STATE (read this before adding tests that exercise the real
 * persist path):
 *
 * This module owns TWO module-level mutables, by design:
 *
 *   1. `sigusr1Timer` -- a SINGLE global SIGUSR2 debounce timer shared across
 *      ALL management RPC call sites (agents.create, tokens.create,
 *      channels.enable, etc.). The 2-second debounce window is intentionally
 *      cross-handler: multiple unrelated management operations within the same
 *      window coalesce into one SIGUSR2 restart, by design. The audit event
 *      for each individual operation is still emitted with its own entityId;
 *      only the restart signal coalesces.
 *
 *   2. `pendingConfigMutations` -- a global config-mutation fence counter.
 *      Wrap a batch (e.g., N agent creates inside one tool call) with
 *      `enterConfigMutationFence()` / `leaveConfigMutationFence()` to defer
 *      SIGUSR2 until the batch fully drains. Re-armed every 500ms while held.
 *
 * Both pieces of state are PROCESS-WIDE singletons -- intentional, because the
 * SIGUSR2 they coordinate is itself a process-wide signal. There is no
 * per-daemon-instance scoping. Test isolation: tests that exercise the real
 * `persistToConfig` (not a mock) MUST call `_resetSigusr1Timer()` AND
 * `_resetMutationFence()` from a `beforeEach` hook, or the timer / fence
 * counter from a prior test will leak into the next one.
 *
 * Today every test in this package mocks `persistToConfig` via
 * `vi.mock("./shared/persist-to-config.js")`, so the leak is not exercised.
 * If you add a test that imports and calls the real function, add the
 * `beforeEach` reset hook -- there is no automatic enforcement.
 *
 * @module
 */

import {
  deepMerge,
  AppConfigSchema,
  scanForSecrets,
  isEnvRefString,
  type AppContainer,
  type ConfigGitManager,
  type GitCommitMetadata,
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";

// ---------------------------------------------------------------------------
// Env-ref masking for the plaintext-secret scan.
//
// The on-disk YAML stores credentials as `${VAR}` refs; the in-memory config
// holds the substituted values. Scanning the in-memory tree for plaintext
// (defensive layer for in-memory-only leaks the on-disk file wouldn't have)
// then false-positives on every substituted secret.
//
// Walk the resolved tree in lock-step with the on-disk tree: at every path
// where the on-disk value is an env-ref string (`${VAR}` / `$VAR` /
// `$${VAR}`, with optional auth-scheme prefix), substitute the on-disk
// literal back into the resolved view. scanForSecrets already exempts those
// strings, so the false positive disappears while in-memory-only plaintext
// (paths where the on-disk file has no ref) still surfaces.
// ---------------------------------------------------------------------------

function maskRefsFromOnDisk(resolved: unknown, onDisk: unknown): unknown {
  if (typeof onDisk === "string" && isEnvRefString(onDisk)) {
    return onDisk;
  }
  if (Array.isArray(resolved) && Array.isArray(onDisk)) {
    return resolved.map((v, i) => maskRefsFromOnDisk(v, onDisk[i]));
  }
  if (
    resolved !== null
    && typeof resolved === "object"
    && !Array.isArray(resolved)
    && onDisk !== null
    && typeof onDisk === "object"
    && !Array.isArray(onDisk)
  ) {
    const out: Record<string, unknown> = {};
    const r = resolved as Record<string, unknown>;
    const d = onDisk as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      out[k] = maskRefsFromOnDisk(r[k], d[k]);
    }
    return out;
  }
  return resolved;
}

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
    systemClearTimeout(sigusr1Timer);
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
/**
 * Resolve the local config path persistToConfig writes (last entry, same as
 * config.patch) and read its CURRENT on-disk YAML, unparsed-by-schema and
 * un-substituted — i.e. with `${VAR}` secret references intact.
 *
 * Handlers whose patch REPLACES an array of entries that may carry secret
 * references (e.g. `gateway.tokens`) must source those references from THIS
 * tree, never from `container.config`: the in-memory config holds the
 * substituted plaintext, so a ref can only be preserved from disk. (Live
 * finding, 2026-06-12 C7 run: tokens.create rebuilt gateway.tokens from the
 * in-memory view, severing the admin token's `${COMIS_GATEWAY_TOKEN}` ref.)
 *
 * Returns `{}` when no file exists or it does not parse.
 */
export function readOnDiskConfig(deps: PersistToConfigDeps): Record<string, unknown> {
  const configPath =
    deps.configPaths.length > 0
      ? deps.configPaths[deps.configPaths.length - 1]!
      : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Unreadable / unparseable: same empty-object semantics as persistToConfig step 2.
  }
  return {};
}

export async function persistToConfig(
  deps: PersistToConfigDeps,
  opts: PersistToConfigOpts,
): Promise<Result<{ configPath: string }, string>> {
  const startMs = systemNowMs();

  try {
    // 1. Determine local config file path (last entry, same as config.patch)
    const configPath =
      deps.configPaths.length > 0
        ? deps.configPaths[deps.configPaths.length - 1]!
        : deps.defaultConfigPaths[deps.defaultConfigPaths.length - 1]!;

    // 2. Read existing local YAML file (same semantics as readOnDiskConfig)
    const existingLocal: Record<string, unknown> = readOnDiskConfig(deps);

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

    // Refuse to persist any config containing a plaintext secret.
    // Scan BOTH fullMerged (catches secrets in any in-memory config layer or the
    // patch) AND updatedLocal (the exact object serialized to disk). A secret
    // that exists only in the on-disk local file — present in existingLocal but
    // absent from container.config (loader-dropped / layer-divergence) — would
    // survive in updatedLocal via deepMerge(existingLocal, patch) yet be absent
    // from fullMerged = deepMerge(container.config, patch). Scanning both ensures
    // the write target is always covered regardless of loader normalization.
    //
    // BUT: `fullMerged` carries POST-substitution values (the in-memory config
    // resolved every `${VAR}` ref at boot via SecretManager). A path that on
    // disk is literally `${TELEGRAM_BOT_TOKEN}` shows up in fullMerged as the
    // resolved token VALUE — which `looksLikeSecretValue` correctly flags as a
    // plaintext secret, producing a false positive. The persist target
    // (updatedLocal) was never plaintext at that path; only the in-memory
    // shadow looked that way. Mask resolved values back to their `${VAR}`
    // literal at every path where updatedLocal carries an env-ref, then scan.
    // scanForSecrets's own env-ref exemption then drops the false positive.
    const refMaskedFullMerged = maskRefsFromOnDisk(fullMerged, updatedLocal);
    const secretFindings = [...scanForSecrets(refMaskedFullMerged), ...scanForSecrets(updatedLocal)];
    if (secretFindings.length > 0) {
      const firstPath = secretFindings[0]!.path;
      return err(
        `[plaintext_secret_blocked] Config contains a plaintext secret at "${firstPath}". ` +
        `Persist aborted to prevent committing credentials to config.yaml. ` +
        `Hint: store the secret via secrets_manage and reference it as "\${VAR}".`,
      );
    }

    // 5. Atomic write: create parent dir, write to temp file, rename
    const localDir = dirname(configPath);
    if (!existsSync(localDir)) {
      // fs-safe-allowed: localDir is parent of operator-supplied configPath; not ~/.comis/ directly
      mkdirSync(localDir, { recursive: true });
    }
    const tmpPath = configPath + ".tmp";
    writeFileSync(tmpPath, yamlStringify(updatedLocal), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, configPath);

    // Best-effort git versioning
    if (deps.configGitManager) {
      const gitStart = systemNowMs();
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
        deps.logger.debug({ method: "persistToConfig", durationMs: systemNowMs() - gitStart, outcome: "success" }, "Git commit recorded");
      }).catch((gitErr: unknown) => {
        deps.logger.debug({ method: "persistToConfig", durationMs: systemNowMs() - gitStart, outcome: "failure", err: gitErr, hint: "Git commit failed (best-effort)", errorKind: "internal" as const }, "Git commit failed (best-effort)");
      });
    }

    const durationMs = systemNowMs() - startMs;

    // Emit audit event on success
    deps.container.eventBus.emit("audit:event", {
      timestamp: systemNowMs(),
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
        systemClearTimeout(sigusr1Timer);
      }
      sigusr1Timer = systemSetTimeout(function fireSigusr1() {
        if (pendingConfigMutations > 0) {
          // Re-arm: fence still held, retry in 500ms
          sigusr1Timer = systemSetTimeout(fireSigusr1, 500);
          return;
        }
        sigusr1Timer = undefined;
        process.kill(process.pid, "SIGUSR2");
      }, 2000);
    }

    return ok({ configPath });
  } catch (e: unknown) {
    const durationMs = systemNowMs() - startMs;
    const errMsg = e instanceof Error ? e.message : String(e);

    // Emit audit event on failure
    deps.container.eventBus.emit("audit:event", {
      timestamp: systemNowMs(),
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
