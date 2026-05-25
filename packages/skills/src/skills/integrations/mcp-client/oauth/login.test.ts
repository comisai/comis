// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the interactive OAuth login orchestrator.
 *
 * Focused on the catch-block logging contract — the full happy-path round-trip
 * is exercised end-to-end against the in-process mock OAuth server in
 * test/integration/mcp-oauth-roundtrip.test.ts (the build-first integration
 * tier). This file verifies that the catch block logs `err` as an Error OBJECT
 * (so the Pino serializer can emit `type`/`message`/`stack` together), not
 * `err.message` (which discards stack traces and any custom error properties).
 *
 * Coverage:
 *   1. When discovery rejects with an Error carrying a stack + a custom
 *      property, the catch's `logger.warn` payload's `err` field is the Error
 *      OBJECT (not the message string). Asserts `err instanceof Error` so a
 *      future regression to `err.message` (a string) fails loudly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTokenStore, type TokenStore } from "./token-store.js";
import { runOauthLogin } from "./login.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("runOauthLogin — catch-block logging contract", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-oauth-login-"));
    logger = makeLogger();
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      logger,
      watchPersistent: false,
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("logs the Error OBJECT (not err.message) when discovery fails — Pino serializer requirement", async () => {
    // Force the catch path by failing discovery. The orchestrator awaits
    // discovery before binding the callback server; throwing here lands in
    // the orchestrator's catch.
    const discoveryError = Object.assign(
      new Error("discovery cascade failed: no metadata endpoint reachable"),
      {
        // A non-message field that ONLY survives if `err` is logged as an
        // OBJECT — the Pino serializer reads it but `err.message` discards it.
        customField: "discovery-cascade-evidence",
      },
    );

    const result = await runOauthLogin({
      serverName: "test-server",
      serverUrl: "http://127.0.0.1:0",
      oauthConfig: {},
      createTokenStore: () => store,
      openUrl: () => undefined,
      resolveDiscovery: vi.fn(async () => {
        throw discoveryError;
      }),
      logger,
    });

    // The orchestrator NEVER throws.
    expect(result.status).toBe("failed");

    // Exactly one WARN — the catch block's "OAuth login failed".
    const warnCalls = logger.warn.mock.calls;
    const failureWarn = warnCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("OAuth login failed"),
    );
    expect(failureWarn).toBeDefined();
    const payload = failureWarn?.[0] as Record<string, unknown>;

    // `err` MUST be the Error object so Pino's serializer emits
    // `type` + `message` + `stack` + custom fields. Logging `err.message` (a
    // string) discards the stack trace and the customField evidence above.
    expect(payload.err).toBeInstanceOf(Error);
    expect(payload.err).toBe(discoveryError);
    // Confirms the custom field survived (it would NOT survive `err.message`).
    expect((payload.err as Error & { customField?: string }).customField).toBe(
      "discovery-cascade-evidence",
    );

    // The other canonical fields stay intact.
    expect(payload.errorKind).toBe("auth");
    expect(payload.serverName).toBe("test-server");
    expect(payload.submodule).toBe("oauth-login");
  });
});
