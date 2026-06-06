// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for judge.ts — bench-memory judge wrapper.
 *
 * All tests are deterministic (no network, no COMIS_LIVE dependency).
 * Tests exercise skip-on-no-creds, sweepSecrets pattern matching,
 * and the "apiToken" negative case (bare "apiKey" word-boundary only).
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeAnswer, sweepSecrets } from "./judge.js";

// ---------------------------------------------------------------------------
// Env helpers — save/restore COMIS_LIVE_JUDGE_* vars around each test
// ---------------------------------------------------------------------------

const JUDGE_PROVIDER_KEY = "COMIS_LIVE_JUDGE_PROVIDER";
const JUDGE_API_KEY_KEY = "COMIS_LIVE_JUDGE_API_KEY";

afterEach(() => {
  delete process.env[JUDGE_PROVIDER_KEY];
  delete process.env[JUDGE_API_KEY_KEY];
});

// ---------------------------------------------------------------------------
// judgeAnswer — skip-on-no-creds
// ---------------------------------------------------------------------------

describe("judgeAnswer", () => {
  it("Test 1: returns skip verdict when COMIS_LIVE_JUDGE_PROVIDER is unset", async () => {
    delete process.env[JUDGE_PROVIDER_KEY];
    process.env[JUDGE_API_KEY_KEY] = "fake-key";
    const result = await judgeAnswer({
      question: "What is X?",
      context: "X is a variable.",
      answer: "X is a variable.",
      rubric: "Must mention variable.",
    });
    expect(result.verdict).toBe("skip");
    expect(result.judgeId).toBe("none");
  });

  it("Test 2: returns skip verdict when COMIS_LIVE_JUDGE_API_KEY is unset", async () => {
    process.env[JUDGE_PROVIDER_KEY] = "anthropic";
    delete process.env[JUDGE_API_KEY_KEY];
    const result = await judgeAnswer({
      question: "What is Y?",
      context: "Y is a constant.",
      answer: "Y is a constant.",
      rubric: "Must mention constant.",
    });
    expect(result.verdict).toBe("skip");
    expect(result.judgeId).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// sweepSecrets — secret-pattern matching
// ---------------------------------------------------------------------------

describe("sweepSecrets", () => {
  const TEST_TMP_BASE = join(tmpdir(), "judge-test");

  it("Test 3: sweepSecrets on nonexistent dir is a no-op (does not throw)", () => {
    expect(() => sweepSecrets("/tmp/nonexistent-dir-12345-judge-test")).not.toThrow();
  });

  it("Test 4: sweepSecrets throws SECRET LEAK for sk-* credential shape", () => {
    const dir = join(TEST_TMP_BASE, "sk-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.txt"), "sk-ant-api03-AAAA1234567890abcdef");
    try {
      expect(() => sweepSecrets(dir)).toThrow("SECRET LEAK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 5: sweepSecrets throws SECRET LEAK for Bearer credential shape", () => {
    const dir = join(TEST_TMP_BASE, "bearer-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.txt"), "Bearer abc123def456789xyz");
    try {
      expect(() => sweepSecrets(dir)).toThrow("SECRET LEAK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 6: sweepSecrets does NOT throw on 'apiToken' (not apiKey pattern)", () => {
    const dir = join(TEST_TMP_BASE, "apitoken-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.txt"), "apiToken: some-value\napiTokenValue: xyz");
    try {
      expect(() => sweepSecrets(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 7: sweepSecrets does NOT throw on bare 'apiKey' as a variable name (IN-01 fix)", () => {
    // A TypeScript source file with `const apiKey = process.env[...]` should NOT
    // trigger the pattern — only key-value assignments like apiKey: "realvalue" do.
    const dir = join(TEST_TMP_BASE, "apikey-var-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "source.ts"), 'const apiKey = process.env["COMIS_LIVE_JUDGE_API_KEY"];\nif (!apiKey) return;');
    try {
      expect(() => sweepSecrets(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Test 8: sweepSecrets DOES throw on 'apiKey: \"realvalue\"' (credential assignment shape)", () => {
    // A YAML config snippet with a real-looking apiKey value must be flagged.
    const dir = join(TEST_TMP_BASE, "apikey-val-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.yaml"), 'apiKey: "sk-ant-api03-AAAA"');
    try {
      expect(() => sweepSecrets(dir)).toThrow("SECRET LEAK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
