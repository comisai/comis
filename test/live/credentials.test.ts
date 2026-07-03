// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the CredentialRegistry and capability registry.
 *
 * No real API calls; no real budget consumed.
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

describe("CredentialRegistry — key-to-category mapping (XAI_API_KEY + JINA_API_KEY)", () => {
  // Save and restore env around each test that mutates process.env
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      XAI_API_KEY: process.env["XAI_API_KEY"],
      JINA_API_KEY: process.env["JINA_API_KEY"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("XAI_API_KEY present → getSkipVerdict('search(grok)') returns null", () => {
    process.env["XAI_API_KEY"] = "test-key";
    delete process.env["JINA_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(grok)")).toBeNull();
  });

  it("XAI_API_KEY absent → getSkipVerdict('search(grok)') returns SKIPPED(no-creds)", () => {
    delete process.env["XAI_API_KEY"];
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(grok)")).toBe("SKIPPED(no-creds)");
  });

  it("JINA_API_KEY present → getSkipVerdict('search(jina)') returns null", () => {
    process.env["JINA_API_KEY"] = "test-key";
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(jina)")).toBeNull();
  });

  it("JINA_API_KEY absent → getSkipVerdict('search(jina)') returns SKIPPED(no-creds)", () => {
    delete process.env["JINA_API_KEY"];
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(jina)")).toBe("SKIPPED(no-creds)");
  });

  it("GROK_API_KEY is not a recognized key (old key name removed)", () => {
    // Setting the old key name must not unlock search(grok)
    delete process.env["XAI_API_KEY"];
    (process.env as Record<string, string>)["GROK_API_KEY"] = "test-key";
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(grok)")).toBe("SKIPPED(no-creds)");
    delete (process.env as Record<string, string>)["GROK_API_KEY"];
  });

  it("ANTHROPIC_API_KEY present → LLM(anthropic) and CACHE(Anthropic) unlocked", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("LLM(anthropic)")).toBeNull();
    expect(registry.getSkipVerdict("CACHE(Anthropic)")).toBeNull();
  });

  it("ANTHROPIC_API_KEY present → vision(anthropic) unlocked", () => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("vision(anthropic)")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// keyless categories — always runnable regardless of credentials
// ---------------------------------------------------------------------------

describe("buildCredentialRegistry — keyless categories", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
      SEARCH_API_KEY: process.env["SEARCH_API_KEY"],
    };
    // Remove all credentials so we verify keyless categories work without any key
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["SEARCH_API_KEY"];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it("TTS(edge) returns null (runnable) even with no credentials", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("TTS(edge)")).toBeNull();
  });

  it("search(duckduckgo) returns null (runnable) even with no credentials", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(duckduckgo)")).toBeNull();
  });

  it("search(searxng) returns null (runnable) even with no credentials", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(searxng)")).toBeNull();
  });

  it("mcp.transport=stdio returns null (runnable) even with no credentials", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("mcp.transport=stdio")).toBeNull();
  });

  it("channel-echo returns null (runnable) even with no credentials", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("channel-echo")).toBeNull();
  });

  it("absent-keyed category (e.g. LLM(anthropic)) still returns SKIPPED(no-creds) without key", () => {
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("LLM(anthropic)")).toBe("SKIPPED(no-creds)");
  });
});

// ---------------------------------------------------------------------------
// canonical Brave env var is SEARCH_API_KEY (not BRAVE_API_KEY)
// ---------------------------------------------------------------------------

describe("buildCredentialRegistry — SEARCH_API_KEY unlocks search(brave)", () => {
  let savedSearchKey: string | undefined;

  beforeEach(() => {
    savedSearchKey = process.env["SEARCH_API_KEY"];
  });

  afterEach(() => {
    if (savedSearchKey === undefined) {
      delete process.env["SEARCH_API_KEY"];
    } else {
      process.env["SEARCH_API_KEY"] = savedSearchKey;
    }
  });

  it("SEARCH_API_KEY present → search(brave) returns null (runnable)", () => {
    process.env["SEARCH_API_KEY"] = "BSAtest-key";
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(brave)")).toBeNull();
  });

  it("SEARCH_API_KEY absent → search(brave) returns SKIPPED(no-creds)", () => {
    delete process.env["SEARCH_API_KEY"];
    const registry = buildCredentialRegistry();
    expect(registry.getSkipVerdict("search(brave)")).toBe("SKIPPED(no-creds)");
  });
});
