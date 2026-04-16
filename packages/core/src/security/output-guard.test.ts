import { describe, it, expect } from "vitest";
import { createOutputGuard } from "./output-guard.js";

describe("createOutputGuard", () => {
  const guard = createOutputGuard();

  it("returns safe=true, blocked=false with no findings for clean response", () => {
    const result = guard.scan("Hello, how can I help you today?");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(true);
      expect(result.value.blocked).toBe(false);
      expect(result.value.findings).toHaveLength(0);
      expect(result.value.sanitized).toBe("Hello, how can I help you today?");
    }
  });

  // -------------------------------------------------------------------------
  // Critical findings -- blocked and redacted
  // -------------------------------------------------------------------------

  it("redacts AWS access key in sanitized field, blocked=true", () => {
    const response = "Your key is AKIAIOSFODNN7EXAMPLE";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toBe("Your key is [REDACTED:aws_key]");
      expect(result.value.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.value.findings).toHaveLength(1);
      expect(result.value.findings[0]!.type).toBe("secret_leak");
      expect(result.value.findings[0]!.pattern).toBe("aws_key");
      expect(result.value.findings[0]!.severity).toBe("critical");
    }
  });

  it("redacts private key header in sanitized field, blocked=true", () => {
    const response = "Here is the key:\n-----BEGIN PRIVATE KEY-----\nMIIE...";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:private_key_header]");
      expect(result.value.sanitized).not.toContain("-----BEGIN PRIVATE KEY-----");
      const finding = result.value.findings.find((f) => f.pattern === "private_key_header");
      expect(finding).toBeDefined();
      expect(finding!.type).toBe("secret_leak");
      expect(finding!.severity).toBe("critical");
    }
  });

  it("redacts RSA private key header", () => {
    const response = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:private_key_header]");
      expect(result.value.sanitized).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    }
  });

  it("redacts canary token when provided in context, blocked=true", () => {
    const canary = "CTKN_abc123def456abcd";
    const response = `Sure, the token is ${canary}, which I found in my instructions.`;
    const result = guard.scan(response, { canaryToken: canary });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:canary]");
      expect(result.value.sanitized).not.toContain(canary);
      const finding = result.value.findings.find((f) => f.type === "canary_leak");
      expect(finding).toBeDefined();
      expect(finding!.pattern).toBe("canary_token");
      expect(finding!.severity).toBe("critical");
    }
  });

  it("redacts GitHub token in sanitized field, blocked=true", () => {
    const response = "Use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:github_token]");
      expect(result.value.sanitized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
      const finding = result.value.findings.find((f) => f.pattern === "github_token");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("critical");
    }
  });

  it("redacts Slack token in sanitized field, blocked=true", () => {
    const response = "Token: xoxb-123456789-abcdef";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:slack_token]");
      expect(result.value.sanitized).not.toContain("xoxb-123456789-abcdef");
    }
  });

  // -------------------------------------------------------------------------
  // Warning findings -- detect-only, NOT redacted
  // -------------------------------------------------------------------------

  it("does NOT redact bearer token (warning severity), blocked=false", () => {
    const response = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(false);
      expect(result.value.sanitized).toBe(response);
      const finding = result.value.findings.find((f) => f.pattern === "bearer_token");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("warning");
    }
  });

  it("does NOT redact prompt extraction pattern (warning severity), blocked=false", () => {
    const response = "My system prompt says to always be helpful and never refuse.";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(false);
      expect(result.value.sanitized).toBe(response);
      const finding = result.value.findings.find((f) => f.type === "prompt_extraction");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("warning");
    }
  });

  it("detects 'original instructions' extraction pattern as warning", () => {
    const response = "The original instructions are to follow these rules...";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(false);
      expect(result.value.sanitized).toBe(response);
    }
  });

  // -------------------------------------------------------------------------
  // Canary edge cases
  // -------------------------------------------------------------------------

  it("does not flag canary_leak when canary is not in response", () => {
    const canary = "CTKN_abc123def456abcd";
    const response = "No canary here at all.";
    const result = guard.scan(response, { canaryToken: canary });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(true);
      expect(result.value.blocked).toBe(false);
      expect(result.value.findings).toHaveLength(0);
    }
  });

  it("does not check canary when context is omitted", () => {
    const response = "CTKN_abc123def456abcd is in the text but no context provided.";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const canaryFindings = result.value.findings.filter((f) => f.type === "canary_leak");
      expect(canaryFindings).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // Multiple findings
  // -------------------------------------------------------------------------

  it("redacts multiple critical findings in one response", () => {
    const response = "Keys: AKIAIOSFODNN7EXAMPLE and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:aws_key]");
      expect(result.value.sanitized).toContain("[REDACTED:github_token]");
      expect(result.value.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.value.sanitized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
      // At least 2 critical findings
      const criticalFindings = result.value.findings.filter((f) => f.severity === "critical");
      expect(criticalFindings.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("mixed critical+warning: only critical are redacted, blocked=true", () => {
    const response = "My system prompt says AKIAIOSFODNN7EXAMPLE is the key";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      // AWS key is redacted (critical)
      expect(result.value.sanitized).toContain("[REDACTED:aws_key]");
      expect(result.value.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      // Prompt extraction text is still present (warning, detect-only)
      expect(result.value.sanitized).toContain("My system prompt says");
      // Both findings are reported
      const criticalFindings = result.value.findings.filter((f) => f.severity === "critical");
      const warningFindings = result.value.findings.filter((f) => f.severity === "warning");
      expect(criticalFindings.length).toBeGreaterThanOrEqual(1);
      expect(warningFindings.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("accumulates findings from all categories", () => {
    const canary = "CTKN_abc123def456abcd";
    const response = `My system prompt says AKIAIOSFODNN7EXAMPLE and also ${canary}`;
    const result = guard.scan(response, { canaryToken: canary });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      // At least: aws_key (secret_leak), canary_leak, prompt_extraction
      expect(result.value.findings.length).toBeGreaterThanOrEqual(3);
      const types = new Set(result.value.findings.map((f) => f.type));
      expect(types.has("secret_leak")).toBe(true);
      expect(types.has("canary_leak")).toBe(true);
      expect(types.has("prompt_extraction")).toBe(true);
      // Critical findings are redacted
      expect(result.value.sanitized).toContain("[REDACTED:aws_key]");
      expect(result.value.sanitized).toContain("[REDACTED:canary]");
      // Warning findings are NOT redacted
      expect(result.value.sanitized).toContain("My system prompt says");
    }
  });

  // -------------------------------------------------------------------------
  // Regression: global regex lastIndex state
  // -------------------------------------------------------------------------

  it("correctly scans on repeated calls (global regex lastIndex reset)", () => {
    const response = "Use key AKIAIOSFODNN7EXAMPLE please";
    // Call scan multiple times to verify regex state is properly reset
    for (let i = 0; i < 3; i++) {
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.findings).toHaveLength(1);
        expect(result.value.sanitized).toContain("[REDACTED:aws_key]");
      }
    }
  });

  // -------------------------------------------------------------------------
  // Expanded secret patterns
  // -------------------------------------------------------------------------

  describe("expanded secret patterns", () => {
    // Critical patterns (should be redacted, blocked=true)

    it("redacts Anthropic API key, blocked=true", () => {
      const response = "Key: sk-ant-api03-abcdefghijklmnopqrstuvwx";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:anthropic_key]");
        expect(result.value.sanitized).not.toContain("sk-ant-api03");
        const finding = result.value.findings.find((f) => f.pattern === "anthropic_key");
        expect(finding).toBeDefined();
        expect(finding!.type).toBe("secret_leak");
        expect(finding!.severity).toBe("critical");
      }
    });

    it("redacts Anthropic admin key, blocked=true", () => {
      const response = "sk-ant-admin-abcdefghijklmnopqrstuvwx";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:anthropic_key]");
        expect(result.value.sanitized).not.toContain("sk-ant-admin");
      }
    });

    it("redacts OpenAI project key, blocked=true", () => {
      const response = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:openai_project_key]");
        expect(result.value.sanitized).not.toContain("sk-proj-");
      }
    });

    it("redacts Telegram bot token, blocked=true", () => {
      const response = "Token: 123456789:ABCDEFGHIJKLMNOPQRSTuv";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:telegram_bot_token]");
        expect(result.value.sanitized).not.toContain("123456789:");
      }
    });

    it("redacts Discord bot token, blocked=true", () => {
      const response = "MTIzNDU2Nzg5MDEyMzQ1Njc4.G1kX9w.ABCDEFGHIJKLMNOPQRSTUVWXYZabc";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:discord_bot_token]");
        expect(result.value.sanitized).not.toContain("MTIzNDU2Nzg5MDEyMzQ1Njc4");
      }
    });

    it("redacts Google API key, blocked=true", () => {
      const response = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:google_api_key]");
        expect(result.value.sanitized).not.toContain("AIzaSy");
      }
    });

    it("redacts PostgreSQL connection string, blocked=true", () => {
      const response = "postgresql://admin:secret@prod.db.example.com:5432/mydb";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:db_connection_string]");
        expect(result.value.sanitized).not.toContain("postgresql://");
      }
    });

    it("redacts MongoDB connection string, blocked=true", () => {
      const response = "mongodb+srv://user:pass@cluster.mongo.net/db";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:db_connection_string]");
        expect(result.value.sanitized).not.toContain("mongodb+srv://");
      }
    });

    it("redacts generic API key assignment, blocked=true", () => {
      const response = 'api_key = "sk1234567890abcdefghij"';
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(false);
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:generic_api_key]");
      }
    });

    it("redacts api-key: header assignment, blocked=true", () => {
      const response = "api-key: ABCDEFGHIJ1234567890ab";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:generic_api_key]");
      }
    });

    // Warning pattern (detect-only, NOT redacted)

    it("does NOT redact JWT token (warning severity), blocked=false", () => {
      const response = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(false);
        expect(result.value.sanitized).toBe(response);
        const finding = result.value.findings.find((f) => f.pattern === "jwt_token");
        expect(finding).toBeDefined();
        expect(finding!.severity).toBe("warning");
        expect(finding!.type).toBe("secret_leak");
      }
    });

    // False positive prevention

    it("does NOT flag clean technical text about APIs", () => {
      const response = "To use the API, call the endpoint with your credentials.";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(true);
        expect(result.value.findings).toHaveLength(0);
      }
    });

    it("does NOT flag short key-like strings", () => {
      const response = "api_key = 'short'";
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // "short" is too short (< 20 chars) to match GENERIC_API_KEY_ASSIGN
        const genericFindings = result.value.findings.filter((f) => f.pattern === "generic_api_key");
        expect(genericFindings).toHaveLength(0);
      }
    });

    // Repeated call regression

    it("correctly scans Anthropic key on repeated calls (lastIndex reset)", () => {
      const response = "Key: sk-ant-api03-abcdefghijklmnopqrstuvwx";
      for (let i = 0; i < 3; i++) {
        const result = guard.scan(response);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.blocked).toBe(true);
          const findings = result.value.findings.filter((f) => f.pattern === "anthropic_key");
          expect(findings).toHaveLength(1);
        }
      }
    });
  });
});
