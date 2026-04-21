// SPDX-License-Identifier: Apache-2.0
/**
 * TOOL-LINK: Link Understanding Integration Tests
 *
 * Integration tests for link understanding pipeline via daemon RPC.
 * Tests the full link.process pipeline: URL detection -> SSRF-safe fetch ->
 * readability extraction -> context injection.
 *
 * No API key required -- uses public HTTP endpoints.
 * Phase 113 tool provider integration tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LINK_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-tool-link.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Result shape returned by the link.process RPC. */
interface LinkProcessResult {
  enrichedText: string;
  linksProcessed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("TOOL-LINK: Link Understanding Integration", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: LINK_CONFIG_PATH });

    // Access internal rpcCall from daemon instance (same pattern as media-tools tests)
    rpcCall = (handle.daemon as any).rpcCall as RpcCall;
  }, DAEMON_STARTUP_MS);

  afterAll(async () => {
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

  // -------------------------------------------------------------------------
  // LINK-01: link.process enriches text containing a real URL
  // -------------------------------------------------------------------------

  it(
    "LINK-01: link.process enriches text containing a real URL",
    async () => {
      const originalText =
        "Check out https://httpbin.org/html for test content";

      const result = (await rpcCall("link.process", {
        text: originalText,
      })) as LinkProcessResult;

      expect(result.linksProcessed).toBeGreaterThanOrEqual(1);
      expect(result.enrichedText.length).toBeGreaterThan(originalText.length);
      expect(result.errors).toHaveLength(0);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // LINK-02: link.process returns original text when no URLs present
  // -------------------------------------------------------------------------

  it(
    "LINK-02: link.process returns original text when no URLs present",
    async () => {
      const plainText = "This is plain text with no links at all";

      const result = (await rpcCall("link.process", {
        text: plainText,
      })) as LinkProcessResult;

      expect(result.linksProcessed).toBe(0);
      expect(result.enrichedText).toBe(plainText);
      expect(result.errors).toHaveLength(0);
    },
    15_000,
  );

  // -------------------------------------------------------------------------
  // LINK-03: link.process handles multiple URLs in one message
  // -------------------------------------------------------------------------

  it(
    "LINK-03: link.process handles multiple URLs in one message",
    async () => {
      const originalText =
        "See https://httpbin.org/html and https://httpbin.org/json for examples";

      const result = (await rpcCall("link.process", {
        text: originalText,
      })) as LinkProcessResult;

      expect(result.linksProcessed).toBeGreaterThanOrEqual(2);
      expect(result.enrichedText.length).toBeGreaterThan(originalText.length);
      expect(result.errors).toHaveLength(0);
    },
    45_000,
  );

  // -------------------------------------------------------------------------
  // LINK-04: link.process handles unreachable URL gracefully
  // -------------------------------------------------------------------------

  it(
    "LINK-04: link.process handles unreachable URL gracefully",
    async () => {
      const originalText =
        "Visit https://this-domain-does-not-exist-comis-test.example for info";

      // Should NOT throw -- returns a result even on fetch failure
      const result = (await rpcCall("link.process", {
        text: originalText,
      })) as LinkProcessResult;

      expect(result).toBeDefined();
      // Either fetch error recorded OR URL rejected by SSRF/DNS failure
      expect(
        result.errors.length >= 1 || result.linksProcessed === 0,
      ).toBe(true);
      // Enriched text should still contain the original text
      expect(result.enrichedText).toContain(originalText);
    },
    30_000,
  );
});
