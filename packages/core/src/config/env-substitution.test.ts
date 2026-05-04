// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  substituteEnvVars,
  warnSuspiciousEnvValues,
  extractReferencedSecretNames,
  findUnresolvedEnvRefs,
  formatMissingEnvRefError,
} from "./env-substitution.js";

/**
 * Helper: create a simple secret getter from a map.
 */
function createSecretGetter(
  secrets: Record<string, string>,
): (key: string) => string | undefined {
  return (key: string) => secrets[key];
}

describe("config/env-substitution", () => {
  describe("substituteEnvVars", () => {
    it("replaces simple ${VAR_NAME} with secret value", () => {
      const getSecret = createSecretGetter({ API_KEY: "sk-12345" });
      const obj = { apiKey: "${API_KEY}" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.apiKey).toBe("sk-12345");
      }
    });

    it("replaces multiple ${VAR} references in one string", () => {
      const getSecret = createSecretGetter({
        HOST: "localhost",
        PORT: "3000",
      });
      const obj = { url: "${HOST}:${PORT}" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.url).toBe("localhost:3000");
      }
    });

    it("handles mixed literal and ${VAR} text", () => {
      const getSecret = createSecretGetter({
        HOST: "api.example.com",
        PORT: "8443",
      });
      const obj = { endpoint: "https://${HOST}:${PORT}/api" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.endpoint).toBe("https://api.example.com:8443/api");
      }
    });

    it("treats $${VAR} escape syntax as literal ${VAR} (no substitution)", () => {
      const getSecret = createSecretGetter({ VAR: "should-not-appear" });
      const obj = { literal: "$${VAR}" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.literal).toBe("${VAR}");
      }
    });

    it("returns ENV_VAR_ERROR for missing variable", () => {
      const getSecret = createSecretGetter({});
      const obj = { missing: "${UNDEFINED_VAR}" };

      const result = substituteEnvVars(obj, getSecret, "config.yaml");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ENV_VAR_ERROR");
        expect(result.error.message).toContain("UNDEFINED_VAR");
        expect(result.error.message).toContain("config.yaml");
      }
    });

    it("leaves non-string values untouched (numbers, booleans)", () => {
      const getSecret = createSecretGetter({});
      const obj = {
        count: 42,
        enabled: true,
        ratio: 3.14,
        nothing: null,
      };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.count).toBe(42);
        expect(val.enabled).toBe(true);
        expect(val.ratio).toBe(3.14);
        expect(val.nothing).toBe(null);
      }
    });

    it("recursively substitutes nested objects", () => {
      const getSecret = createSecretGetter({
        DB_HOST: "db.example.com",
        DB_PORT: "5432",
        DB_NAME: "comis",
      });
      const obj = {
        database: {
          host: "${DB_HOST}",
          port: "${DB_PORT}",
          connection: {
            name: "${DB_NAME}",
          },
        },
      };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        const db = val.database as Record<string, unknown>;
        expect(db.host).toBe("db.example.com");
        expect(db.port).toBe("5432");
        const conn = db.connection as Record<string, unknown>;
        expect(conn.name).toBe("comis");
      }
    });

    it("substitutes string elements in arrays", () => {
      const getSecret = createSecretGetter({
        HOST1: "a.example.com",
        HOST2: "b.example.com",
      });
      const obj = {
        hosts: ["${HOST1}", "${HOST2}", "static.example.com"],
      };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.hosts).toEqual([
          "a.example.com",
          "b.example.com",
          "static.example.com",
        ]);
      }
    });

    it("preserves empty string when VAR resolves to empty string", () => {
      const getSecret = createSecretGetter({ EMPTY: "" });
      const obj = { value: "${EMPTY}" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.value).toBe("");
      }
    });

    it("does not mutate the input object", () => {
      const getSecret = createSecretGetter({ VAR: "replaced" });
      const obj = { key: "${VAR}", nested: { inner: "${VAR}" } };
      const originalJson = JSON.stringify(obj);

      substituteEnvVars(obj, getSecret);
      expect(JSON.stringify(obj)).toBe(originalJson);
    });

    it("handles strings with no variable references", () => {
      const getSecret = createSecretGetter({});
      const obj = { plain: "no variables here" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.plain).toBe("no variables here");
      }
    });

    it("handles mixed escape and substitution in same string", () => {
      const getSecret = createSecretGetter({ PORT: "3000" });
      const obj = { mixed: "port=$${PORT_LITERAL} actual=${PORT}" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        expect(val.mixed).toBe("port=${PORT_LITERAL} actual=3000");
      }
    });

    it("auto-corrects bare $VAR_NAME (without braces) when secret exists", () => {
      const getSecret = createSecretGetter({ GEMINI_API_KEY: "AIza-test-key" });
      const obj = { env: { GEMINI_API_KEY: "$GEMINI_API_KEY" } };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        const env = val.env as Record<string, unknown>;
        expect(env.GEMINI_API_KEY).toBe("AIza-test-key");
      }
    });

    it("returns ENV_VAR_ERROR for bare $VAR_NAME when secret is missing", () => {
      const getSecret = createSecretGetter({});
      const obj = { key: "$MISSING_KEY" };

      const result = substituteEnvVars(obj, getSecret, "config.yaml");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("ENV_VAR_ERROR");
        expect(result.error.message).toContain("MISSING_KEY");
        expect(result.error.message).toContain("auto-corrected");
      }
    });

    it("does NOT auto-correct bare $VAR in mixed-content strings", () => {
      const getSecret = createSecretGetter({ HOME: "/usr/home" });
      // "$HOME/path" should NOT be treated as a bare var ref (it has trailing content)
      const obj = { path: "$HOME/path" };

      const result = substituteEnvVars(obj, getSecret);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const val = result.value as Record<string, unknown>;
        // Should pass through unchanged (no ${} braces, not a whole-string match)
        expect(val.path).toBe("$HOME/path");
      }
    });
  });

  describe("warnSuspiciousEnvValues", () => {
    it("warns about bare $VAR in env records", () => {
      const config = {
        servers: [
          {
            name: "test",
            env: { API_KEY: "$MY_API_KEY" },
          },
        ],
      };
      const warnings = warnSuspiciousEnvValues(config, "integrations.mcp");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.path).toContain("env.API_KEY");
      expect(warnings[0]!.hint).toContain("bare $VAR");
    });

    it("warns about [REDACTED] literal in env records", () => {
      const config = {
        servers: [
          {
            name: "test",
            env: { API_KEY: "[REDACTED]" },
          },
        ],
      };
      const warnings = warnSuspiciousEnvValues(config, "integrations.mcp");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.hint).toContain("placeholder");
    });

    it("warns about raw API keys in env records", () => {
      const config = {
        servers: [{ name: "test", env: { KEY: "sk-abc123" } }],
      };
      const warnings = warnSuspiciousEnvValues(config, "integrations.mcp");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.hint).toContain("raw API key");
    });

    it("does NOT warn about proper ${VAR} references", () => {
      const config = {
        servers: [
          {
            name: "test",
            env: { API_KEY: "${MY_API_KEY}" },
          },
        ],
      };
      const warnings = warnSuspiciousEnvValues(config, "integrations.mcp");
      expect(warnings).toHaveLength(0);
    });

    it("does NOT warn about non-env string fields", () => {
      const config = {
        servers: [{ name: "$not-an-env-ref", command: "npx" }],
      };
      const warnings = warnSuspiciousEnvValues(config, "integrations.mcp");
      expect(warnings).toHaveLength(0);
    });
  });

  describe("extractReferencedSecretNames", () => {
    it("returns empty set for null/undefined/primitive/empty inputs", () => {
      expect(extractReferencedSecretNames(null)).toEqual(new Set());
      expect(extractReferencedSecretNames(undefined)).toEqual(new Set());
      expect(extractReferencedSecretNames(42)).toEqual(new Set());
      expect(extractReferencedSecretNames(true)).toEqual(new Set());
      expect(extractReferencedSecretNames("")).toEqual(new Set());
      expect(extractReferencedSecretNames({})).toEqual(new Set());
      expect(extractReferencedSecretNames([])).toEqual(new Set());
    });

    it("extracts ${VAR} references from nested objects and arrays", () => {
      const config = {
        providers: {
          anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
          openai: { apiKey: "${OPENAI_API_KEY}" },
        },
        integrations: {
          telegram: { botToken: "${TELEGRAM_BOT_TOKEN}" },
          mcp: {
            servers: [
              { name: "gemini", env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" } },
              { name: "tavily", env: { TAVILY_API_KEY: "${TAVILY_API_KEY}" } },
            ],
          },
        },
      };
      const names = extractReferencedSecretNames(config);
      expect(names).toEqual(
        new Set([
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "TELEGRAM_BOT_TOKEN",
          "GEMINI_API_KEY",
          "TAVILY_API_KEY",
        ]),
      );
    });

    it("extracts multiple references embedded in a single string", () => {
      const obj = { header: "Bearer ${API_TOKEN} X-Account: ${ACCOUNT_ID}" };
      const names = extractReferencedSecretNames(obj);
      expect(names).toEqual(new Set(["API_TOKEN", "ACCOUNT_ID"]));
    });

    it("catches whole-string bare $VAR references (agent shorthand)", () => {
      const obj = { apiKey: "$GEMINI_API_KEY", other: "${FOO_KEY}" };
      const names = extractReferencedSecretNames(obj);
      expect(names).toEqual(new Set(["GEMINI_API_KEY", "FOO_KEY"]));
    });

    it("does NOT treat $${VAR} escape sequences as references", () => {
      const obj = { literal: "$${LITERAL_VAR}", real: "${REAL_VAR}" };
      const names = extractReferencedSecretNames(obj);
      expect(names).toEqual(new Set(["REAL_VAR"]));
    });

    it("ignores bare $VAR when embedded in a larger string (path-like)", () => {
      // Mirrors substituteString's BARE_VAR_PATTERN rule: only whole-string
      // matches count, to avoid false positives on shell paths like
      // "$HOME/bin" where $HOME is a shell variable, not a Comis env ref.
      const obj = { path: "$HOME/bin" };
      const names = extractReferencedSecretNames(obj);
      expect(names).toEqual(new Set());
    });

    it("deduplicates repeated references across the tree", () => {
      const obj = {
        a: { key: "${SHARED}" },
        b: { key: "${SHARED}" },
        c: ["${SHARED}", "${UNIQUE}"],
      };
      const names = extractReferencedSecretNames(obj);
      expect(names).toEqual(new Set(["SHARED", "UNIQUE"]));
    });

    it("matches substituteEnvVars behavior on a realistic Comis config", () => {
      // If substituteEnvVars would try to resolve a name, extract should
      // return it. Guards against the two functions drifting.
      const config = {
        providers: { anthropic: { apiKey: "${ANTHROPIC_API_KEY}" } },
        skills: { search: { apiKey: "${SEARCH_API_KEY}" } },
      };
      const extracted = extractReferencedSecretNames(config);

      const asked: string[] = [];
      substituteEnvVars(config, (k) => {
        asked.push(k);
        return "";
      });

      expect(new Set(asked)).toEqual(extracted);
    });
  });

  describe("findUnresolvedEnvRefs", () => {
    it("returns empty array when all refs resolve", () => {
      const getSecret = createSecretGetter({
        ANTHROPIC_API_KEY: "sk-test",
        FINNHUB_API_KEY: "abc",
      });
      const obj = {
        providers: { anthropic: { apiKey: "${ANTHROPIC_API_KEY}" } },
        env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
      };
      expect(findUnresolvedEnvRefs(obj, getSecret)).toEqual([]);
    });

    it("returns one entry when a single ${VAR} is missing", () => {
      const getSecret = createSecretGetter({});
      const obj = { env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" } };
      const result = findUnresolvedEnvRefs(obj, getSecret);
      expect(result).toEqual([
        { path: "env.FINNHUB_API_KEY", varName: "FINNHUB_API_KEY" },
      ]);
    });

    it("walks nested objects and arrays with [N] path notation", () => {
      const getSecret = createSecretGetter({});
      const obj = {
        servers: [
          { name: "a", env: { FOO: "${FOO}" } },
          { name: "b", env: { BAR: "${BAR}" } },
        ],
      };
      const result = findUnresolvedEnvRefs(obj, getSecret);
      // Sort for deterministic comparison — internal walk order is structural.
      const sorted = [...result].sort((a, b) => a.path.localeCompare(b.path));
      expect(sorted).toEqual([
        { path: "servers[0].env.FOO", varName: "FOO" },
        { path: "servers[1].env.BAR", varName: "BAR" },
      ]);
    });

    it("detects whole-string bare $VAR (agent shorthand)", () => {
      const getSecret = createSecretGetter({});
      const obj = { env: { GEMINI_API_KEY: "$GEMINI_API_KEY" } };
      const result = findUnresolvedEnvRefs(obj, getSecret);
      expect(result).toEqual([
        { path: "env.GEMINI_API_KEY", varName: "GEMINI_API_KEY" },
      ]);
    });

    it("does NOT flag escaped $${VAR} sequences (literal, not a ref)", () => {
      const getSecret = createSecretGetter({});
      const obj = { literal: "$${VAR}" };
      expect(findUnresolvedEnvRefs(obj, getSecret)).toEqual([]);
    });

    it("treats empty string from getSecret as a valid resolved value", () => {
      // Mirrors substituteEnvVars semantics: undefined = missing, "" = present.
      const getSecret = createSecretGetter({ EMPTY: "" });
      const obj = { env: { EMPTY: "${EMPTY}" } };
      expect(findUnresolvedEnvRefs(obj, getSecret)).toEqual([]);
    });

    it("returns one entry per location when same var is missing in multiple paths", () => {
      const getSecret = createSecretGetter({});
      const obj = {
        a: { env: { SHARED: "${SHARED}" } },
        b: { env: { SHARED: "${SHARED}" } },
      };
      const result = findUnresolvedEnvRefs(obj, getSecret);
      expect(result).toHaveLength(2);
      const paths = result.map((r) => r.path).sort();
      expect(paths).toEqual(["a.env.SHARED", "b.env.SHARED"]);
      expect(result.every((r) => r.varName === "SHARED")).toBe(true);
    });

    it("returns multiple entries with same path when one string has multiple missing refs", () => {
      const getSecret = createSecretGetter({});
      const obj = { header: "Bearer ${MISSING_A} ${MISSING_B}" };
      const result = findUnresolvedEnvRefs(obj, getSecret);
      expect(result).toHaveLength(2);
      // Both refs share the same string-location path; varNames differ.
      expect(result.every((r) => r.path === "header")).toBe(true);
      expect(new Set(result.map((r) => r.varName))).toEqual(new Set(["MISSING_A", "MISSING_B"]));
    });
  });

  describe("formatMissingEnvRefError", () => {
    it("formats single-var case with singular 'env var' wording", () => {
      const msg = formatMissingEnvRefError("finnhub", ["FINNHUB_API_KEY"]);
      expect(msg).toContain("[invalid_value]");
      expect(msg).toContain('enabled MCP server "finnhub"');
      expect(msg).toContain("references env var FINNHUB_API_KEY");
      expect(msg).toContain('secrets_manage({action:"set", name:"FINNHUB_API_KEY"');
      expect(msg).toContain("Drop the env block");
      expect(msg).toContain("Set enabled:false");
      expect(msg).not.toContain("(+");
    });

    it("formats three-var case alphabetically with plural 'env vars' wording", () => {
      const msg = formatMissingEnvRefError("multi", ["GAMMA", "ALPHA", "BETA"]);
      expect(msg).toContain('enabled MCP server "multi"');
      expect(msg).toContain("references env vars ALPHA, BETA, GAMMA");
      // Recovery option (1) references the FIRST missing var (alphabetical).
      expect(msg).toContain('secrets_manage({action:"set", name:"ALPHA"');
      expect(msg).not.toContain("(+");
    });

    it("truncates beyond 3 names and appends (+N more)", () => {
      const msg = formatMissingEnvRefError("big", ["D", "C", "B", "A"]);
      expect(msg).toContain("references env vars A, B, C (+1 more)");
      expect(msg).toContain('secrets_manage({action:"set", name:"A"');
    });
  });
});
