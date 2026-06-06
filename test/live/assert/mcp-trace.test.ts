// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the mcp-trace asserter (Stage-A: no daemon, no COMIS_LIVE).
 *
 * Tests that each asserter throws correctly on bad input and does not throw
 * on valid input, using synthetic McpRoundTripResult values only.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  expectMcpTaintMarkers,
  expectRateLimitRejection,
  expectTrustLevelStripped,
  type McpRoundTripResult,
} from "./mcp-trace.js";

// ---------------------------------------------------------------------------
// expectMcpTaintMarkers
// ---------------------------------------------------------------------------

describe("expectMcpTaintMarkers", () => {
  it("throws when <<<UNTRUSTED_hex>>> marker is missing", async () => {
    const result: McpRoundTripResult = {
      text: "<<<END_UNTRUSTED_abc123>>> SECURITY NOTICE MCP tool result",
      isError: false,
    };
    await expect(expectMcpTaintMarkers(result)).rejects.toThrow(/UNTRUSTED/);
  });

  it("throws when <<<END_UNTRUSTED_hex>>> marker is missing", async () => {
    const result: McpRoundTripResult = {
      text: "<<<UNTRUSTED_abc123>>> SECURITY NOTICE MCP tool result",
      isError: false,
    };
    await expect(expectMcpTaintMarkers(result)).rejects.toThrow(/END_UNTRUSTED/);
  });

  it("throws when SECURITY NOTICE is absent", async () => {
    const result: McpRoundTripResult = {
      text: "<<<UNTRUSTED_abc123>>> <<<END_UNTRUSTED_abc123>>> MCP tool result",
      isError: false,
    };
    await expect(expectMcpTaintMarkers(result)).rejects.toThrow(/SECURITY NOTICE/);
  });

  it("does NOT throw when all three patterns are present", async () => {
    const result: McpRoundTripResult = {
      text: "<<<UNTRUSTED_deadbeef01>>> SECURITY NOTICE MCP tool result <<<END_UNTRUSTED_deadbeef01>>>",
      isError: false,
    };
    await expect(expectMcpTaintMarkers(result)).resolves.toBeUndefined();
  });

  it("throws on empty text", async () => {
    const result: McpRoundTripResult = { text: "", isError: false };
    await expect(expectMcpTaintMarkers(result)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// expectRateLimitRejection
// ---------------------------------------------------------------------------

describe("expectRateLimitRejection", () => {
  it("throws when isError is false", async () => {
    const result: McpRoundTripResult = {
      text: "[rate_limit_exceeded] cap exceeded",
      isError: false,
    };
    await expect(expectRateLimitRejection(result)).rejects.toThrow(/isError/);
  });

  it("throws when text lacks [rate_limit_exceeded] and lacks 429", async () => {
    const result: McpRoundTripResult = {
      text: "some other error message",
      isError: true,
    };
    await expect(expectRateLimitRejection(result)).rejects.toThrow(/rate_limit_exceeded/);
  });

  it("does NOT throw when isError:true and text contains [rate_limit_exceeded]", async () => {
    const result: McpRoundTripResult = {
      text: "[rate_limit_exceeded] tool echo exceeded 2/min for this client; resetAt=123456",
      isError: true,
    };
    await expect(expectRateLimitRejection(result)).resolves.toBeUndefined();
  });

  it("does NOT throw when isError:true and text contains 429", async () => {
    const result: McpRoundTripResult = {
      text: "HTTP 429 too many requests",
      isError: true,
    };
    await expect(expectRateLimitRejection(result)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// expectTrustLevelStripped
// ---------------------------------------------------------------------------

describe("expectTrustLevelStripped", () => {
  it("throws when isError:true (successful call expected)", async () => {
    const result: McpRoundTripResult = {
      text: "some error",
      isError: true,
    };
    await expect(expectTrustLevelStripped(result)).rejects.toThrow(/isError/);
  });

  it("throws when text contains _trustLevel:admin", async () => {
    const result: McpRoundTripResult = {
      text: 'some result with "_trustLevel":"admin" injected',
      isError: false,
    };
    await expect(expectTrustLevelStripped(result)).rejects.toThrow(/_trustLevel/);
  });

  it("throws when text contains _trustLevel with whitespace around colon", async () => {
    const result: McpRoundTripResult = {
      text: 'result "_trustLevel" : "admin" extra',
      isError: false,
    };
    await expect(expectTrustLevelStripped(result)).rejects.toThrow(/_trustLevel/);
  });

  it("does NOT throw when text is clean (no _trustLevel:admin)", async () => {
    const result: McpRoundTripResult = {
      text: "clean result without any trust annotations",
      isError: false,
    };
    await expect(expectTrustLevelStripped(result)).resolves.toBeUndefined();
  });
});
