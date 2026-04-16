/**
 * Environment secret management RPC handler.
 * Provides the `env.set` method for agents to provision API keys and secrets
 * at runtime. Write-only (no read, no delete). Values never logged.
 * Two storage backends:
 *   1. SecretStorePort (encrypted secrets.db via AES-256-GCM) -- preferred
 *   2. .env file append (legacy fallback when master key not configured)
 * @module
 */

import type { AppContainer, SecretStorePort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
} from "node:fs";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Rate limiter (reused pattern from config-handlers.ts)
// ---------------------------------------------------------------------------

/**
 * Token bucket rate limiter for env.set.
 * Allows maxTokens sets per windowMs. Refills continuously.
 */
function createTokenBucket(maxTokens: number, windowMs: number) {
  let tokens = maxTokens;
  let lastRefill = Date.now();

  return {
    tryConsume(): { allowed: boolean; retryAfterMs?: number } {
      const now = Date.now();
      const elapsed = now - lastRefill;
      const refilled = (elapsed / windowMs) * maxTokens;
      tokens = Math.min(maxTokens, tokens + refilled);
      lastRefill = now;

      if (tokens >= 1) {
        tokens -= 1;
        return { allowed: true };
      }
      const deficit = 1 - tokens;
      const retryAfterMs = Math.ceil((deficit / maxTokens) * windowMs);
      return { allowed: false, retryAfterMs };
    },
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by env handlers. */
export interface EnvHandlerDeps {
  secretStore?: SecretStorePort;
  envFilePath: string;
  container: AppContainer;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Valid env var key: starts with uppercase letter, uppercase + digits + underscores only. */
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 8192;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create env RPC handlers.
 * @param deps - Injected dependencies
 * @returns Record mapping method names to handler functions
 */
export function createEnvHandlers(deps: EnvHandlerDeps): Record<string, RpcHandler> {
  // Rate limiter: 5 sets per 60s
  const setBucket = createTokenBucket(5, 60_000);

  return {
    "env.set": async (params) => {
      const startMs = Date.now();
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for env.set");
      }

      // Rate limit check
      const bucket = setBucket.tryConsume();
      if (!bucket.allowed) {
        deps.logger.warn(
          { method: "env.set", hint: "Env set rate limit exceeded, retry after cooldown", errorKind: "validation" as const, retryAfterMs: bucket.retryAfterMs },
          "Env set rate limited",
        );
        throw new Error(
          `Env set rate limit exceeded: max 5 sets per minute. ` +
          `Try again in ${Math.ceil(bucket.retryAfterMs! / 1000)} seconds.`,
        );
      }

      const key = params.key as string | undefined;
      const value = params.value as string | undefined;

      // Validate key
      if (!key || typeof key !== "string") {
        throw new Error("Missing required parameter: key");
      }
      if (key.length > MAX_KEY_LENGTH) {
        throw new Error(`Key exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
      }
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error(
          `Invalid key format: "${key}". Keys must start with an uppercase letter ` +
          `and contain only uppercase letters, digits, and underscores (e.g., OPENAI_API_KEY).`,
        );
      }

      // Validate value
      if (value === undefined || value === null || typeof value !== "string") {
        throw new Error("Missing required parameter: value (must be a string)");
      }
      if (value.length === 0) {
        throw new Error("Value must not be empty");
      }
      if (value.length > MAX_VALUE_LENGTH) {
        throw new Error(`Value exceeds maximum length of ${MAX_VALUE_LENGTH} characters`);
      }

      try {
        // Write to storage backend
        if (deps.secretStore) {
          // Encrypted mode: use SecretStorePort
          const setResult = deps.secretStore.set(key, value);
          if (!setResult.ok) {
            throw new Error(`Secret store write failed: ${setResult.error.message}`);
          }
        } else {
          // Legacy mode: write to .env file
          writeToEnvFile(deps.envFilePath, key, value);
        }

        const durationMs = Date.now() - startMs;

        // Audit event (NEVER include value)
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "env.set",
          classification: "destructive",
          outcome: "success",
          metadata: { key },
        });

        // Log at INFO (NEVER log value)
        deps.logger.info(
          { method: "env.set", key, durationMs, outcome: "success" },
          "Env secret set",
        );

        // Schedule daemon restart (same 200ms + SIGUSR1 pattern as config-handlers)
        setTimeout(() => {
          process.kill(process.pid, "SIGUSR1");
        }, 200);

        return {
          set: true,
          key,
          storage: deps.secretStore ? "encrypted" : "envfile",
          restarting: true,
        };
      } catch (e: unknown) {
        const durationMs = Date.now() - startMs;
        const errMsg = e instanceof Error ? e.message : String(e);

        // Audit event on failure (NEVER include value)
        deps.container.eventBus.emit("audit:event", {
          timestamp: Date.now(),
          agentId: "system",
          tenantId: deps.container.config.tenantId ?? "default",
          actionType: "env.set",
          classification: "destructive",
          outcome: "failure",
          metadata: { key, error: errMsg },
        });

        deps.logger.warn(
          { method: "env.set", key, durationMs, outcome: "failure", err: e, hint: "Check secret store or .env file permissions", errorKind: "config" as const },
          "Env set failed",
        );

        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// .env file write helper
// ---------------------------------------------------------------------------

/**
 * Write a key=value pair to a .env file atomically.
 * If the key already exists, replaces its value. Otherwise appends.
 * Sets file permissions to 0o600.
 * SECURITY: envFilePath is daemon-controlled (not user input),
 * so safePath is not needed here.
 */
function writeToEnvFile(envFilePath: string, key: string, value: string): void {
  let lines: string[] = [];

  if (existsSync(envFilePath)) {
    const content = readFileSync(envFilePath, "utf-8");
    lines = content.split("\n");
  }

  // Find and replace existing key, or append
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const lineKey = trimmed.slice(0, eqIdx).trim();
    if (lineKey === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Ensure trailing newline before appending
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push(`${key}=${value}`);
    } else if (lines.length === 0) {
      lines.push(`${key}=${value}`);
    } else {
      // Last line is empty (trailing newline), insert before it
      lines.splice(lines.length - 1, 0, `${key}=${value}`);
    }
  }

  const content = lines.join("\n");
  const tmpPath = envFilePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, envFilePath);
  chmodSync(envFilePath, 0o600);
}
