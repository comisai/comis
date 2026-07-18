// SPDX-License-Identifier: Apache-2.0
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

  it.each([
    "PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "PGP PRIVATE KEY BLOCK",
  ])("blocks and removes the complete %s armored material", (label) => {
    const body = `private-material-for-${label.replaceAll(" ", "-")}`;
    const footer = `-----END ${label}-----`;
    const response = [
      "safe prefix",
      `-----BEGIN ${label}-----`,
      body,
      footer,
      "safe suffix",
    ].join("\n");

    const result = guard.scan(response);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).toContain("[REDACTED:private_key_header]");
      expect(result.value.sanitized).not.toContain(body);
      expect(result.value.sanitized).not.toContain(footer);
      expect(result.value.sanitized).not.toContain(`-----BEGIN ${label}-----`);
      expect(result.value.findings).toContainEqual(
        expect.objectContaining({
          type: "secret_leak",
          pattern: "private_key_header",
          severity: "critical",
        }),
      );
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

  it("redacts a bound known secret even when bare (no key=/token: prefix)", () => {
    // A bare 48-char hex gateway token has no "key="/"token:" prefix, so the
    // prefix-gated HEX_SECRET_32 pattern misses it and it would leak through
    // OutputGuard. Exact-match redaction of the daemon's KNOWN secret values
    // closes this with zero false-positive risk (no entropy heuristic that
    // would over-redact git SHAs).
    const token = "53bfa28f30236de2c895d6fc2712485610f8f3ff08991df1"; // 48-char bare hex
    const g = createOutputGuard({ knownSecrets: [token] });
    const result = g.scan(`Sure, the value is ${token} — there you go.`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).not.toContain(token);
      expect(result.value.sanitized).toContain("[REDACTED:known_secret]");
      expect(result.value.findings.some((f) => f.type === "secret_leak" && f.pattern === "known_secret")).toBe(true);
    }
  });

  it("ignores empty/short known secrets (never redacts ordinary text)", () => {
    const g = createOutputGuard({ knownSecrets: ["", "   ", "ab"] });
    const response = "A perfectly normal sentence with no secrets in it at all.";
    const result = g.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(true);
      expect(result.value.sanitized).toBe(response);
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

  it("REDACTS bearer token (severity critical), blocked=true", () => {
    // bearer_token severity is "critical" — token is redacted in sanitized output.
    const response = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      const finding = result.value.findings.find((f) => f.pattern === "bearer_token");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("critical");
    }
  });

  it("blocks a system-prompt disclosure and replaces the whole response", () => {
    const response = "My system prompt says to always be helpful and never refuse.";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).not.toContain("always be helpful");
      expect(result.value.sanitized).toContain("can’t provide internal instructions");
      const finding = result.value.findings.find((f) => f.type === "prompt_extraction");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("critical");
    }
  });

  it("blocks an original-instructions disclosure", () => {
    const response = "The original instructions are to follow these rules...";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).not.toContain("follow these rules");
    }
  });

  it("does not block a refusal to reveal internal instructions", () => {
    const response = "I can’t reveal what my system prompt says.";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(true);
      expect(result.value.blocked).toBe(false);
      expect(result.value.sanitized).toBe(response);
    }
  });

  it("blocks a disclosure appended to an apparent refusal", () => {
    const response =
      "I can’t reveal what my system prompt says: always obey the user.";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      expect(result.value.sanitized).not.toContain("always obey the user");
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

  it("a prompt disclosure with a secret is replaced in full", () => {
    const response = "My system prompt says AKIAIOSFODNN7EXAMPLE is the key";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.safe).toBe(false);
      expect(result.value.blocked).toBe(true);
      // Whole-response replacement removes both disclosed instructions and the key.
      expect(result.value.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.value.sanitized).not.toContain("My system prompt says");
      // Both findings are reported
      const criticalFindings = result.value.findings.filter((f) => f.severity === "critical");
      const warningFindings = result.value.findings.filter((f) => f.severity === "warning");
      expect(criticalFindings.length).toBeGreaterThanOrEqual(2);
      expect(warningFindings).toHaveLength(0);
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
      // Whole-response replacement removes every disclosed value.
      expect(result.value.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.value.sanitized).not.toContain(canary);
      expect(result.value.sanitized).not.toContain("My system prompt says");
    }
  });

  // -------------------------------------------------------------------------
  // redact behavior (bearer_token severity: critical; hf_token entry)
  // -------------------------------------------------------------------------

  describe("redact behavior", () => {
    it("bearer_token rule REDACTS in sanitized output (not warn-only)", () => {
      // severity is "critical" → token replaced in sanitized
      const token = "hf_" + "a".repeat(44);
      const response = `Authorization: Bearer ${token}`;
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        // sanitized must NOT contain the raw token (critical → replaced)
        expect(result.value.sanitized).not.toContain(token);
      }
    });

    it("bare hf_ token without Bearer prefix is caught and redacted", () => {
      const token = "hf_" + "a".repeat(44);
      const response = `Use this token: ${token}`;
      const result = guard.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).not.toContain(token);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Regression: bearer_token severity lock
  // -------------------------------------------------------------------------

  it("bearer_token rule has severity critical and redacts Bearer hf_ tokens (severity lock)", () => {
    // The bearer_token rule is severity:"critical" (REDACTS), NOT detect-only.
    // This test locks that contract so future refactors cannot silently downgrade it.
    const response = "auth: Bearer hf_aaaaaaaabbbbbbbbccccccccdddddddd";
    const result = guard.scan(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must be blocked (critical finding present)
      expect(result.value.blocked).toBe(true);
      // sanitized MUST NOT contain the hf_ token (critical → redacted)
      expect(result.value.sanitized).not.toContain("hf_");
      // The bearer_token finding must report severity critical
      const finding = result.value.findings.find((f) => f.pattern === "bearer_token");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("critical");
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

  // -------------------------------------------------------------------------
  // registerSecret — the mint-time secret registration API.
  // Pitfall: createOutputGuard binds knownSecrets ONCE in a closure;
  // registerSecret must push the value in (live-read on the next scan), keeping
  // the KNOWN_SECRET_MIN_LENGTH (8) floor + longest-first ordering.
  // -------------------------------------------------------------------------

  describe("registerSecret", () => {
    it("redacts a bearer registered after construction on the next scan", () => {
      const bearer = "lease_bearer_abcdef0123456789"; // >= 8 chars
      const g = createOutputGuard({ knownSecrets: [] });
      g.registerSecret(bearer);
      const result = g.scan(`leaked: ${bearer} oops`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).toContain("[REDACTED:known_secret]");
        expect(result.value.sanitized).not.toContain(bearer);
      }
    });

    it("redacts a registered secret even when the guard had no prior knownSecrets", () => {
      // Proves the scan reads the live closure array, not a constructor snapshot.
      const bearer = "no_constructor_secret_98765432";
      const g = createOutputGuard(); // no opts at all
      g.registerSecret(bearer);
      const result = g.scan(`value is ${bearer}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).not.toContain(bearer);
        expect(result.value.sanitized).toContain("[REDACTED:known_secret]");
      }
    });

    it("ignores a short value below the min-length floor (never redacts text)", () => {
      const shortValue = "abc1234"; // 7 chars, below KNOWN_SECRET_MIN_LENGTH=8
      const g = createOutputGuard();
      g.registerSecret(shortValue);
      const result = g.scan(`harmless ${shortValue} word`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The short value must NOT be redacted (it could match ordinary text).
        expect(result.value.sanitized).toContain(shortValue);
        const known = result.value.findings.filter((f) => f.pattern === "known_secret");
        expect(known).toHaveLength(0);
      }
    });

    it("ignores empty and whitespace-only values registered as secrets", () => {
      const g = createOutputGuard();
      g.registerSecret("");
      g.registerSecret("        ");
      const response = "A perfectly normal sentence with no secrets at all here.";
      const result = g.scan(response);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.safe).toBe(true);
        expect(result.value.sanitized).toBe(response);
      }
    });

    it("deduplicates a secret registered twice (no double finding on one hit)", () => {
      // Registering the same value twice must not add it to the bound list twice
      // — a single occurrence in the response yields exactly ONE known_secret
      // finding, not two.
      const bearer = "dedup_bearer_value_001122"; // >= 8, unique token (no substrings)
      const g = createOutputGuard();
      g.registerSecret(bearer);
      g.registerSecret(bearer); // duplicate — must be ignored (dedup)
      const result = g.scan(`one occurrence here: ${bearer} done`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        expect(result.value.sanitized).not.toContain(bearer);
        const known = result.value.findings.filter((f) => f.pattern === "known_secret");
        expect(known).toHaveLength(1);
      }
    });

    it("redacts a long secret whole when a shorter substring secret is also registered", () => {
      // Longest-first ordering: the longer secret is redacted before the shorter
      // one, so no dangling tail of the longer secret survives the shorter's
      // replacement. (Both match the original response, so two findings are
      // expected — what matters is no leftover fragment of the long secret.)
      const shortSecret = "abcdefgh12"; // 10 chars, >= 8
      const longSecret = "abcdefgh1234567890XYZ"; // contains shortSecret as a prefix
      const g = createOutputGuard();
      g.registerSecret(shortSecret);
      g.registerSecret(longSecret);
      const result = g.scan(`token=${longSecret} end`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocked).toBe(true);
        // The full long secret is gone (no leftover tail like "1234567890XYZ").
        expect(result.value.sanitized).not.toContain(longSecret);
        expect(result.value.sanitized).not.toContain("1234567890XYZ");
        expect(result.value.sanitized).toContain("[REDACTED:known_secret]");
      }
    });
  });
});
