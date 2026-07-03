// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the config + env + gateway-infrastructure domain.
 *
 * Coverage:
 *   - Method name assertions (one per of the 12 methods)
 *   - All-admin-scoped assertion (mirrors setup-gateway-api.ts:80-84
 *     + 341-343 + the in-handler `_trustLevel` gates for env.*)
 *   - Request acceptance/rejection for each method
 *   - Response acceptance for each method (including the
 *     loose-record escape-hatch shapes on config.patch/apply, the
 *     graceful-degradation `error` field on config.history/diff,
 *     and the residency-canary shape on env.set/env.list)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  ConfigReadContract,
  ConfigSchemaContract,
  ConfigPatchContract,
  ConfigApplyContract,
  ConfigHistoryContract,
  ConfigDiffContract,
  ConfigRollbackContract,
  ConfigGcContract,
  ConfigAuditListContract,
  ConfigAuditScrubContract,
  GatewayStatusContract,
  GatewayRestartContract,
  EnvSetContract,
  EnvListContract,
  CONFIG_CONTRACTS,
} from "./config.js";

describe("config + env + gateway-infrastructure contracts", () => {
  it("CONFIG_CONTRACTS has exactly 14 entries (8 config.* + 2 config.audit.* + 2 gateway.* + 2 env.*)", () => {
    expect(CONFIG_CONTRACTS.length).toBe(14);
  });

  it("config.audit.list: method name is correct", () => {
    expect(ConfigAuditListContract.method).toBe("config.audit.list");
    expect(ConfigAuditListContract.scopes).toEqual(["admin"]);
  });

  it("config.audit.scrub: method name is correct", () => {
    expect(ConfigAuditScrubContract.method).toBe("config.audit.scrub");
    expect(ConfigAuditScrubContract.scopes).toEqual(["admin"]);
  });

  // ------------------------------------------------------------------------
  // Method names
  // ------------------------------------------------------------------------

  it("config.read: method name is correct", () => {
    expect(ConfigReadContract.method).toBe("config.read");
  });

  it("config.schema: method name is correct", () => {
    expect(ConfigSchemaContract.method).toBe("config.schema");
  });

  it("config.patch: method name is correct", () => {
    expect(ConfigPatchContract.method).toBe("config.patch");
  });

  it("config.apply: method name is correct", () => {
    expect(ConfigApplyContract.method).toBe("config.apply");
  });

  it("config.history: method name is correct", () => {
    expect(ConfigHistoryContract.method).toBe("config.history");
  });

  it("config.diff: method name is correct", () => {
    expect(ConfigDiffContract.method).toBe("config.diff");
  });

  it("config.rollback: method name is correct", () => {
    expect(ConfigRollbackContract.method).toBe("config.rollback");
  });

  it("config.gc: method name is correct", () => {
    expect(ConfigGcContract.method).toBe("config.gc");
  });

  it("gateway.status: method name is correct", () => {
    expect(GatewayStatusContract.method).toBe("gateway.status");
  });

  it("gateway.restart: method name is correct", () => {
    expect(GatewayRestartContract.method).toBe("gateway.restart");
  });

  it("env.set: method name is correct", () => {
    expect(EnvSetContract.method).toBe("env.set");
  });

  it("env.list: method name is correct", () => {
    expect(EnvListContract.method).toBe("env.list");
  });

  // ------------------------------------------------------------------------
  // Admin scope on all 12
  // ------------------------------------------------------------------------

  it("all 12 contracts are admin-scoped (mirrors setup-gateway-api.ts:80-84 + 341-343 + env in-handler gates)", () => {
    expect(ConfigReadContract.scopes).toEqual(["admin"]);
    expect(ConfigSchemaContract.scopes).toEqual(["admin"]);
    expect(ConfigPatchContract.scopes).toEqual(["admin"]);
    expect(ConfigApplyContract.scopes).toEqual(["admin"]);
    expect(ConfigHistoryContract.scopes).toEqual(["admin"]);
    expect(ConfigDiffContract.scopes).toEqual(["admin"]);
    expect(ConfigRollbackContract.scopes).toEqual(["admin"]);
    expect(ConfigGcContract.scopes).toEqual(["admin"]);
    expect(GatewayStatusContract.scopes).toEqual(["admin"]);
    expect(GatewayRestartContract.scopes).toEqual(["admin"]);
    expect(EnvSetContract.scopes).toEqual(["admin"]);
    expect(EnvListContract.scopes).toEqual(["admin"]);
  });

  // ------------------------------------------------------------------------
  // config.read
  // ------------------------------------------------------------------------

  it("config.read: request accepts an empty object (section is optional)", () => {
    expect(() => ConfigReadContract.request.parse({})).not.toThrow();
  });

  it("config.read: request accepts a section filter string", () => {
    expect(() =>
      ConfigReadContract.request.parse({ section: "agents" }),
    ).not.toThrow();
  });

  it("config.read: request rejects non-string section values", () => {
    expect(() =>
      ConfigReadContract.request.parse({ section: 42 }),
    ).toThrow();
  });

  it("config.read: response accepts a loose record (full config or section payload)", () => {
    expect(() =>
      ConfigReadContract.response.parse({
        config: { logLevel: "info" },
        sections: ["agents", "logLevel"],
      }),
    ).not.toThrow();
    expect(() =>
      ConfigReadContract.response.parse({ logLevel: "info" }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------------
  // config.schema
  // ------------------------------------------------------------------------

  it("config.schema: request accepts an empty object", () => {
    expect(() => ConfigSchemaContract.request.parse({})).not.toThrow();
  });

  it("config.schema: response requires schema + sections (full mode)", () => {
    expect(() =>
      ConfigSchemaContract.response.parse({
        schema: { type: "object", properties: {} },
        sections: ["agents", "logLevel"],
      }),
    ).not.toThrow();
  });

  it("config.schema: response accepts the optional section field (section mode)", () => {
    expect(() =>
      ConfigSchemaContract.response.parse({
        section: "agents",
        schema: { type: "object" },
        sections: ["agents", "logLevel"],
      }),
    ).not.toThrow();
  });

  it("config.schema: response rejects missing required schema field", () => {
    expect(() =>
      ConfigSchemaContract.response.parse({ sections: ["agents"] }),
    ).toThrow();
  });

  // ------------------------------------------------------------------------
  // config.patch — loose-record validation
  // ------------------------------------------------------------------------

  it("config.patch: request accepts the canonical { section, key, value } shape", () => {
    expect(() =>
      ConfigPatchContract.request.parse({
        section: "agents",
        key: "default.budget.maxTokens",
        value: { maxTokens: 100 },
      }),
    ).not.toThrow();
  });

  it("config.patch: request strips an unrecognized { path, value } shape (path is not in the schema)", () => {
    // `path` is not a contract field — the canonical shape is
    // `{ section, key, value }`. Zod default "strip unknown keys"
    // mode means the parse does NOT throw on a `{ path, value }`
    // payload — it succeeds with `path` stripped. The daemon's bespoke
    // pre-Zod section-required check (config-write.ts:96) then rejects
    // the call with `Missing required parameter "section"`.
    const parsed = ConfigPatchContract.request.parse({
      path: "agents.default.budget.maxTokens",
      value: { maxTokens: 100 },
    });
    expect((parsed as Record<string, unknown>).path).toBeUndefined();
    expect((parsed as Record<string, unknown>).section).toBeUndefined();
  });

  it("config.patch: request accepts a nested value tree (loose record)", () => {
    expect(() =>
      ConfigPatchContract.request.parse({
        section: "integrations",
        value: {
          mcp: {
            servers: [
              { name: "ctx7", transport: "stdio", command: "npx" },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it("config.patch: response requires patched: true + section + value + restarting: true", () => {
    expect(() =>
      ConfigPatchContract.response.parse({
        patched: true,
        section: "logLevel",
        value: "debug",
        restarting: true,
      }),
    ).not.toThrow();
    expect(() =>
      ConfigPatchContract.response.parse({
        patched: true,
        section: "agents",
        key: "default.budget",
        value: { maxTokens: 100 },
        restarting: true,
      }),
    ).not.toThrow();
  });

  it("config.patch: response rejects patched: false (success-only literal)", () => {
    expect(() =>
      ConfigPatchContract.response.parse({
        patched: false,
        section: "logLevel",
        value: "debug",
        restarting: true,
      }),
    ).toThrow();
  });

  // ------------------------------------------------------------------------
  // config.apply
  // ------------------------------------------------------------------------

  it("config.apply: request requires section + value", () => {
    expect(() =>
      ConfigApplyContract.request.parse({
        section: "agents",
        value: { default: { provider: "openai" } },
      }),
    ).not.toThrow();
  });

  it("config.apply: request rejects missing section", () => {
    expect(() =>
      ConfigApplyContract.request.parse({ value: { foo: "bar" } }),
    ).toThrow();
  });

  it("config.apply: response requires applied: true + section + restarting: true", () => {
    expect(() =>
      ConfigApplyContract.response.parse({
        applied: true,
        section: "agents",
        restarting: true,
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------------
  // config.history
  // ------------------------------------------------------------------------

  it("config.history: request accepts an empty object (limit + section optional)", () => {
    expect(() => ConfigHistoryContract.request.parse({})).not.toThrow();
  });

  it("config.history: request accepts limit + section", () => {
    expect(() =>
      ConfigHistoryContract.request.parse({ limit: 10, section: "agents" }),
    ).not.toThrow();
  });

  it("config.history: response accepts an empty entries array", () => {
    expect(() =>
      ConfigHistoryContract.response.parse({ entries: [] }),
    ).not.toThrow();
  });

  it("config.history: response accepts the graceful-degradation error path", () => {
    expect(() =>
      ConfigHistoryContract.response.parse({
        entries: [],
        error: "Config versioning not available",
      }),
    ).not.toThrow();
  });

  it("config.history: response accepts a populated entries array with metadata", () => {
    expect(() =>
      ConfigHistoryContract.response.parse({
        entries: [
          {
            sha: "abc1234",
            timestamp: "2026-05-12T20:00:00Z",
            message: "Changed agents.default.provider to openai",
            metadata: {
              section: "agents",
              key: "default.provider",
              summary: "Changed agents.default.provider to openai",
            },
          },
          {
            sha: "def5678",
            timestamp: "2026-05-12T20:05:00Z",
            message: "Updated logLevel section",
            metadata: {
              section: "logLevel",
              user: "Moshe Anconina",
              summary: "Updated logLevel section",
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------------
  // config.diff
  // ------------------------------------------------------------------------

  it("config.diff: request accepts an empty object (sha optional)", () => {
    expect(() => ConfigDiffContract.request.parse({})).not.toThrow();
  });

  it("config.diff: request accepts a sha string", () => {
    expect(() =>
      ConfigDiffContract.request.parse({ sha: "abc1234" }),
    ).not.toThrow();
  });

  it("config.diff: response accepts a populated diff", () => {
    expect(() =>
      ConfigDiffContract.response.parse({
        diff: "--- a/config.yaml\n+++ b/config.yaml\n@@ -1 +1 @@\n-foo\n+bar",
      }),
    ).not.toThrow();
  });

  it("config.diff: response accepts the graceful-degradation error path", () => {
    expect(() =>
      ConfigDiffContract.response.parse({
        diff: "",
        error: "Config versioning not available",
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------------
  // config.rollback
  // ------------------------------------------------------------------------

  it("config.rollback: request requires sha (min(1))", () => {
    expect(() => ConfigRollbackContract.request.parse({})).toThrow();
    expect(() =>
      ConfigRollbackContract.request.parse({ sha: "" }),
    ).toThrow();
  });

  it("config.rollback: request accepts a non-empty sha string", () => {
    expect(() =>
      ConfigRollbackContract.request.parse({ sha: "abc1234" }),
    ).not.toThrow();
  });

  it("config.rollback: response requires rolledBack: true + sha + newCommitSha + restarting: true", () => {
    expect(() =>
      ConfigRollbackContract.response.parse({
        rolledBack: true,
        sha: "abc1234",
        newCommitSha: "ef0123",
        restarting: true,
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------------
  // config.gc
  // ------------------------------------------------------------------------

  it("config.gc: request accepts an empty object", () => {
    expect(() => ConfigGcContract.request.parse({})).not.toThrow();
  });

  it("config.gc: request accepts olderThan string", () => {
    expect(() =>
      ConfigGcContract.request.parse({ olderThan: "30 days ago" }),
    ).not.toThrow();
  });

  it("config.gc: response accepts the minimal { gc: true } shape", () => {
    expect(() =>
      ConfigGcContract.response.parse({ gc: true }),
    ).not.toThrow();
  });

  it("config.gc: response accepts the post-squash shape with squashed + newRootSha", () => {
    expect(() =>
      ConfigGcContract.response.parse({
        gc: true,
        squashed: 42,
        newRootSha: "f00ba12",
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------------
  // gateway.status
  // ------------------------------------------------------------------------

  it("gateway.status: request accepts an empty object", () => {
    expect(() => GatewayStatusContract.request.parse({})).not.toThrow();
  });

  it("gateway.status: response requires all 7 fields (pid/uptime/memoryUsage/nodeVersion/configPaths/sections/secretsStoreAvailable)", () => {
    expect(() =>
      GatewayStatusContract.response.parse({
        pid: 12345,
        uptime: 3600.5,
        memoryUsage: 100_000_000,
        nodeVersion: "v22.4.1",
        configPaths: ["/home/u/.comis/config.yaml"],
        sections: ["agents", "logLevel"],
        secretsStoreAvailable: true,
      }),
    ).not.toThrow();
    // false also valid
    expect(() =>
      GatewayStatusContract.response.parse({
        pid: 12345,
        uptime: 3600.5,
        memoryUsage: 100_000_000,
        nodeVersion: "v22.4.1",
        configPaths: [],
        sections: [],
        secretsStoreAvailable: false,
      }),
    ).not.toThrow();
    // Missing secretsStoreAvailable must fail
    expect(() =>
      GatewayStatusContract.response.parse({
        pid: 12345,
        uptime: 3600.5,
        memoryUsage: 100_000_000,
        nodeVersion: "v22.4.1",
        configPaths: [],
        sections: [],
      }),
    ).toThrow();
  });

  it("gateway.status: response rejects missing required fields", () => {
    expect(() =>
      GatewayStatusContract.response.parse({
        pid: 12345,
        uptime: 3600,
        memoryUsage: 100,
        nodeVersion: "v22.4.1",
        // missing configPaths + sections
      }),
    ).toThrow();
  });

  // ------------------------------------------------------------------------
  // gateway.restart
  // ------------------------------------------------------------------------

  it("gateway.restart: request accepts an empty object", () => {
    expect(() => GatewayRestartContract.request.parse({})).not.toThrow();
  });

  it("gateway.restart: response requires restarting: true + systemd boolean", () => {
    expect(() =>
      GatewayRestartContract.response.parse({
        restarting: true,
        systemd: true,
      }),
    ).not.toThrow();
    expect(() =>
      GatewayRestartContract.response.parse({
        restarting: true,
        systemd: false,
        warning:
          "Not running under systemd. Process will exit and require manual restart.",
      }),
    ).not.toThrow();
  });

  it("gateway.restart: response rejects restarting: false (success-only literal)", () => {
    expect(() =>
      GatewayRestartContract.response.parse({
        restarting: false,
        systemd: true,
      }),
    ).toThrow();
  });

  // ------------------------------------------------------------------------
  // env.set
  // ------------------------------------------------------------------------

  it("env.set: request requires key + value (both min(1))", () => {
    expect(() => EnvSetContract.request.parse({})).toThrow();
    expect(() => EnvSetContract.request.parse({ key: "OPENAI_API_KEY" })).toThrow();
    expect(() =>
      EnvSetContract.request.parse({ key: "", value: "secret" }),
    ).toThrow();
    expect(() =>
      EnvSetContract.request.parse({ key: "OPENAI_API_KEY", value: "" }),
    ).toThrow();
  });

  it("env.set: request accepts a non-empty key + value", () => {
    expect(() =>
      EnvSetContract.request.parse({
        key: "OPENAI_API_KEY",
        value: "sk-abc123",
      }),
    ).not.toThrow();
  });

  it("env.set: response accepts the encrypted storage variant", () => {
    // "encrypted" is the SecretStorePort-backed member of the closed
    // storage enum (["encrypted", "file"] — see EnvSetContract).
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "encrypted",
        restarting: true,
      }),
    ).not.toThrow();
  });

  it("env.set: response rejects an unknown storage value", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "vault",
        restarting: true,
      }),
    ).toThrow();
  });

  it("env.set: response rejects set: false (success-only literal)", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: false,
        key: "OPENAI_API_KEY",
        storage: "encrypted",
        restarting: true,
      }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // EnvSetContract storage/restarting variants — storage is
  // z.enum(["encrypted","file"]) and restarting is z.boolean().
  // ---------------------------------------------------------------------------

  it("env.set: response accepts the file storage variant", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "file",
        restarting: true,
      }),
    ).not.toThrow();
  });

  it("env.set: response accepts file storage with restarting:false", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "file",
        restarting: false,
      }),
    ).not.toThrow();
  });

  it("env.set: response accepts encrypted storage with restarting:false", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "encrypted",
        restarting: false,
      }),
    ).not.toThrow();
  });

  it("env.set: response rejects env storage (env is read-only, not a writable backend)", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "env",
        restarting: true,
      }),
    ).toThrow();
  });

  it("env.set: response rejects restarting as a string (must be boolean not string)", () => {
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "file",
        restarting: "yes",
      }),
    ).toThrow();
  });

  it("env.set: response REJECTS accidental value/plaintext/secret fields (residency canary)", () => {
    // Strict by default — no .passthrough(). A future leak that
    // adds `value` to the return shape fails the dev-mode parse.
    expect(() =>
      EnvSetContract.response.parse({
        set: true,
        key: "OPENAI_API_KEY",
        storage: "encrypted",
        restarting: true,
        value: "sk-leaked",
      }),
    ).not.toThrow(); // strip-by-default — z.object().parse() drops unknown keys silently;
    // the residency canary is the COMPILE-TIME schema diff PLUS the
    // "never has a value field" structural-test posture. We assert
    // here that the parsed output drops `value`:
    const parsed = EnvSetContract.response.parse({
      set: true,
      key: "OPENAI_API_KEY",
      storage: "encrypted",
      restarting: true,
      value: "sk-should-be-stripped",
    });
    expect(parsed).not.toHaveProperty("value");
  });

  // ------------------------------------------------------------------------
  // env.list
  // ------------------------------------------------------------------------

  it("env.list: request accepts an empty object", () => {
    expect(() => EnvListContract.request.parse({})).not.toThrow();
  });

  it("env.list: request accepts a filter + limit", () => {
    expect(() =>
      EnvListContract.request.parse({ filter: "OPENAI_*", limit: 50 }),
    ).not.toThrow();
  });

  it("env.list: response accepts an empty secrets array", () => {
    expect(() =>
      EnvListContract.response.parse({
        secrets: [],
        total: 0,
        truncated: false,
      }),
    ).not.toThrow();
  });

  it("env.list: response accepts both source variants (envfile + secretstore)", () => {
    expect(() =>
      EnvListContract.response.parse({
        secrets: [
          { name: "OPENAI_API_KEY", source: "envfile" },
          {
            name: "ANTHROPIC_API_KEY",
            source: "secretstore",
            provider: "anthropic",
            description: "Production API key",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_001_000_000,
            expiresAt: 1_800_000_000_000,
          },
        ],
        total: 2,
        truncated: false,
      }),
    ).not.toThrow();
  });

  it("env.list: response REJECTS rows missing the required name field", () => {
    expect(() =>
      EnvListContract.response.parse({
        secrets: [{ source: "envfile" }],
        total: 1,
        truncated: false,
      }),
    ).toThrow();
  });

  it("env.list: response REJECTS rows with an unknown source value", () => {
    expect(() =>
      EnvListContract.response.parse({
        secrets: [{ name: "X", source: "vault" }],
        total: 1,
        truncated: false,
      }),
    ).toThrow();
  });

  it("env.list: response strips accidental value/plaintext/secret fields (residency canary)", () => {
    // Strict by default — z.object().parse() drops unknown keys.
    const parsed = EnvListContract.response.parse({
      secrets: [
        {
          name: "OPENAI_API_KEY",
          source: "secretstore",
          value: "sk-leaked",
          plaintext: "sk-leaked-2",
          ciphertext: "deadbeef",
        },
      ],
      total: 1,
      truncated: false,
    });
    expect(parsed.secrets[0]).not.toHaveProperty("value");
    expect(parsed.secrets[0]).not.toHaveProperty("plaintext");
    expect(parsed.secrets[0]).not.toHaveProperty("ciphertext");
  });
});
