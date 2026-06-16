// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { sanitizeLogString, redactErrorMessage } from "./log-sanitizer.js";

describe("sanitizeLogString", () => {
  describe("OpenAI/Anthropic API keys (sk-*)", () => {
    it("redacts sk- prefixed keys", () => {
      const input = "Using API key sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-[REDACTED]");
      expect(result).not.toContain("abcdefghij");
    });

    it("redacts sk-proj- prefixed keys with specific label", () => {
      const input = "Key: sk-proj-AbCdEfGhIjKlMnOpQrStUvWx";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-proj-[REDACTED]");
      expect(result).not.toContain("AbCdEfGh");
    });
  });

  describe("Bearer tokens", () => {
    it("redacts Bearer tokens", () => {
      const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature";
      const result = sanitizeLogString(input);
      expect(result).toContain("Bearer [REDACTED]");
      expect(result).not.toContain("eyJhbGci");
    });

    it("handles lowercase bearer", () => {
      const input = "bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
      const result = sanitizeLogString(input);
      expect(result).toContain("Bearer [REDACTED]");
    });
  });

  describe("Telegram bot tokens", () => {
    it("redacts Telegram bot tokens", () => {
      const input = "Bot token: 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ-12345";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_BOT_TOKEN]");
      expect(result).not.toContain("ABCdefGHI");
    });
  });

  describe("AWS access key IDs", () => {
    it("redacts AWS access key IDs", () => {
      const input = "AWS key: AKIAIOSFODNN7EXAMPLE";
      const result = sanitizeLogString(input);
      expect(result).toContain("AKIA[REDACTED]");
      expect(result).not.toContain("IOSFODNN");
    });
  });

  describe("URL-embedded passwords", () => {
    it("redacts database connection string URLs fully", () => {
      // DB connection strings (postgres://, mongodb://) are fully redacted by DB_CONNECTION_STRING
      // pattern which runs before URL_PASSWORD for stronger security (no username leakage)
      const input = "Connecting to postgres://admin:supersecretpassword@db.example.com:5432/mydb";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_CONN_STRING]");
      expect(result).not.toContain("supersecretpassword");
      expect(result).not.toContain("admin");
    });

    it("redacts non-DB URL passwords preserving username", () => {
      // Non-DB URLs (https://) still use URL_PASSWORD which preserves the username
      const input = "Connecting to https://admin:supersecretpassword@api.example.com/v1";
      const result = sanitizeLogString(input);
      expect(result).toContain("://admin:[REDACTED]@");
      expect(result).not.toContain("supersecretpassword");
    });

    it("fully redacts mongodb connection strings", () => {
      const input = "mongodb://myuser:mypassword@mongo.host:27017";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_CONN_STRING]");
      expect(result).not.toContain("mypassword");
    });
  });

  describe("hex secrets", () => {
    it("redacts long hex strings (40+ chars)", () => {
      const hexSecret = "a".repeat(40);
      const input = `Token: ${hexSecret}`;
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_HEX]");
      expect(result).not.toContain(hexSecret);
    });

    it("does not redact short hex strings", () => {
      const shortHex = "abcdef1234";
      const input = `ID: ${shortHex}`;
      const result = sanitizeLogString(input);
      expect(result).toContain(shortHex);
    });
  });

  describe("GitHub tokens", () => {
    it("redacts GitHub personal access tokens", () => {
      const token = "ghp_" + "A".repeat(36);
      const input = `GitHub PAT: ${token}`;
      const result = sanitizeLogString(input);
      expect(result).toContain("gh[REDACTED]");
      expect(result).not.toContain(token);
    });
  });

  describe("Stripe secret keys (sk_live/sk_test)", () => {
    it("redacts Stripe live key", () => {
      const input = "Stripe key: sk_live_4eC39HqLyjWDarjtT1zdp7dc";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk_[REDACTED]");
      expect(result).not.toContain("4eC39HqLyjWDarjtT1zdp7dc");
    });

    it("redacts Stripe test key", () => {
      const input = "Stripe key: sk_test_4eC39HqLyjWDarjtT1zdp7dc";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk_[REDACTED]");
      expect(result).not.toContain("4eC39HqLyjWDarjtT1zdp7dc");
    });
  });

  describe("Google API keys (AIzaSy*)", () => {
    it("redacts Google API key", () => {
      const input = "Google key: AIzaSyA1234567890abcdefghijklmnopqrstuv";
      const result = sanitizeLogString(input);
      expect(result).toContain("AIza[REDACTED]");
      expect(result).not.toContain("SyA1234567890");
    });
  });

  describe("FAL API keys (<uuid>:<32hex>)", () => {
    // CR-01 (Phase 192): a FAL FAL_KEY is shaped `<uuid>:<32+hex>`. The UUID half
    // has hyphens (breaking a hex run) and the hex half is ~32 chars (< the 40-char
    // HEX_SECRET_LONG floor), so it is NOT sk-/Bearer/AIza/long-hex — every prior
    // pattern missed it, leaking a FAL credential echoed into a provider error body.
    it("redacts a FAL key (uuid:hex) defense-in-depth pattern", () => {
      const falKey = "b1946ac9-2c7f-4d3e-8a1b-9f8e7d6c5b4a:9f8e7d6c5b4a32109f8e7d6c5b4a3210";
      const input = `FAL submit rejected key=${falKey}`;
      const result = sanitizeLogString(input);
      expect(result).not.toContain(falKey);
      expect(result).not.toContain("9f8e7d6c5b4a32109f8e7d6c5b4a3210");
    });

    it("does NOT redact a bare lowercase word pair (no false positive on prose)", () => {
      // The pattern requires the colon-joined high-entropy hex tail; ordinary
      // "host:port" or "key:value" prose must survive.
      const input = "connecting to host:8080 with verbose:true";
      expect(sanitizeLogString(input)).toBe(input);
    });
  });

  describe("Slack app tokens (xapp-*)", () => {
    it("redacts Slack app token", () => {
      const input = "Slack token: xapp-1-A02ABCDEFGH-1234567890123-abc123def456";
      const result = sanitizeLogString(input);
      expect(result).toContain("xapp-[REDACTED]");
      expect(result).not.toContain("A02ABCDEFGH");
    });
  });

  describe("SendGrid API keys (SG.*)", () => {
    it("redacts SendGrid key", () => {
      const input = "SendGrid key: SG.ngeVfQFYQlKU0ufo8x5d1A.TwL2iGABf9DHoTf9Bq";
      const result = sanitizeLogString(input);
      expect(result).toContain("SG.[REDACTED]");
      expect(result).not.toContain("ngeVfQFYQlKU0ufo8x5d1A");
    });
  });

  describe("JWT tokens", () => {
    it("redacts full JWT (three segments)", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const input = `Token: ${jwt}`;
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_JWT]");
      expect(result).not.toContain("eyJhbGci");
    });

    it("does NOT redact partial base64 without dots (not a JWT)", () => {
      const partial = "eyJhbGciOiJIUzI1NiJ9";
      const input = `Segment: ${partial}`;
      const result = sanitizeLogString(input);
      // Partial base64 without dots should not be redacted as JWT
      expect(result).toContain(partial);
    });
  });

  describe("normal text (no false positives)", () => {
    it("does not modify normal log messages", () => {
      const input = "User alice logged in from 192.168.1.1";
      expect(sanitizeLogString(input)).toBe(input);
    });

    it("does not modify JSON-like content without credentials", () => {
      const input = '{"action":"user.login","username":"bob","ip":"10.0.0.1"}';
      expect(sanitizeLogString(input)).toBe(input);
    });

    it("preserves numeric values", () => {
      const input = "Processed 42 messages in 1500ms";
      expect(sanitizeLogString(input)).toBe(input);
    });
  });

  // ---------------------------------------------------------------------------
  // Expanded credential patterns
  // ---------------------------------------------------------------------------

  describe("expanded credential patterns", () => {
    it("redacts Anthropic API key with specific label", () => {
      const input = "key: sk-ant-api03-abcdefghijklmnopqrstuvwx";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-ant-[REDACTED]");
      expect(result).not.toContain("abcdefghijklmnopqrstuvwx");
    });

    it("redacts Anthropic admin key", () => {
      const input = "key: sk-ant-admin-abcdefghijklmnopqrstuvwx";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-ant-[REDACTED]");
      expect(result).not.toContain("abcdefghijklmnopqrstuvwx");
    });

    it("redacts OpenAI project key with specific label", () => {
      const input = "key: sk-proj-abcdefghijklmnopqrstuvwx";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-proj-[REDACTED]");
      expect(result).not.toContain("abcdefghijklmnopqrstuvwx");
    });

    it("specific Anthropic pattern runs before generic sk- pattern", () => {
      const input = "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX";
      const result = sanitizeLogString(input);
      // Should be "sk-ant-[REDACTED]" not "sk-[REDACTED]"
      expect(result).toBe("sk-ant-[REDACTED]");
      expect(result).not.toBe("sk-[REDACTED]");
    });

    it("specific OpenAI project pattern runs before generic sk- pattern", () => {
      const input = "sk-proj-XXXXXXXXXXXXXXXXXXXXXXXX";
      const result = sanitizeLogString(input);
      // Should be "sk-proj-[REDACTED]" not "sk-[REDACTED]"
      expect(result).toBe("sk-proj-[REDACTED]");
      expect(result).not.toBe("sk-[REDACTED]");
    });

    it("redacts Discord bot token", () => {
      const input = "token: MTIzNDU2Nzg5MDEyMzQ1Njc4.G1kX9w.ABCDEFGHIJKLMNOPQRSTUVWXYZabc";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_DISCORD_TOKEN]");
      expect(result).not.toContain("MTIzNDU2Nzg5MDEyMzQ1Njc4");
    });

    it("redacts PostgreSQL connection string", () => {
      const input = "db: postgresql://user:password@host:5432/dbname";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_CONN_STRING]");
      expect(result).not.toContain("password");
    });

    it("redacts MongoDB connection string", () => {
      const input = "db: mongodb+srv://user:pass@cluster.example.com/db";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_CONN_STRING]");
      expect(result).not.toContain("user:pass");
    });

    it("redacts Redis connection string", () => {
      const input = "cache: redis://default:password@host:6379";
      const result = sanitizeLogString(input);
      expect(result).toContain("[REDACTED_CONN_STRING]");
      expect(result).not.toContain("password");
    });
  });

  describe("length guard", () => {
    it("returns oversized input unchanged (>1MB)", () => {
      const oversized = "x".repeat(1_048_577); // 1MB + 1 byte
      const result = sanitizeLogString(oversized);
      expect(result).toBe(oversized);
    });

    it("still processes input at exactly 1MB", () => {
      // 1MB input WITH a credential should still be sanitized
      const prefix = "x".repeat(1_048_576 - 50);
      const withCredential = prefix + " sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const result = sanitizeLogString(withCredential);
      expect(result).toContain("sk-[REDACTED]");
    });

    it("processes normal-length inputs with credentials", () => {
      const input = "API key: sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-[REDACTED]");
    });
  });

  describe("edge cases", () => {
    it("returns empty string unchanged", () => {
      expect(sanitizeLogString("")).toBe("");
    });

    it("handles multiple credentials in one string", () => {
      const input =
        "Key: sk-abcdefghijklmnopqrstuvwxyz1234567890, Token: Bearer eyJhbGciOiJIUzI1NiJ9.p.s";
      const result = sanitizeLogString(input);
      expect(result).toContain("sk-[REDACTED]");
      expect(result).toContain("Bearer [REDACTED]");
    });

    it("is idempotent (sanitizing twice gives same result)", () => {
      const input = "Key: sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const once = sanitizeLogString(input);
      const twice = sanitizeLogString(once);
      expect(twice).toBe(once);
    });
  });
});

// ---------------------------------------------------------------------------
// redactErrorMessage — the SEC-01 free-text error/diagnostic scrubber.
//
// Relocated from @comis/skills (media-adapter-shared.ts) to @comis/core/security
// in Phase 197 Plan 02 so BOTH @comis/skills (its 6 adapter callers + sanitizeApiError)
// AND @comis/channels (the voice-out pipeline WARN branches) can depend on a SINGLE
// source — @comis/channels deliberately does NOT import @comis/skills (structural-typing
// boundary), so the primitive had to move DOWN to core. The redaction SEMANTICS are
// unchanged — these asserts pin the exact behavior the skills tests previously relied on.
// ---------------------------------------------------------------------------
describe("redactErrorMessage", () => {
  it("strips URLs, the Bearer scheme, Authorization marker, and a long token", () => {
    const input =
      "POST https://api.openai.com/v1/audio/speech failed: Authorization: Bearer sk-abc123def456ghi789jkl012mno345pqr678";
    const result = redactErrorMessage(input);
    expect(result).toContain("[URL]");
    expect(result).not.toContain("https://api.openai.com");
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("Authorization:");
    // The long token after Bearer is replaced by the long-token rule.
    expect(result).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
    expect(result).toContain("[REDACTED]");
  });

  it("leaves clean text unchanged (idempotent on non-secret input)", () => {
    expect(redactErrorMessage("timeout after 30s")).toBe("timeout after 30s");
    expect(redactErrorMessage("plain text no secrets")).toBe("plain text no secrets");
  });

  it("redacts a 20+ char alphanumeric/_- run but NOT a short one (regex semantics preserved)", () => {
    // 20+ chars → redacted
    expect(redactErrorMessage("token=abcdefghij0123456789xyz")).toContain("[REDACTED]");
    // a short run (<20) is left intact
    const shortRun = "code=abc12345";
    expect(redactErrorMessage(shortRun)).toBe(shortRun);
  });

  it("strips the ollama-no-auth sentinel as a long token (no keyless-sentinel leak)", () => {
    // The keyless sentinel rides as a Bearer credential on the local path; the
    // Bearer scheme is dropped and the >=20-char sentinel run is redacted.
    const input = "local whisper Bearer ollama-no-auth-sentinel-0123456789 unreachable";
    const result = redactErrorMessage(input);
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("ollama-no-auth-sentinel-0123456789");
    expect(result).toContain("[REDACTED]");
  });
});
