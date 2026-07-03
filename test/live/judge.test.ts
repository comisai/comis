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
const JUDGE_MODEL_KEY = "COMIS_LIVE_JUDGE_MODEL";

afterEach(() => {
  delete process.env[JUDGE_PROVIDER_KEY];
  delete process.env[JUDGE_API_KEY_KEY];
  delete process.env[JUDGE_MODEL_KEY];
});

// ---------------------------------------------------------------------------
// fakeJudgeComplete — a deterministic DI stub mirroring
// packages/agent/src/memory/benchmark/__fixtures__/qa-judge-stub.ts `fakeComplete`:
// a thunk resolving to one text content block. Lets the NON-skip path run WITHOUT
// a real provider/key (the Stage-C wiring proof, deterministic).
// ---------------------------------------------------------------------------
const fakeJudgeComplete =
  (reply: string) =>
  async () => ({
    content: [{ type: "text" as const, text: reply }],
    usage: { totalTokens: 7 },
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
// judgeAnswer — the NON-skip path (judge env present), driven by a STUB complete
// fn so the real qa-judge invocation is exercised WITHOUT a real provider/key.
// judgeAnswer must actually score (pass|fail) when the judge env is present,
// KEEP the no-env skip, and treat an unparseable judge verdict as skip (never a
// wrong answer).
// ---------------------------------------------------------------------------

describe("judgeAnswer — non-skip path (env present, stubbed judge)", () => {
  it("Test 9: a stubbed correct verdict → verdict 'pass' + a real judgeId (not 'pending'/'none')", async () => {
    process.env[JUDGE_PROVIDER_KEY] = "anthropic";
    process.env[JUDGE_API_KEY_KEY] = "test-fixture-not-a-real-key";
    process.env[JUDGE_MODEL_KEY] = "claude-3-5-haiku-20241022";
    const result = await judgeAnswer(
      { question: "What is 2+2?", context: "math", answer: "4", rubric: "correct iff the answer is 4" },
      { complete: fakeJudgeComplete('{"correct": true, "reasoning": "4 is right"}') },
    );
    expect(result.verdict).toBe("pass");
    expect(result.judgeId).not.toBe("pending");
    expect(result.judgeId).not.toBe("none");
    expect(result.judgeId).toContain("anthropic");
    expect(result.judgeId).toContain("claude-3-5-haiku-20241022");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("Test 10: a stubbed incorrect verdict → verdict 'fail'", async () => {
    process.env[JUDGE_PROVIDER_KEY] = "openai";
    process.env[JUDGE_API_KEY_KEY] = "test-fixture-not-a-real-key";
    const result = await judgeAnswer(
      { question: "What is 2+2?", context: "math", answer: "5", rubric: "correct iff the answer is 4" },
      { complete: fakeJudgeComplete('{"correct": false, "reasoning": "5 is wrong"}') },
    );
    expect(result.verdict).toBe("fail");
  });

  it("Test 11: an UNPARSEABLE judge output → verdict 'skip' (invalid, NOT scored as pass/fail)", async () => {
    process.env[JUDGE_PROVIDER_KEY] = "anthropic";
    process.env[JUDGE_API_KEY_KEY] = "test-fixture-not-a-real-key";
    const result = await judgeAnswer(
      { question: "Q", context: "C", answer: "A", rubric: "R" },
      { complete: fakeJudgeComplete("I am unable to decide; here is some prose with no verdict token.") },
    );
    // An unparseable judge is INVALID — excluded, not counted wrong (bench discipline).
    expect(result.verdict).toBe("skip");
    expect(result.verdict).not.toBe("pass");
    expect(result.verdict).not.toBe("fail");
  });

  it("Test 12: the returned reason never contains the api-key value (residency)", async () => {
    const secret = "test-fixture-not-a-real-key";
    process.env[JUDGE_PROVIDER_KEY] = "anthropic";
    process.env[JUDGE_API_KEY_KEY] = secret;
    const result = await judgeAnswer(
      { question: "Q", context: "C", answer: "A", rubric: "R" },
      { complete: fakeJudgeComplete('{"correct": true, "reasoning": "ok"}') },
    );
    expect(result.reason).not.toContain(secret);
    expect(result.judgeId).not.toContain(secret);
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

  it("Test 7: sweepSecrets does NOT throw on bare 'apiKey' as a variable name", () => {
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
