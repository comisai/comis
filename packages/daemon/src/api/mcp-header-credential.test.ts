// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { buildVarName, processHeaderCredentials } from "./mcp-header-credential.js";
import type { SecretStorePort, ComisLogger } from "@comis/core";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSecretStore(
  overrides: Partial<SecretStorePort> = {},
): SecretStorePort {
  return {
    set: vi.fn().mockReturnValue(ok(undefined)),
    get: vi.fn().mockReturnValue(ok(undefined)),
    delete: vi.fn().mockReturnValue(ok(undefined)),
    list: vi.fn().mockReturnValue(ok([])),
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
  it("upper-cases server id and header name into MCP_<SERVER>_<HEADER> pattern", () => {
    expect(buildVarName("higgsfield", "Authorization")).toBe("MCP_HIGGSFIELD_AUTHORIZATION");
  });

  it("replaces hyphens in header name with underscores", () => {
    expect(buildVarName("context7", "X-Api-Key")).toBe("MCP_CONTEXT7_X_API_KEY");
  });

  it("strips leading and trailing underscores after slugification", () => {
    expect(buildVarName("my-server", "-X-Custom-")).toBe("MCP_MY_SERVER_X_CUSTOM");
  });

  it("handles server names with hyphens and numbers", () => {
    expect(buildVarName("my-mcp-1", "x-auth-token")).toBe("MCP_MY_MCP_1_X_AUTH_TOKEN");
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
// processHeaderCredentials — oauth-bearer refusal (CRED-06)
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
// processHeaderCredentials — static-secret extraction (CRED-05)
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — static-secret extraction", () => {
  it("calls secretStore.set and rewrites header to ${VAR} form", () => {
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
      "MCP_CONTEXT7_X_API_KEY",
      "sk-ant-abc123defghijklmnopqrstuvwxyz",
    );
    expect(headers["X-Api-Key"]).toBe("${MCP_CONTEXT7_X_API_KEY}");
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
      "MCP_HIGGSFIELD_AUTHORIZATION",
      "sk-ant-abc123defghijklmnopqrstuvwxyz",
    );
    expect(headers["Authorization"]).toBe("${MCP_HIGGSFIELD_AUTHORIZATION}");
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
// processHeaderCredentials — idempotency (re-call with already-rewritten headers)
// ---------------------------------------------------------------------------

describe("processHeaderCredentials — idempotency", () => {
  it("passes through ${VAR}-rewritten headers without re-extracting on a second call", () => {
    const secretStore = makeSecretStore();
    const headers: Record<string, string> = {
      "X-Api-Key": "${MCP_SRV_X_API_KEY}",
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
    expect(headers["X-Api-Key"]).toBe("${MCP_SRV_X_API_KEY}");
  });
});
