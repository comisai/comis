// SPDX-License-Identifier: Apache-2.0
/**
 * MCP-trace asserter — typed helpers for MCP scenario tests.
 *
 * Validates that an MCP tools/call round-trip result has the expected
 * security properties: taint markers from wrapExternalContent, rate-limit
 * rejection shape, and trust-level stripping.
 *
 * All asserters follow the `async function expectX(...): Promise<void>` pattern
 * from test/live/assert/cache-trace.ts — throw descriptively on failure,
 * resolve on success.
 *
 * Error messages include the first 200 characters of the result text to aid
 * debugging without leaking secrets (T-140-01-04: truncate to 200 chars).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents the outcome of a single MCP tools/call round-trip.
 * Extracted from the first content item of the MCP response.
 */
export interface McpRoundTripResult {
  /** The text content from the first content item of the tools/call response. */
  text: string;
  /** Whether the MCP server signalled an error in this response. */
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Truncate text to at most maxLen chars for safe inclusion in error messages. */
function snippet(text: string, maxLen = 200): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…(truncated)`;
}

// ---------------------------------------------------------------------------
// expectMcpTaintMarkers
// ---------------------------------------------------------------------------

/**
 * Assert that the MCP tools/call result text contains all three taint markers
 * injected by the product's wrapExternalContent function:
 *   - /<<<UNTRUSTED_[a-f0-9]+>>>/ (open marker with random hex ID)
 *   - /<<<END_UNTRUSTED_[a-f0-9]+>>>/ (close marker with random hex ID)
 *   - "SECURITY NOTICE" (prefix block)
 *
 * These patterns mirror test/integration/mcp-server-tools-call.test.ts lines 134–136.
 *
 * @param result - The tools/call round-trip result.
 * @throws Error with descriptive message when any marker is missing.
 */
export async function expectMcpTaintMarkers(result: McpRoundTripResult): Promise<void> {
  const { text } = result;
  const snip = snippet(text);

  if (!/<<<UNTRUSTED_[a-f0-9]+>>>/.test(text)) {
    throw new Error(
      `expectMcpTaintMarkers: missing <<<UNTRUSTED_hex>>> open marker.\n` +
        `  Expected regex: /<<<UNTRUSTED_[a-f0-9]+>>>/\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }

  if (!/<<<END_UNTRUSTED_[a-f0-9]+>>>/.test(text)) {
    throw new Error(
      `expectMcpTaintMarkers: missing <<<END_UNTRUSTED_hex>>> close marker.\n` +
        `  Expected regex: /<<<END_UNTRUSTED_[a-f0-9]+>>>/\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }

  if (!text.includes("SECURITY NOTICE")) {
    throw new Error(
      `expectMcpTaintMarkers: missing "SECURITY NOTICE" prefix block.\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }
}

// ---------------------------------------------------------------------------
// expectRateLimitRejection
// ---------------------------------------------------------------------------

/**
 * Assert that the MCP tools/call result represents a rate-limit rejection.
 *
 * A valid rate-limit rejection must:
 *   1. Have isError === true
 *   2. Have text containing "[rate_limit_exceeded]" (product prefix from
 *      mcp-server-handlers.ts ~line 390) OR "429"
 *
 * @param result - The tools/call round-trip result.
 * @throws Error when isError is false or when the rate-limit marker is absent.
 */
export async function expectRateLimitRejection(result: McpRoundTripResult): Promise<void> {
  const { text, isError } = result;
  const snip = snippet(text);

  if (!isError) {
    throw new Error(
      `expectRateLimitRejection: expected isError=true but got isError=false.\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }

  const hasRateLimitMarker = text.includes("[rate_limit_exceeded]") || text.includes("429");
  if (!hasRateLimitMarker) {
    throw new Error(
      `expectRateLimitRejection: expected text to contain "[rate_limit_exceeded]" or "429".\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }
}

// ---------------------------------------------------------------------------
// expectTrustLevelStripped
// ---------------------------------------------------------------------------

/**
 * Assert that the MCP tools/call result does NOT contain an injected
 * _trustLevel:"admin" field — i.e. the product's trust-strip pipeline removed it.
 *
 * A valid stripped result must:
 *   1. Have isError === false (a successful call is expected)
 *   2. Have text NOT matching /"_trustLevel"\s*:\s*"admin"/
 *
 * @param result - The tools/call round-trip result.
 * @throws Error when isError is true or when the trust-level field is still present.
 */
export async function expectTrustLevelStripped(result: McpRoundTripResult): Promise<void> {
  const { text, isError } = result;
  const snip = snippet(text);

  if (isError) {
    throw new Error(
      `expectTrustLevelStripped: expected a successful call (isError=false) ` +
        `but got isError=true.\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }

  if (/"_trustLevel"\s*:\s*"admin"/.test(text)) {
    throw new Error(
      `expectTrustLevelStripped: _trustLevel:"admin" still present in result ` +
        `— trust-strip pipeline did not remove the hostile field.\n` +
        `  Actual text (first 200 chars): ${snip}`,
    );
  }
}
