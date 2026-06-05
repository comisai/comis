// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A TDD unit tests for the CredentialRegistry and capability registry.
 *
 * These tests import from ./credentials.ts which does not yet exist — they MUST FAIL
 * on the pre-patch codebase (RED phase). No real API calls; no real budget consumed.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildCredentialRegistry } from "./credentials.js";

describe("buildCredentialRegistry — ANTHROPIC_API_KEY absent", () => {
  let savedAnthropicKey: string | undefined;

  beforeEach(() => {
    savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (savedAnthropicKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    }
  });

  it("getSkipVerdict('LLM(anthropic)') returns SKIPPED(no-creds) when ANTHROPIC_API_KEY is unset", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("LLM(anthropic)")).toBe("SKIPPED(no-creds)");
  });
});

describe("buildCredentialRegistry — ANTHROPIC_API_KEY present", () => {
  let savedAnthropicKey: string | undefined;

  beforeEach(() => {
    savedAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-key-1234567890";
  });

  afterEach(() => {
    if (savedAnthropicKey === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = savedAnthropicKey;
    }
  });

  it("getSkipVerdict('LLM(anthropic)') returns null when ANTHROPIC_API_KEY is set", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("LLM(anthropic)")).toBeNull();
  });

  it("getUnlockedCategories() includes LLM(anthropic) and CACHE(Anthropic) when ANTHROPIC_API_KEY is set", () => {
    const registry = buildCredentialRegistry();
    const categories = registry.getUnlockedCategories();
    expect(categories).toContain("LLM(anthropic)");
    expect(categories).toContain("CACHE(Anthropic)");
  });
});

describe("buildCredentialRegistry — platform verdicts", () => {
  it("getSkipVerdict('linux-only') returns SKIPPED(linux-only) on darwin", () => {
    // This test is conditional on process.platform — on darwin (dev box) it must return SKIPPED(linux-only)
    const registry = buildCredentialRegistry();
    if (process.platform !== "linux") {
      expect(registry.getSkipVerdict("linux-only")).toBe("SKIPPED(linux-only)");
    } else {
      // On Linux, the verdict depends on bwrap availability; it should NOT be SKIPPED(linux-only)
      const verdict = registry.getSkipVerdict("linux-only");
      expect(verdict).not.toBe("SKIPPED(linux-only)");
    }
  });

  it("getSkipVerdict('bwrap') returns SKIPPED(no-bwrap) or SKIPPED(linux-only) when bwrap is not available", () => {
    const registry = buildCredentialRegistry();
    const verdict = registry.getSkipVerdict("bwrap");
    // On darwin: always SKIPPED(linux-only); on linux without bwrap: SKIPPED(no-bwrap); on linux with bwrap: null
    expect(["SKIPPED(no-bwrap)", "SKIPPED(linux-only)", null]).toContain(verdict);
  });
});

describe("buildCredentialRegistry — OPENAI_API_KEY present", () => {
  let savedOpenaiKey: string | undefined;

  beforeEach(() => {
    savedOpenaiKey = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-openai-test-key-1234567890";
  });

  afterEach(() => {
    if (savedOpenaiKey === undefined) {
      delete process.env["OPENAI_API_KEY"];
    } else {
      process.env["OPENAI_API_KEY"] = savedOpenaiKey;
    }
  });

  it("getUnlockedCategories() includes all 6 openai-unlocked categories when OPENAI_API_KEY is set", () => {
    const registry = buildCredentialRegistry();
    const categories = registry.getUnlockedCategories();
    expect(categories).toContain("LLM(openai)");
    expect(categories).toContain("STT(openai)");
    expect(categories).toContain("TTS(openai)");
    expect(categories).toContain("vision(openai)");
    expect(categories).toContain("image-gen(openai)");
    expect(categories).toContain("embedding(openai)");
  });
});
