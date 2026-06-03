// SPDX-License-Identifier: Apache-2.0
/**
 * Secrets Lifecycle Integration Tests
 *
 * Validates the encrypted secrets boot path, per-agent credential scoping,
 * and secret:accessed audit event emission -- end-to-end with a real daemon.
 *
 * Covers:
 *   - Daemon boots with encrypted secrets store (pre-seeded <dataDir>/secrets.db
 *     loaded into the manager at boot via buildMergedEnv → decryptAll)
 *   - ScopedSecretManager allows matching secrets and emits success events
 *   - ScopedSecretManager denies non-matching secrets and emits denied events
 *   - secret:accessed audit events have correct structure
 *   - Encrypted store secrets are accessible via base secretManager
 *
 * Uses port 8560 (config.test-secrets-lifecycle.yaml).
 *
 * NOTE: Secret names use TEST_ANTHROPIC_* / TEST_OPENAI_* prefixes to avoid
 * collisions with real env vars. The daemon merge logic gives env vars priority
 * over decrypted store values, so using real ANTHROPIC_API_KEY would return the
 * live credential instead of the test value.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { createLogCapture } from "../support/log-verifier.js";
import { createScopedSecretManager } from "@comis/core";
import type { EventMap } from "@comis/core";
import { createSqliteSecretStore, setupSecrets } from "@comis/memory";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-secrets-lifecycle.yaml");

// Test-only secret names that won't collide with real env vars
const ALLOWED_SECRET = "TEST_ANTHROPIC_SECRET_KEY";
const DENIED_SECRET = "TEST_OPENAI_SECRET_KEY";
const ALLOWED_VALUE = "test-anthropic-key-value";
const DENIED_VALUE = "test-openai-key-value";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Secrets Lifecycle Integration Tests", () => {
  let handle: TestDaemonHandle;
  let logCapture: ReturnType<typeof createLogCapture>;
  let tempDataDir: string;
  let originalDataDir: string | undefined;
  let originalMasterKey: string | undefined;

  beforeAll(async () => {
    logCapture = createLogCapture();

    // The daemon builds its encrypted store via selectSecretStore →
    // setupSecrets({ env, dataDir }), which reads SECRETS_MASTER_KEY from the
    // environment and opens <dataDir>/secrets.db. (The old daemon-level
    // `setupSecrets` override is no longer on that path.) So: isolate to a fresh
    // COMIS_DATA_DIR, set a known master key, then pre-seed <dataDir>/secrets.db
    // using the SAME setupSecrets() result — guaranteeing the crypto + dbPath
    // match exactly what the daemon opens at boot. The daemon's buildMergedEnv →
    // secretStore.decryptAll() then overlays these secrets into the manager.
    originalDataDir = process.env["COMIS_DATA_DIR"];
    originalMasterKey = process.env["SECRETS_MASTER_KEY"];
    tempDataDir = mkdtempSync(resolve(tmpdir(), "comis-secrets-lifecycle-"));
    process.env["COMIS_DATA_DIR"] = tempDataDir;
    process.env["SECRETS_MASTER_KEY"] = randomBytes(32).toString("hex");

    // Derive crypto + dbPath exactly as the daemon will (same function, same key).
    const setup = setupSecrets({ env: process.env, dataDir: tempDataDir });
    if (!setup.ok || setup.value === null) {
      throw new Error(
        `setupSecrets failed to derive crypto/dbPath for seeding: ${setup.ok ? "null (no master key)" : setup.error.message}`,
      );
    }
    const { crypto, dbPath } = setup.value;
    const store = createSqliteSecretStore(dbPath, crypto);

    const setAllowedResult = store.set(ALLOWED_SECRET, ALLOWED_VALUE);
    if (!setAllowedResult.ok) {
      throw new Error(`Failed to set ${ALLOWED_SECRET}: ${setAllowedResult.error.message}`);
    }
    const setDeniedResult = store.set(DENIED_SECRET, DENIED_VALUE);
    if (!setDeniedResult.ok) {
      throw new Error(`Failed to set ${DENIED_SECRET}: ${setDeniedResult.error.message}`);
    }
    // Close the store so the daemon can open the same db at boot.
    store.close();

    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
    });
  }, 60_000);

  afterAll(async () => {
    // Clean up daemon first (releases the data-dir lock + closes the db).
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }

    // Restore env and remove the isolated temp data dir (secrets.db + .env + memory db).
    if (originalDataDir === undefined) {
      delete process.env["COMIS_DATA_DIR"];
    } else {
      process.env["COMIS_DATA_DIR"] = originalDataDir;
    }
    if (originalMasterKey === undefined) {
      delete process.env["SECRETS_MASTER_KEY"];
    } else {
      process.env["SECRETS_MASTER_KEY"] = originalMasterKey;
    }
    try {
      rmSync(tempDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Boot verification
  // ---------------------------------------------------------------------------

  it("daemon boots successfully with encrypted secrets store", async () => {
    expect(handle.authToken).toBeTruthy();

    const response = await fetch(`${handle.gatewayUrl}/health`);
    expect(response.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Per-agent scoping: allow
  // ---------------------------------------------------------------------------

  it("per-agent scoping allows matching secrets", () => {
    const eventBus = handle.daemon.container.eventBus;
    const events: EventMap["secret:accessed"][] = [];
    const handler = (e: EventMap["secret:accessed"]): void => {
      events.push(e);
    };
    eventBus.on("secret:accessed", handler);

    try {
      // Create a scoped manager using the daemon's real secretManager and eventBus.
      // Allow pattern TEST_ANTHROPIC_* matches ALLOWED_SECRET but not DENIED_SECRET.
      const scoped = createScopedSecretManager(
        handle.daemon.container.secretManager,
        {
          agentId: "test-agent",
          allowPatterns: ["TEST_ANTHROPIC_*"],
          eventBus,
        },
      );

      const value = scoped.get(ALLOWED_SECRET);
      expect(value).toBe(ALLOWED_VALUE);
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe("success");
      expect(events[0]!.agentId).toBe("test-agent");
      expect(events[0]!.secretName).toBe(ALLOWED_SECRET);
    } finally {
      eventBus.off("secret:accessed", handler);
    }
  });

  // ---------------------------------------------------------------------------
  // Per-agent scoping: deny
  // ---------------------------------------------------------------------------

  it("per-agent scoping denies non-matching secrets", () => {
    const eventBus = handle.daemon.container.eventBus;
    const events: EventMap["secret:accessed"][] = [];
    const handler = (e: EventMap["secret:accessed"]): void => {
      events.push(e);
    };
    eventBus.on("secret:accessed", handler);

    try {
      const scoped = createScopedSecretManager(
        handle.daemon.container.secretManager,
        {
          agentId: "restricted-agent",
          allowPatterns: ["TEST_OPENAI_*"],
          eventBus,
        },
      );

      // ALLOWED_SECRET (TEST_ANTHROPIC_*) should be denied for an agent with TEST_OPENAI_* allow pattern
      const value = scoped.get(ALLOWED_SECRET);
      expect(value).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0]!.outcome).toBe("denied");
      expect(events[0]!.agentId).toBe("restricted-agent");
      expect(events[0]!.secretName).toBe(ALLOWED_SECRET);
    } finally {
      eventBus.off("secret:accessed", handler);
    }
  });

  // ---------------------------------------------------------------------------
  // Audit event structure
  // ---------------------------------------------------------------------------

  it("secret:accessed audit events have correct structure", () => {
    const eventBus = handle.daemon.container.eventBus;
    const events: EventMap["secret:accessed"][] = [];
    const handler = (e: EventMap["secret:accessed"]): void => {
      events.push(e);
    };
    eventBus.on("secret:accessed", handler);

    try {
      const scoped = createScopedSecretManager(
        handle.daemon.container.secretManager,
        {
          agentId: "audit-test-agent",
          allowPatterns: ["TEST_ANTHROPIC_*"],
          eventBus,
        },
      );

      // Trigger a success event (allowed pattern match)
      scoped.get(ALLOWED_SECRET);
      // Trigger a denied event (pattern mismatch)
      scoped.get(DENIED_SECRET);

      expect(events).toHaveLength(2);

      for (const event of events) {
        expect(typeof event.secretName).toBe("string");
        expect(event.secretName.length).toBeGreaterThan(0);
        expect(typeof event.agentId).toBe("string");
        expect(event.agentId).toBe("audit-test-agent");
        expect(["success", "denied", "not_found"]).toContain(event.outcome);
        expect(typeof event.timestamp).toBe("number");
        expect(event.timestamp).toBeGreaterThan(0);
      }

      // Verify specific outcomes
      expect(events[0]!.outcome).toBe("success");
      expect(events[0]!.secretName).toBe(ALLOWED_SECRET);
      expect(events[1]!.outcome).toBe("denied");
      expect(events[1]!.secretName).toBe(DENIED_SECRET);
    } finally {
      eventBus.off("secret:accessed", handler);
    }
  });

  // ---------------------------------------------------------------------------
  // Base secretManager access
  // ---------------------------------------------------------------------------

  it("encrypted store secrets are accessible via base secretManager", () => {
    // The setupSecrets override injected decrypted secrets into the SecretManager
    // during daemon boot. Verify they are accessible through the base (unscoped) manager.
    // Using test-specific names (TEST_ANTHROPIC_*, TEST_OPENAI_*) avoids collisions
    // with real env vars that would override the encrypted store values.
    const allowedKey = handle.daemon.container.secretManager.get(ALLOWED_SECRET);
    expect(allowedKey).toBe(ALLOWED_VALUE);

    const deniedKey = handle.daemon.container.secretManager.get(DENIED_SECRET);
    expect(deniedKey).toBe(DENIED_VALUE);
  });
});
