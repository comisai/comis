// SPDX-License-Identifier: Apache-2.0
/**
 * Output Guard end-to-end integration test.
 *
 * Drives the OutputGuard adapter with realistic, multi-pattern LLM responses
 * and asserts:
 *   - canary leakage is detected (`canary_leak` finding) and redacted
 *     in `sanitized` -- driven by generateCanaryToken so the test exercises
 *     the same construction path used at runtime
 *   - secret-shaped strings (AWS key, GitHub token, JWT, db connection
 *     string, generic key=value) are detected and the critical ones are
 *     redacted in place
 *   - the AuditAggregator + TypedEventBus path emits a single
 *     "security:injection_detected" summary on flush after multiple raw
 *     events -- proving the deduplication seam works end-to-end
 *   - benign content with secret-adjacent shapes (long alnum URL fragment,
 *     long base64 image data) is NOT redacted into oblivion
 *   - prompt-extraction phrases are recorded as warnings but `sanitized`
 *     leaves the original text intact (warning-only behavior is contractual)
 *
 * No daemon is required -- this exercises the security stack as it would
 * run inside an agent's response-filter pipeline.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createOutputGuard,
  generateCanaryToken,
  TypedEventBus,
  createAuditAggregator,
  type AuditAggregator,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Fixtures: secret-shaped strings (placeholders -- not real credentials)
// ---------------------------------------------------------------------------

const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const FAKE_GITHUB_TOKEN = "ghp_1234567890abcdef1234567890abcdef1234";
const FAKE_DB_URL = "postgres://user_a:supersecret@db.example.com:5432/app";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJ1c2VyX2EiLCJpYXQiOjE2MDAwMDAwMDB9." +
  "abc123abc123abc123abc123abc123abc123abc1";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Output Guard -- canary detection", () => {
  it("detects and redacts a leaked canary token", () => {
    const sessionKey = "test:user_a:chan_001";
    const canary = generateCanaryToken(sessionKey, "test-canary-secret");
    const guard = createOutputGuard();

    const response = `Sure, here is the secret marker you asked about: ${canary}.`;

    const r = guard.scan(response, { canaryToken: canary });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.safe).toBe(false);
    expect(r.value.blocked).toBe(true);
    expect(r.value.sanitized).not.toContain(canary);
    expect(r.value.sanitized).toContain("[REDACTED:canary]");
    expect(
      r.value.findings.some(
        (f) => f.type === "canary_leak" && f.severity === "critical",
      ),
    ).toBe(true);
  });

  it("emits no canary_leak finding when canary is absent", () => {
    const canary = generateCanaryToken("test:user_a:chan_001", "secret");
    const guard = createOutputGuard();

    const r = guard.scan("Plain assistant response with no markers.", {
      canaryToken: canary,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.findings.some((f) => f.type === "canary_leak"),
    ).toBe(false);
  });

  it("treats the canary as the same value across two distinct scans", () => {
    const sessionKey = "test:user_a:chan_001";
    const a = generateCanaryToken(sessionKey, "secret-v1");
    const b = generateCanaryToken(sessionKey, "secret-v1");
    expect(a).toBe(b);
    expect(a).toMatch(/^CTKN_[0-9a-f]{16}$/);
  });

  it("redacts every occurrence when canary appears multiple times", () => {
    const canary = generateCanaryToken("test:user_a:chan_001", "secret");
    const guard = createOutputGuard();

    const response = `Marker A: ${canary}. Marker B: ${canary}. Marker C: ${canary}.`;
    const r = guard.scan(response, { canaryToken: canary });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sanitized.includes(canary)).toBe(false);
    const reductions =
      r.value.sanitized.match(/\[REDACTED:canary\]/g) ?? [];
    expect(reductions.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Multi-pattern secret detection
// ---------------------------------------------------------------------------

describe("Output Guard -- multi-pattern secret detection", () => {
  it("detects an AWS key id and reports critical severity", () => {
    const guard = createOutputGuard();
    const r = guard.scan(`The key is ${FAKE_AWS_KEY} -- careful.`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const aws = r.value.findings.find((f) => f.pattern === "aws_key");
    expect(aws).toBeDefined();
    expect(aws?.severity).toBe("critical");
    expect(r.value.sanitized).not.toContain(FAKE_AWS_KEY);
    expect(r.value.sanitized).toContain("[REDACTED:aws_key]");
  });

  it("detects a GitHub PAT and redacts it", () => {
    const guard = createOutputGuard();
    const r = guard.scan(`token: ${FAKE_GITHUB_TOKEN}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gh = r.value.findings.find((f) => f.pattern === "github_token");
    expect(gh).toBeDefined();
    expect(r.value.sanitized).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it("detects a Postgres connection string and redacts it", () => {
    const guard = createOutputGuard();
    const r = guard.scan(`Use this URL: ${FAKE_DB_URL}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const db = r.value.findings.find(
      (f) => f.pattern === "db_connection_string",
    );
    expect(db).toBeDefined();
    expect(db?.severity).toBe("critical");
    expect(r.value.sanitized).not.toContain("supersecret");
  });

  it("detects a JWT but treats it as a warning (no redaction)", () => {
    const guard = createOutputGuard();
    const r = guard.scan(`token=${FAKE_JWT}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // JWT shape is detect-only -- the unit tests of output-guard pin this
    // contract; we re-assert it here so a future critical-upgrade is caught
    // by integration coverage, not silently shipped.
    const jwt = r.value.findings.find((f) => f.pattern === "jwt_token");
    expect(jwt).toBeDefined();
    expect(jwt?.severity).toBe("warning");
  });

  it("detects multiple distinct secret patterns in one response", () => {
    const guard = createOutputGuard();
    const composite =
      `aws=${FAKE_AWS_KEY}\n` +
      `gh=${FAKE_GITHUB_TOKEN}\n` +
      `db=${FAKE_DB_URL}\n`;
    const r = guard.scan(composite);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.blocked).toBe(true);
    const patterns = new Set(r.value.findings.map((f) => f.pattern));
    expect(patterns.has("aws_key")).toBe(true);
    expect(patterns.has("github_token")).toBe(true);
    expect(patterns.has("db_connection_string")).toBe(true);
    expect(r.value.sanitized).not.toContain(FAKE_AWS_KEY);
    expect(r.value.sanitized).not.toContain(FAKE_GITHUB_TOKEN);
    expect(r.value.sanitized).not.toContain("supersecret");
  });
});

// ---------------------------------------------------------------------------
// False-positive boundary: do not over-block benign content
// ---------------------------------------------------------------------------

describe("Output Guard -- false-positive boundary", () => {
  it("does not redact a benign URL fragment that happens to contain alnum chars", () => {
    const guard = createOutputGuard();
    const benign =
      "Visit https://example.com/path?ref=v1.2.3-beta&utm_source=docs " +
      "for details.";
    const r = guard.scan(benign);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.blocked).toBe(false);
    expect(r.value.sanitized).toBe(benign);
  });

  it("does not redact a long base64 image fragment in markdown", () => {
    // 32 bytes of base64 -- longer than typical secrets but in a context
    // (data: URI inside an image tag) the guard should not break.
    const guard = createOutputGuard();
    const benign =
      "Embedded image: ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA==)";
    const r = guard.scan(benign);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No critical finding should fire -- if the future regex evolution
    // broadens the base64 secret pattern this test will catch the regression.
    expect(r.value.blocked).toBe(false);
  });

  it("returns safe=true on a fully clean response", () => {
    const guard = createOutputGuard();
    const r = guard.scan("Hi user_a, your task list has 3 items.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.safe).toBe(true);
    expect(r.value.blocked).toBe(false);
    expect(r.value.findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt-extraction phrases (warning-only)
// ---------------------------------------------------------------------------

describe("Output Guard -- prompt extraction (warning-only)", () => {
  it("flags 'the system prompt is' phrase without redacting", () => {
    const guard = createOutputGuard();
    // SYSTEM_PROMPT_LABEL regex: (?:my|the)\s+system\s+prompt\s+(?:is|says|reads|contains)
    const response =
      "Here is what I was told: the system prompt is to be helpful.";
    const r = guard.scan(response);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ext = r.value.findings.find(
      (f) => f.type === "prompt_extraction",
    );
    expect(ext).toBeDefined();
    expect(ext?.severity).toBe("warning");
    // Warning level: sanitized should NOT redact the phrase.
    expect(r.value.sanitized).toBe(response);
    // Block status driven by criticals only; warnings alone do not block.
    expect(r.value.blocked).toBe(false);
  });

  it("flags 'my original instructions are' phrase as warning", () => {
    const guard = createOutputGuard();
    // INSTRUCTIONS_LABEL regex: (?:my|the)\s+(?:original|initial)\s+instructions?\s+(?:are|is|say)
    const r = guard.scan(
      "Sure -- my original instructions are to keep it concise.",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.findings.some(
        (f) =>
          f.type === "prompt_extraction" && f.pattern === "instructions_label",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuditAggregator + TypedEventBus seam
// ---------------------------------------------------------------------------

describe("Output Guard -- audit aggregation seam", () => {
  let bus: TypedEventBus;
  let aggregator: AuditAggregator;
  let received: Array<{ patterns: readonly string[]; source: string }>;

  beforeEach(() => {
    bus = new TypedEventBus();
    received = [];
    bus.on("security:injection_detected", (payload) => {
      received.push({
        patterns: payload.patterns,
        source: payload.source,
      });
    });
    aggregator = createAuditAggregator(bus, {
      windowMs: 60_000,
      maxPatternsPerSummary: 10,
    });
  });

  afterEach(() => {
    aggregator.destroy();
  });

  it("emits a single summary on flush() after multiple recorded events", () => {
    aggregator.record({
      source: "tool_output",
      patterns: ["aws_key"],
      riskLevel: "high",
    });
    aggregator.record({
      source: "tool_output",
      patterns: ["github_token"],
      riskLevel: "high",
    });
    aggregator.record({
      source: "tool_output",
      patterns: ["db_connection_string"],
      riskLevel: "high",
    });

    expect(received.length).toBe(0); // Window not closed yet
    aggregator.flush();

    expect(received.length).toBe(1);
    const ev = received[0]!;
    // The aggregator emits with source "external_content" by current contract.
    expect(ev.source).toBe("external_content");
    // All 3 unique patterns must be in the summary.
    const summary = new Set(ev.patterns);
    expect(summary.has("aws_key")).toBe(true);
    expect(summary.has("github_token")).toBe(true);
    expect(summary.has("db_connection_string")).toBe(true);
  });

  it("dedupes the same pattern repeated within a window", () => {
    for (let i = 0; i < 10; i++) {
      aggregator.record({
        source: "user_input",
        patterns: ["aws_key"],
      });
    }
    aggregator.flush();
    expect(received.length).toBe(1);
    expect(received[0]!.patterns).toEqual(["aws_key"]);
  });

  it("destroy() emits no summaries (clean shutdown)", () => {
    aggregator.record({
      source: "tool_output",
      patterns: ["aws_key"],
    });
    aggregator.destroy();
    expect(received.length).toBe(0);
  });
});
