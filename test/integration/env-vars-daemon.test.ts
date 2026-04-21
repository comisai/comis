// SPDX-License-Identifier: Apache-2.0
/**
 * Environment Variables E2E Tests (real daemon)
 *
 * Validates the full environment variable lifecycle through a running daemon:
 * - COMIS_CONFIG_PATHS resolution selects the correct config file
 * - SecretManager is created from process.env at bootstrap time
 * - SecretManager snapshot is isolated from post-bootstrap process.env mutations
 * - Provider key naming pattern ({PROVIDER}_API_KEY) matches executor convention
 * - COMIS_GATEWAY_URL and COMIS_GATEWAY_TOKEN direct withClient to the daemon
 *
 * Uses a single daemon instance shared across all describe blocks.
 * Port 8499 is assigned exclusively to this test suite.
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { withClient } from "@comis/cli";
import type { SecretManager } from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-env-vars.yaml");

// ---------------------------------------------------------------------------
// Shared daemon instance
// ---------------------------------------------------------------------------

let handle: TestDaemonHandle;

/**
 * Set a custom env var BEFORE daemon startup so the SecretManager snapshot
 * captures it. Since integration tests use pool: "forks", each test file
 * gets its own process, so this is safe.
 */
const CUSTOM_ENV_KEY = "COMIS_TEST_CUSTOM_KEY";
const CUSTOM_ENV_VALUE = "test-value-123";

beforeAll(async () => {
  // Set custom env var before daemon start so SecretManager captures it
  process.env[CUSTOM_ENV_KEY] = CUSTOM_ENV_VALUE;

  handle = await startTestDaemon({ configPath: CONFIG_PATH });
}, 60_000);

afterAll(async () => {
  // Clean up env vars set during tests
  delete process.env[CUSTOM_ENV_KEY];
  delete process.env["POST_BOOT_KEY"];
  delete process.env["COMIS_GATEWAY_URL"];
  delete process.env["COMIS_GATEWAY_TOKEN"];

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
}, 30_000);

// ---------------------------------------------------------------------------
// 1. COMIS_CONFIG_PATHS resolution
// ---------------------------------------------------------------------------

describe("COMIS_CONFIG_PATHS resolution", () => {
  it("daemon loaded config from specified path (tenantId matches)", () => {
    expect(handle.daemon.container.config.tenantId).toBe("env-vars-test");
  });

  it("gateway is listening on the configured port (8499)", async () => {
    // Verify the URL contains the correct port
    expect(handle.gatewayUrl).toContain("8499");

    // Verify the gateway actually responds to health checks
    const response = await fetch(`${handle.gatewayUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body).toHaveProperty("status", "ok");
  });

  it("config file paths are honoured (logLevel matches YAML)", () => {
    // The daemon harness sets COMIS_CONFIG_PATHS internally.
    // Verify the loaded config matches what the YAML file specifies.
    expect(handle.daemon.container.config.logLevel).toBe("debug");
  });
});

// ---------------------------------------------------------------------------
// 2. SecretManager through daemon bootstrap
// ---------------------------------------------------------------------------

describe("SecretManager through daemon bootstrap", () => {
  it("SecretManager is available on the container with expected API", () => {
    const sm = handle.daemon.container.secretManager as SecretManager;
    expect(sm).toBeDefined();
    expect(typeof sm.get).toBe("function");
    expect(typeof sm.has).toBe("function");
    expect(typeof sm.keys).toBe("function");
    expect(typeof sm.require).toBe("function");
  });

  it("SecretManager contains keys from process.env set before daemon start", () => {
    const sm = handle.daemon.container.secretManager as SecretManager;
    // We set COMIS_TEST_CUSTOM_KEY before startTestDaemon, so the
    // SecretManager snapshot (created from process.env at bootstrap) should
    // contain it.
    expect(sm.has(CUSTOM_ENV_KEY)).toBe(true);
    expect(sm.get(CUSTOM_ENV_KEY)).toBe(CUSTOM_ENV_VALUE);
  });

  it("SecretManager snapshot is isolated from post-bootstrap process.env mutations", () => {
    // Set a new env var AFTER daemon is already running
    process.env["POST_BOOT_KEY"] = "should-not-exist-in-snapshot";

    const sm = handle.daemon.container.secretManager as SecretManager;

    // The SecretManager was created at bootstrap time from a snapshot of
    // process.env. Keys added after bootstrap should NOT appear.
    expect(sm.has("POST_BOOT_KEY")).toBe(false);
    expect(sm.get("POST_BOOT_KEY")).toBeUndefined();

    // Clean up
    delete process.env["POST_BOOT_KEY"];
  });
});

// ---------------------------------------------------------------------------
// 3. CLI env vars with running daemon
// ---------------------------------------------------------------------------

describe("CLI env vars with running daemon", () => {
  it("withClient connects via COMIS_GATEWAY_URL", async () => {
    // Set COMIS_GATEWAY_URL to direct withClient to our test daemon.
    // Also set COMIS_GATEWAY_TOKEN so authentication succeeds --
    // without it, withClient falls back to ~/.comis/config.yaml which
    // may have a different token.
    process.env["COMIS_GATEWAY_URL"] = `ws://localhost:8499/ws`;
    process.env["COMIS_GATEWAY_TOKEN"] = "env-test-secret-1234-padded-to-32ch";

    try {
      // withClient should connect to the daemon via the URL env var
      // and successfully call config.get
      const result = await withClient(async (client) => {
        return client.call("config.get", {});
      });

      // config.get returns the full config object -- proves the URL
      // directed the client to the correct daemon
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    } finally {
      delete process.env["COMIS_GATEWAY_URL"];
      delete process.env["COMIS_GATEWAY_TOKEN"];
    }
  });

  it("withClient authenticates via COMIS_GATEWAY_TOKEN", async () => {
    // Set both env vars -- URL to find the daemon, token to authenticate
    process.env["COMIS_GATEWAY_URL"] = `ws://localhost:8499/ws`;
    process.env["COMIS_GATEWAY_TOKEN"] = "env-test-secret-1234-padded-to-32ch";

    try {
      // withClient reads both env vars and connects + authenticates
      const result = await withClient(async (client) => {
        return client.call("config.get", {});
      });

      // Successful response proves both URL and token env vars work together
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");

      // Verify it returned actual config data (tenantId proves it came from
      // the correct daemon)
      const config = result as Record<string, unknown>;
      expect(config.tenantId).toBe("env-vars-test");
    } finally {
      delete process.env["COMIS_GATEWAY_URL"];
      delete process.env["COMIS_GATEWAY_TOKEN"];
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Provider key naming pattern
// ---------------------------------------------------------------------------

describe("Provider key naming pattern", () => {
  it("agent config specifies provider 'anthropic'", () => {
    const agents = handle.daemon.container.config.agents as Record<
      string,
      { provider: string; [key: string]: unknown }
    >;

    // Find the default agent configured with provider: "anthropic"
    const defaultAgent = agents.default;
    expect(defaultAgent).toBeDefined();
    expect(defaultAgent.provider).toBe("anthropic");

    // Derive the expected key name following the daemon wiring convention:
    // SecretManager key format: `${provider.toUpperCase()}_API_KEY`
    const expectedKeyName = `${defaultAgent.provider.toUpperCase()}_API_KEY`;
    expect(expectedKeyName).toBe("ANTHROPIC_API_KEY");
  });

  it("SecretManager provider key lookup matches executor pattern", () => {
    const sm = handle.daemon.container.secretManager as SecretManager;
    const agents = handle.daemon.container.config.agents as Record<
      string,
      { provider: string; [key: string]: unknown }
    >;

    const provider = agents.default.provider;
    const apiKeyName = `${provider.toUpperCase()}_API_KEY`;

    if (sm.has(apiKeyName)) {
      // If the key exists in the env (e.g., developer machine with real keys),
      // verify it returns a non-empty string -- structural correctness
      const value = sm.get(apiKeyName);
      expect(typeof value).toBe("string");
      expect(value!.length).toBeGreaterThan(0);
    } else {
      // If the key doesn't exist (e.g., CI without provider keys),
      // verify the structural pattern: get() returns undefined, has() returns false
      expect(sm.get(apiKeyName)).toBeUndefined();
      expect(sm.has(apiKeyName)).toBe(false);
    }

    // Either way, verify the key name matches the {PROVIDER}_API_KEY pattern
    expect(apiKeyName).toMatch(/^[A-Z]+_API_KEY$/);
  });
});
