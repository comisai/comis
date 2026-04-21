// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { validateApiKey, getKeyPrefix } from "./api-key.js";

describe("validateApiKey", () => {
  describe("valid keys by provider", () => {
    it("accepts valid anthropic key", () => {
      const key = "sk-ant-" + "a".repeat(34); // 40 chars total
      expect(validateApiKey("anthropic", key)).toBeUndefined();
    });

    it("accepts valid openai key", () => {
      const key = "sk-" + "a".repeat(17); // 20 chars total
      expect(validateApiKey("openai", key)).toBeUndefined();
    });

    it("accepts valid google key", () => {
      const key = "AI" + "a".repeat(18); // 20 chars total
      expect(validateApiKey("google", key)).toBeUndefined();
    });

    it("accepts valid groq key", () => {
      const key = "gsk_" + "a".repeat(16); // 20 chars total
      expect(validateApiKey("groq", key)).toBeUndefined();
    });

    it("accepts valid xai key", () => {
      const key = "xai-" + "a".repeat(16); // 20 chars total
      expect(validateApiKey("xai", key)).toBeUndefined();
    });

    it("accepts valid openrouter key", () => {
      const key = "sk-or-" + "a".repeat(14); // 20 chars total
      expect(validateApiKey("openrouter", key)).toBeUndefined();
    });

    it("accepts valid deepseek key", () => {
      const key = "sk-" + "a".repeat(17); // 20 chars total
      expect(validateApiKey("deepseek", key)).toBeUndefined();
    });
  });

  describe("ollama (no key required)", () => {
    it("accepts empty string for ollama", () => {
      expect(validateApiKey("ollama", "")).toBeUndefined();
    });

    it("accepts random string for ollama", () => {
      expect(validateApiKey("ollama", "anything-goes")).toBeUndefined();
    });
  });

  describe("empty key", () => {
    it("returns error for empty key on anthropic", () => {
      const result = validateApiKey("anthropic", "");
      expect(result).toBeDefined();
      expect(result!.message).toBe("API key is required.");
    });

    it("returns error for whitespace-only key", () => {
      const result = validateApiKey("openai", "   ");
      expect(result).toBeDefined();
      expect(result!.message).toBe("API key is required.");
    });
  });

  describe("wrong prefix", () => {
    it("rejects anthropic key with wrong prefix (sk- instead of sk-ant-)", () => {
      const key = "sk-" + "a".repeat(37); // has sk- but not sk-ant-
      const result = validateApiKey("anthropic", key);
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with");
      expect(result!.message).toContain("sk-ant-");
    });

    it("rejects openai key with wrong prefix", () => {
      const key = "gsk_" + "a".repeat(16);
      const result = validateApiKey("openai", key);
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with");
      expect(result!.message).toContain("sk-");
    });

    it("rejects google key with wrong prefix", () => {
      const key = "sk-" + "a".repeat(17);
      const result = validateApiKey("google", key);
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with");
      expect(result!.message).toContain("AI");
    });
  });

  describe("too short", () => {
    it("rejects anthropic key with correct prefix but too short", () => {
      const key = "sk-ant-" + "a".repeat(10); // 17 chars, need 40
      const result = validateApiKey("anthropic", key);
      expect(result).toBeDefined();
      expect(result!.message).toContain("too short");
      expect(result!.message).toContain("40");
    });

    it("rejects openai key with correct prefix but too short", () => {
      const key = "sk-" + "a".repeat(5); // 8 chars, need 20
      const result = validateApiKey("openai", key);
      expect(result).toBeDefined();
      expect(result!.message).toContain("too short");
      expect(result!.message).toContain("20");
    });
  });

  describe("generic/unknown provider", () => {
    it("accepts 10+ char key for unknown provider", () => {
      const key = "a".repeat(10);
      expect(validateApiKey("some-unknown-provider", key)).toBeUndefined();
    });

    it("rejects 9-char key for unknown provider", () => {
      const key = "a".repeat(9);
      const result = validateApiKey("some-unknown-provider", key);
      expect(result).toBeDefined();
      expect(result!.message).toContain("too short");
      expect(result!.message).toContain("10");
    });
  });

  describe("case insensitivity", () => {
    it("normalizes provider name to lowercase", () => {
      const key = "sk-ant-" + "a".repeat(34);
      expect(validateApiKey("Anthropic", key)).toBeUndefined();
      expect(validateApiKey("ANTHROPIC", key)).toBeUndefined();
    });
  });

  describe("OAuth auth method", () => {
    it("accepts anthropic OAuth token without sk-ant- prefix", () => {
      const key = "sk-ant-oat01-" + "a".repeat(30); // OAuth prefix, not sk-ant-api
      expect(validateApiKey("anthropic", key, "oauth")).toBeUndefined();
    });

    it("accepts anthropic OAuth token with any prefix", () => {
      const key = "oat-" + "a".repeat(40);
      expect(validateApiKey("anthropic", key, "oauth")).toBeUndefined();
    });

    it("accepts openai OAuth token without sk- prefix", () => {
      const key = "oat-" + "a".repeat(40);
      expect(validateApiKey("openai", key, "oauth")).toBeUndefined();
    });

    it("still requires minimum length for OAuth tokens", () => {
      const key = "short";
      const result = validateApiKey("anthropic", key, "oauth");
      expect(result).toBeDefined();
      expect(result!.message).toContain("too short");
    });

    it("still requires non-empty for OAuth tokens", () => {
      const result = validateApiKey("anthropic", "", "oauth");
      expect(result).toBeDefined();
      expect(result!.message).toBe("API key is required.");
    });

    it("does not affect non-OAuth providers", () => {
      // groq with "oauth" authMethod should still enforce prefix
      const key = "wrong-prefix-" + "a".repeat(20);
      const result = validateApiKey("groq", key, "oauth");
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with");
    });

    it("apikey auth method enforces prefix as usual", () => {
      const key = "oat-" + "a".repeat(40);
      const result = validateApiKey("anthropic", key, "apikey");
      expect(result).toBeDefined();
      expect(result!.message).toContain("start with");
    });
  });
});

describe("getKeyPrefix", () => {
  it("returns 'sk-ant-' for anthropic", () => {
    expect(getKeyPrefix("anthropic")).toBe("sk-ant-");
  });

  it("returns 'sk-' for openai", () => {
    expect(getKeyPrefix("openai")).toBe("sk-");
  });

  it("returns 'AI' for google", () => {
    expect(getKeyPrefix("google")).toBe("AI");
  });

  it("returns 'gsk_' for groq", () => {
    expect(getKeyPrefix("groq")).toBe("gsk_");
  });

  it("returns 'xai-' for xai", () => {
    expect(getKeyPrefix("xai")).toBe("xai-");
  });

  it("returns 'sk-or-' for openrouter", () => {
    expect(getKeyPrefix("openrouter")).toBe("sk-or-");
  });

  it("returns 'sk-' for deepseek", () => {
    expect(getKeyPrefix("deepseek")).toBe("sk-");
  });

  it("returns undefined for ollama", () => {
    expect(getKeyPrefix("ollama")).toBeUndefined();
  });

  it("returns undefined for unknown provider", () => {
    expect(getKeyPrefix("some-custom")).toBeUndefined();
  });

  it("is case insensitive", () => {
    expect(getKeyPrefix("Anthropic")).toBe("sk-ant-");
    expect(getKeyPrefix("OPENAI")).toBe("sk-");
  });
});
