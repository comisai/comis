/**
 * SecretManager — centralized credential access.
 *
 * All credential access goes through this interface so that direct
 * `process.env` reads can be banned via ESLint everywhere else.
 *
 * Also contains the ScopedSecretManager decorator (per-agent credential
 * isolation with glob filtering and audit event emission).
 *
 * Design principles:
 * - Defensive copy: mutations to the source env after creation have no effect
 * - No enumeration: no `.env` property or `.getAll()` method exposed
 * - Diagnostic errors: `require()` includes the missing key name in the message
 * - Immutable: the returned object has only the 4 documented methods
 */

import type { TypedEventBus } from "../event-bus/index.js";
import { isSecretAccessible } from "./secret-access.js";

/**
 * Interface for centralized secret/credential access.
 * Intentionally minimal — no bulk access or enumeration of values.
 */
export interface SecretManager {
  /** Get a secret value by key, or undefined if not set. */
  get(key: string): string | undefined;

  /** Check if a secret key is available (value is defined). */
  has(key: string): boolean;

  /**
   * Get a secret value by key, throwing if not set.
   * Error message includes the key name for diagnostics.
   */
  require(key: string): string;

  /** Get the list of available key names (defensive copy). */
  keys(): string[];
}

/**
 * Create a SecretManager from a record of environment variables.
 *
 * Takes a defensive copy — subsequent mutations to `env` will not
 * affect the returned manager.
 *
 * @param env - Record of key-value pairs (undefined values are excluded)
 * @returns A frozen SecretManager instance
 */
export function createSecretManager(env: Record<string, string | undefined>): SecretManager {
  // Defensive copy: snapshot defined values into an internal Map
  const secrets = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      secrets.set(key, value);
    }
  }

  return {
    get(key: string): string | undefined {
      return secrets.get(key);
    },

    has(key: string): boolean {
      return secrets.has(key);
    },

    require(key: string): string {
      const value = secrets.get(key);
      if (value === undefined) {
        throw new Error(
          `Required secret "${key}" is not set. ` +
            `Check that this key is defined in your .env file or environment.`,
        );
      }
      return value;
    },

    keys(): string[] {
      return [...secrets.keys()];
    },
  };
}

/**
 * Create a restricted environment record for subprocess spawning.
 *
 * Instead of passing the full `process.env` to `child_process.spawn()`,
 * use this to select only the keys the subprocess needs.
 *
 * @param manager - SecretManager to read values from
 * @param allowedKeys - Keys to include in the subset
 * @returns Plain object with only the allowed keys that exist in the manager
 */
export function envSubset(
  manager: SecretManager,
  allowedKeys: readonly string[],
): Record<string, string> {
  const subset: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = manager.get(key);
    if (value !== undefined) {
      subset[key] = value;
    }
  }
  return subset;
}

// ---------------------------------------------------------------------------
// ScopedSecretManager — per-agent SecretManager decorator with glob filtering
// ---------------------------------------------------------------------------

/**
 * Options for creating a scoped (per-agent) SecretManager.
 */
export interface ScopedSecretManagerOptions {
  /** The agent this scoped manager belongs to. Included in all audit events. */
  agentId: string;

  /** Glob patterns that grant access. Empty array = unrestricted (backward compat). */
  allowPatterns: string[];

  /** Optional event bus for audit event emission. No-op if omitted. */
  eventBus?: TypedEventBus;
}

/**
 * Create a SecretManager that filters access by glob patterns and emits audit events.
 *
 * The returned object implements the SecretManager interface exactly — same 4 methods
 * (get, has, require, keys), same return types. This is the decorator pattern:
 * callers cannot distinguish a ScopedSecretManager from a plain SecretManager.
 *
 * @param base - The underlying SecretManager to delegate allowed accesses to
 * @param options - Agent ID, allow patterns, and optional event bus
 * @returns A SecretManager that enforces per-agent access control
 */
export function createScopedSecretManager(
  base: SecretManager,
  options: ScopedSecretManagerOptions,
): SecretManager {
  const { agentId, allowPatterns, eventBus } = options;

  let warnedNoAllow = false;

  /**
   * Emit a one-time security:warn event when an agent accesses secrets
   * without explicit secrets.allow configuration.
   */
  function warnUnrestrictedAccess(secretName: string): void {
    if (warnedNoAllow || allowPatterns.length > 0 || !eventBus) return;
    warnedNoAllow = true;
    eventBus.emit("security:warn", {
      category: "secret_access",
      agentId,
      message:
        `Agent "${agentId}" accessed secret "${secretName}" without explicit secrets.allow configuration. ` +
        `Configure secrets.allow patterns to restrict access.`,
      timestamp: Date.now(),
    });
  }

  function emitAccess(
    secretName: string,
    outcome: "success" | "denied" | "not_found",
  ): void {
    eventBus?.emit("secret:accessed", {
      secretName,
      agentId,
      outcome,
      timestamp: Date.now(),
    });
  }

  return {
    get(key: string): string | undefined {
      warnUnrestrictedAccess(key);
      if (!isSecretAccessible(key, allowPatterns)) {
        emitAccess(key, "denied");
        return undefined;
      }

      const value = base.get(key);
      emitAccess(key, value !== undefined ? "success" : "not_found");
      return value;
    },

    has(key: string): boolean {
      warnUnrestrictedAccess(key);
      if (!isSecretAccessible(key, allowPatterns)) {
        emitAccess(key, "denied");
        return false;
      }

      const exists = base.has(key);
      emitAccess(key, exists ? "success" : "not_found");
      return exists;
    },

    require(key: string): string {
      warnUnrestrictedAccess(key);
      if (!isSecretAccessible(key, allowPatterns)) {
        emitAccess(key, "denied");
        throw new Error(
          `Agent "${agentId}" is not allowed to access secret "${key}". ` +
            `Check the agent's secrets.allow configuration.`,
        );
      }

      const value = base.get(key);
      if (value === undefined) {
        emitAccess(key, "not_found");
        throw new Error(
          `Required secret "${key}" is not set. ` +
            `Check that this key is defined in your .env file or encrypted store.`,
        );
      }

      emitAccess(key, "success");
      return value;
    },

    keys(): string[] {
      return base.keys().filter((k) => isSecretAccessible(k, allowPatterns));
    },
  };
}
