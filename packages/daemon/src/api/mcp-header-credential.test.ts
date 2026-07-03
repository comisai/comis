// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { buildVarName, processHeaderCredentials } from "./mcp-header-credential.js";
import type { SecretStorePort, ComisLogger, MutableSecretManager } from "@comis/core";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSecretStore(
  overrides: Partial<SecretStorePort> = {},
): SecretStorePort {
  return {
    set: vi.fn().mockReturnValue(ok(undefined)),
    getDecrypted: vi.fn().mockReturnValue(ok(undefined)),
    decryptAll: vi.fn().mockReturnValue(ok(new Map())),
    delete: vi.fn().mockReturnValue(ok(false)),
    list: vi.fn().mockReturnValue(ok([])),
    close: vi.fn(),
    ...overrides,
  } as unknown as SecretStorePort;
}

function makeLogger(): ComisLogger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as ComisLogger;
}

// ---------------------------------------------------------------------------
// buildVarName
// ---------------------------------------------------------------------------

describe("buildVarName", () => {
  it("upper-cases server id and header name into MCP_<SERVER>__<HEADER> pattern (double-underscore separator)", () => {
    expect(buildVarName("higgsfield", "Authorization")).toBe("MCP_HIGGSFIELD__AUTHORIZATION");
  });

  it("replaces hyphens in header name with underscores within each segment", () => {
    expect(buildVarName("context7", "X-Api-Key")).toBe("MCP_CONTEXT7__X_API_KEY");
  });

  it("strips leading and trailing underscores from each segment after slugification", () => {
    expect(buildVarName("my-server", "-X-Custom-")).toBe("MCP_MY_SERVER__X_CUSTOM");
  });

  it("handles server names with hyphens and numbers", () => {
    expect(buildVarName("my-mcp-1", "x-auth-token")).toBe("MCP_MY_MCP_1__X_AUTH_TOKEN");
  });

  // collision tests — distinct (serverId, headerName) pairs must produce distinct VARs.
  it("buildVarName('foo-bar', 'Key') and buildVarName('foo', 'Bar-Key') produce DIFFERENT var names (no silent collision)", () => {
    const v1 = buildVarName("foo-bar", "Key");
    const v2 = buildVarName("foo", "Bar-Key");
    // With double-underscore separator: v1 = MCP_FOO_BAR__KEY, v2 = MCP_FOO__BAR_KEY — distinct.
    expect(v1).not.toBe(v2);
  });

  it("degenerate all-symbol server id falls back to 'SERVER' sentinel (no empty segment)", () => {
    const v = buildVarName("@@@", "Key");
    // Should be MCP_SERVER__KEY (sentinel), not MCP__KEY (empty server slug).
    expect(v).toBe("MCP_SERVER__KEY");
  });

  it("degenerate all-symbol header name falls back to 'HEADER' sentinel (no empty segment)", () => {
    const v = buildVarName("srv", "---");
    // Should be MCP_SRV__HEADER (sentinel), not MCP_SRV_ (empty header slug with trailing underscore).
    expect(v).toBe("MCP_SRV__HEADER");
  });
});

// ---------------------------------------------------------------------------
// processHeaderCredentials — ref passthrough
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — ref passthrough", () => {
  it("passes ${VAR}-form header through without calling secretStore.set", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = { Authorization: "${MY_TOKEN}" };
    processHeaderCredentials({
      headers,
      serverName: "srv",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    expect(headers["Authorization"]).toBe("${MY_TOKEN}");
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it("passes $VAR-form header through without extraction", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = { Authorization: "$MY_TOKEN" };
    processHeaderCredentials({
      headers,
      serverName: "srv",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    expect(headers["Authorization"]).toBe("$MY_TOKEN");
    expect(secretStore.set).not.toHaveBeenCalled();
  });

  it("passes Bearer ${VAR}-form header through without extraction", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = { Authorization: "Bearer ${MY_TOKEN}" };
    processHeaderCredentials({
      headers,
      serverName: "srv",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    expect(headers["Authorization"]).toBe("Bearer ${MY_TOKEN}");
    expect(secretStore.set).not.toHaveBeenCalled();
  });
});

// A realistic HuggingFace bearer token (51 chars, mixed case — satisfies entropy + length floor).
// classifyHeaderCredential("Authorization", "Bearer " + HF_TOKEN) → "oauth-bearer"
const HF_BEARER_TOKEN = "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk01234567890";

// ---------------------------------------------------------------------------
// processHeaderCredentials — oauth-bearer refusal
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — oauth-bearer unconditional refusal", () => {
  it("throws [use_oauth_login] for a Bearer + secret-looking header", () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${HF_BEARER_TOKEN}`,
    };
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "hf-server",
        secretStore: makeSecretStore(),
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
      }),
    ).toThrow("[use_oauth_login]");
  });

  it("throws [use_oauth_login] even when plaintextOptOut is true (no bypass for OAuth)", () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${HF_BEARER_TOKEN}`,
    };
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "hf-server",
        secretStore: makeSecretStore(),
        plaintextOptOut: true,
        logger: makeLogger(),
        method: "mcp.connect",
      }),
    ).toThrow("[use_oauth_login]");
  });

  it("includes server name and PKCE guidance in the oauth-bearer error message", () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${HF_BEARER_TOKEN}`,
    };
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "my-server",
        secretStore: makeSecretStore(),
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
      }),
    ).toThrow(/comis mcp login my-server/);
  });
});

// ---------------------------------------------------------------------------
// processHeaderCredentials — static-secret extraction
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — static-secret extraction", () => {
  it("calls secretStore.set and rewrites header to ${VAR} form (double-underscore separator)", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    processHeaderCredentials({
      headers,
      serverName: "context7",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    expect(secretStore.set).toHaveBeenCalledWith(
      "MCP_CONTEXT7__X_API_KEY",
      "sk-ant-abc123defghijklmnopqrstuvwxyz",
    );
    expect(headers["X-Api-Key"]).toBe("${MCP_CONTEXT7__X_API_KEY}");
  });

  it("uses buildVarName scheme for Authorization header", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = {
      Authorization: "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    processHeaderCredentials({
      headers,
      serverName: "higgsfield",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.test",
    });
    expect(secretStore.set).toHaveBeenCalledWith(
      "MCP_HIGGSFIELD__AUTHORIZATION",
      "sk-ant-abc123defghijklmnopqrstuvwxyz",
    );
    expect(headers["Authorization"]).toBe("${MCP_HIGGSFIELD__AUTHORIZATION}");
  });

  it("throws [plaintext_secret_in_headers] when secretStore is undefined and plaintextOptOut is false", () => {
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "no-store-server",
        secretStore: undefined,
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
      }),
    ).toThrow("[plaintext_secret_in_headers]");
  });

  it("does not rewrite header when secretStore is undefined (fail-safe — no plaintext persistence)", () => {
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    const originalValue = headers["X-Api-Key"];
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "no-store-server",
        secretStore: undefined,
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
      }),
    ).toThrow();
    // Header must NOT have been rewritten with plaintext still in map
    expect(headers["X-Api-Key"]).toBe(originalValue);
  });

  it("throws [plaintext_secret_in_headers] when secretStore.set returns err", () => {
    const secretStore = makeSecretStore({
      set: vi.fn().mockReturnValue(err(new Error("encryption failure"))),
    });
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "srv",
        secretStore,
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
      }),
    ).toThrow("[plaintext_secret_in_headers]");
  });
});

// ---------------------------------------------------------------------------
// processHeaderCredentials — plaintextOptOut warn-and-allow
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — plaintextOptOut static-secret warn-and-allow", () => {
  it("logs WARN and does NOT call secretStore.set when plaintextOptOut is true", () => {
    const secretStore = makeSecretStore();
    const logger = makeLogger();
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    processHeaderCredentials({
      headers,
      serverName: "opt-out-server",
      secretStore,
      plaintextOptOut: true,
      logger,
      method: "mcp.connect",
    });
    expect(secretStore.set).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("leaves the header value unchanged when plaintextOptOut is true", () => {
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    processHeaderCredentials({
      headers,
      serverName: "opt-out-server",
      secretStore: makeSecretStore(),
      plaintextOptOut: true,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    expect(headers["X-Api-Key"]).toBe("sk-ant-abc123defghijklmnopqrstuvwxyz");
  });

  it("includes errorKind:config and method in the WARN log fields", () => {
    const logger = makeLogger();
    const headers: Record<string, string> = {
      "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz",
    };
    processHeaderCredentials({
      headers,
      serverName: "opt-out-server",
      secretStore: makeSecretStore(),
      plaintextOptOut: true,
      logger,
      method: "mcp.connect",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config", method: "mcp.connect" }),
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// processHeaderCredentials — mutableSecretManager live-apply
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — mutableSecretManager live-apply", () => {
  function makeMutableSecretManager(): MutableSecretManager & { upsertCalls: Array<[string, string]> } {
    const upsertCalls: Array<[string, string]> = [];
    return {
      upsertCalls,
      upsert: vi.fn((key: string, value: string) => { upsertCalls.push([key, value]); }),
      remove: vi.fn().mockReturnValue(false),
    } as unknown as MutableSecretManager & { upsertCalls: Array<[string, string]> };
  }

  it("calls mutableSecretManager.upsert with varName and raw value after secretStore.set succeeds", () => {
    const rawValue = "sk-ant-abc123defghijklmnopqrstuvwxyz";
    const secretStore = makeSecretStore();
    const mutableSecretManager = makeMutableSecretManager();
    const headers: Record<string, string> = { "X-Api-Key": rawValue };

    processHeaderCredentials({
      headers,
      serverName: "context7",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
      mutableSecretManager,
    });

    expect(mutableSecretManager.upsert).toHaveBeenCalledOnce();
    expect(mutableSecretManager.upsert).toHaveBeenCalledWith("MCP_CONTEXT7__X_API_KEY", rawValue);
  });

  it("secretManager.get returns the extracted value immediately after processHeaderCredentials (no restart needed)", () => {
    const rawValue = "sk-ant-abc123defghijklmnopqrstuvwxyz";
    const secretStore = makeSecretStore();
    const backingMap = new Map<string, string>();
    const mutableSecretManager: MutableSecretManager = {
      upsert: (key, value) => { backingMap.set(key, value); },
      remove: (key) => backingMap.delete(key),
    };
    const secretManager = { get: (key: string) => backingMap.get(key), has: (key: string) => backingMap.has(key), require: (key: string) => { const v = backingMap.get(key); if (!v) throw new Error(key); return v; }, keys: () => [...backingMap.keys()] };

    const headers: Record<string, string> = { "X-Api-Key": rawValue };
    processHeaderCredentials({
      headers,
      serverName: "context7",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
      mutableSecretManager,
    });

    // The paired secretManager should see the new value immediately — no restart required.
    expect(secretManager.get("MCP_CONTEXT7__X_API_KEY")).toBe(rawValue);
  });

  it("does NOT call mutableSecretManager.upsert when secretStore.set fails (no partial live-apply)", () => {
    const secretStore = makeSecretStore({
      set: vi.fn().mockReturnValue(err(new Error("encryption failure"))),
    });
    const mutableSecretManager = makeMutableSecretManager();
    const headers: Record<string, string> = { "X-Api-Key": "sk-ant-abc123defghijklmnopqrstuvwxyz" };

    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "srv",
        secretStore,
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
        mutableSecretManager,
      }),
    ).toThrow("[plaintext_secret_in_headers]");

    expect(mutableSecretManager.upsert).not.toHaveBeenCalled();
  });

  it("does NOT call mutableSecretManager.upsert for ref headers (already in Map from boot)", () => {
    const secretStore = makeSecretStore();
    const mutableSecretManager = makeMutableSecretManager();
    const headers: Record<string, string> = { Authorization: "${MY_TOKEN}" };

    processHeaderCredentials({
      headers,
      serverName: "srv",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
      mutableSecretManager,
    });

    expect(mutableSecretManager.upsert).not.toHaveBeenCalled();
  });

  it("works without mutableSecretManager (optional — callers that omit it are unaffected)", () => {
    const rawValue = "sk-ant-abc123defghijklmnopqrstuvwxyz";
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = { "X-Api-Key": rawValue };

    // Must not throw when mutableSecretManager is undefined
    expect(() =>
      processHeaderCredentials({
        headers,
        serverName: "context7",
        secretStore,
        plaintextOptOut: false,
        logger: makeLogger(),
        method: "mcp.connect",
        // mutableSecretManager intentionally omitted
      }),
    ).not.toThrow();
    expect(secretStore.set).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// processHeaderCredentials — idempotency (re-call with already-rewritten headers)
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — idempotency", () => {
  it("passes through ${VAR}-rewritten headers without re-extracting on a second call", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = {
      "X-Api-Key": "${MCP_SRV__X_API_KEY}",
    };
    processHeaderCredentials({
      headers,
      serverName: "srv",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    // No extraction on already-ref form
    expect(secretStore.set).not.toHaveBeenCalled();
    expect(headers["X-Api-Key"]).toBe("${MCP_SRV__X_API_KEY}");
  });
});

// ---------------------------------------------------------------------------
// processHeaderCredentials — resolvedHeaders for immediate connect
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — resolvedHeaders for immediate connect", () => {
  it("returns resolvedHeaders with the RAW secret value (not ${VAR} string) for the live connect", () => {
    const rawValue = "sk-ant-abc123defghijklmnopqrstuvwxyz";
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = {
      "X-Api-Key": rawValue,
    };
    const result = processHeaderCredentials({
      headers,
      serverName: "context7",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    // resolvedHeaders must carry the RAW value so the immediate connect uses the real credential
    expect(result.resolvedHeaders["X-Api-Key"]).toBe(rawValue);
    // The input headers map must still hold the ${VAR} form (for persistence)
    expect(headers["X-Api-Key"]).toBe("${MCP_CONTEXT7__X_API_KEY}");
  });

  it("resolvedHeaders for a ref header passes through the ${VAR} string unchanged", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = {
      Authorization: "Bearer ${MY_TOKEN}",
    };
    const result = processHeaderCredentials({
      headers,
      serverName: "srv",
      secretStore,
      plaintextOptOut: false,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    // A ref form passes through — resolvedHeaders is identical to the input
    expect(result.resolvedHeaders["Authorization"]).toBe("Bearer ${MY_TOKEN}");
  });

  it("resolvedHeaders for a plaintextOptOut header passes through the original value", () => {
    const secretStore = makeSecretStore();
    const rawValue = "sk-ant-abc123defghijklmnopqrstuvwxyz";
    const headers: Record<string, string> = {
      "X-Api-Key": rawValue,
    };
    const result = processHeaderCredentials({
      headers,
      serverName: "opt-out-srv",
      secretStore,
      plaintextOptOut: true,
      logger: makeLogger(),
      method: "mcp.connect",
    });
    // plaintextOptOut: header left unchanged in both maps
    expect(result.resolvedHeaders["X-Api-Key"]).toBe(rawValue);
    expect(headers["X-Api-Key"]).toBe(rawValue);
  });
});
