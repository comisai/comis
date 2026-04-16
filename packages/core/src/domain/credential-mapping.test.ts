import { describe, expect, it } from "vitest";
import { parseCredentialMapping } from "./credential-mapping.js";

function validMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: "map-001",
    secretName: "OPENAI_API_KEY",
    injectionType: "bearer_header",
    urlPattern: "https://api.openai.com/*",
    ...overrides,
  };
}

describe("CredentialMapping", () => {
  describe("valid data", () => {
    it("parses a bearer_header mapping without injectionKey", () => {
      const result = parseCredentialMapping(validMapping());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("map-001");
        expect(result.value.secretName).toBe("OPENAI_API_KEY");
        expect(result.value.injectionType).toBe("bearer_header");
        expect(result.value.urlPattern).toBe("https://api.openai.com/*");
        expect(result.value.injectionKey).toBeUndefined();
        expect(result.value.toolName).toBeUndefined();
      }
    });

    it("parses a custom_header mapping with injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({
          injectionType: "custom_header",
          injectionKey: "X-Api-Key",
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.injectionType).toBe("custom_header");
        expect(result.value.injectionKey).toBe("X-Api-Key");
      }
    });

    it("parses a query_param mapping with injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({
          injectionType: "query_param",
          injectionKey: "api_key",
          urlPattern: "https://api.example.com/*",
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.injectionType).toBe("query_param");
        expect(result.value.injectionKey).toBe("api_key");
      }
    });

    it("parses a basic_auth mapping without injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({
          injectionType: "basic_auth",
          urlPattern: "https://internal.example.com/*",
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.injectionType).toBe("basic_auth");
        expect(result.value.injectionKey).toBeUndefined();
      }
    });

    it("accepts optional toolName", () => {
      const result = parseCredentialMapping(
        validMapping({ toolName: "brave_search" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toolName).toBe("brave_search");
      }
    });

    it("bearer_header succeeds without injectionKey (optional for bearer/basic_auth)", () => {
      const result = parseCredentialMapping(validMapping());
      expect(result.ok).toBe(true);
    });
  });

  describe("injectionKey refinement", () => {
    it("rejects custom_header without injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({ injectionType: "custom_header" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain(
          "injectionKey is required for custom_header and query_param injection types",
        );
      }
    });

    it("rejects custom_header with empty injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({ injectionType: "custom_header", injectionKey: "" }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects query_param without injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({ injectionType: "query_param" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain(
          "injectionKey is required for custom_header and query_param injection types",
        );
      }
    });

    it("rejects query_param with empty injectionKey", () => {
      const result = parseCredentialMapping(
        validMapping({ injectionType: "query_param", injectionKey: "" }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("invalid data", () => {
    it("rejects unknown injectionType", () => {
      const result = parseCredentialMapping(
        validMapping({ injectionType: "oauth2_token" }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = parseCredentialMapping({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("id");
        expect(paths).toContain("secretName");
        expect(paths).toContain("injectionType");
        expect(paths).toContain("urlPattern");
      }
    });

    it("rejects empty id", () => {
      const result = parseCredentialMapping(validMapping({ id: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty secretName", () => {
      const result = parseCredentialMapping(validMapping({ secretName: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects empty urlPattern", () => {
      const result = parseCredentialMapping(validMapping({ urlPattern: "" }));
      expect(result.ok).toBe(false);
    });

    it("rejects non-object input", () => {
      const result = parseCredentialMapping(42);
      expect(result.ok).toBe(false);
    });

    it("rejects null input", () => {
      const result = parseCredentialMapping(null);
      expect(result.ok).toBe(false);
    });
  });
});
