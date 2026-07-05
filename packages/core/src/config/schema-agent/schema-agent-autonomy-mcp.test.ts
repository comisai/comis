// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  AutonomyMcpConfigSchema,
  permitsMcpTool,
  type AutonomyMcpConfig,
} from "./schema-agent-autonomy-mcp.js";

// ---------------------------------------------------------------------------
// The inbound MCP allowlist leaf — the SECOND default-deny layer behind the
// `orch:mcp` capability grant. A nested default-off `z.strictObject`: `enabled`
// is the surface gate, `allow` is a per-server map of { explicit tool names, a
// 3-tier inbound classification }. The pure `permitsMcpTool` resolver answers
// "is this {server,tool} listed AND classified reachable?" — deny by absence at
// every step. The classification MIRRORS the SHAPE of the outbound export policy
// ("safe" | "permission-gated" | absent ⇒ deny) but is a SEPARATE inbound field.
// Pure schema leaf: imports only zod (no env/clock/fs).
// ---------------------------------------------------------------------------

describe("AutonomyMcpConfigSchema (nested default-off inbound leaf)", () => {
  it("parse({}) resolves the default-off empty surface { enabled:false, allow:{} }", () => {
    expect(AutonomyMcpConfigSchema.parse({})).toEqual({ enabled: false, allow: {} });
  });

  it("round-trips a populated allowlist (enabled + per-server tools + classification)", () => {
    const parsed = AutonomyMcpConfigSchema.parse({
      enabled: true,
      allow: { srv: { tools: ["read_file"], classification: "safe" } },
    });
    expect(parsed).toEqual({
      enabled: true,
      allow: { srv: { tools: ["read_file"], classification: "safe" } },
    });
  });

  it("accepts BOTH inbound classification tiers ('safe' and 'permission-gated')", () => {
    expect(
      AutonomyMcpConfigSchema.safeParse({ allow: { a: { tools: ["t"], classification: "safe" } } })
        .success,
    ).toBe(true);
    expect(
      AutonomyMcpConfigSchema.safeParse({
        allow: { a: { tools: ["t"], classification: "permission-gated" } },
      }).success,
    ).toBe(true);
  });

  it("REJECTS any classification outside the closed inbound enum (incl. the outbound 'never-export')", () => {
    // "never-export" is the OUTBOUND export-policy value; inbound, an absent
    // classification already means deny, so it is not an accepted inbound tier.
    expect(
      AutonomyMcpConfigSchema.safeParse({
        allow: { a: { tools: ["t"], classification: "never-export" } },
      }).success,
    ).toBe(false);
    expect(
      AutonomyMcpConfigSchema.safeParse({ allow: { a: { tools: ["t"], classification: "bogus" } } })
        .success,
    ).toBe(false);
  });

  it("per-server tools defaults to an empty explicit list (no '*' wildcard special-case)", () => {
    const parsed = AutonomyMcpConfigSchema.parse({ allow: { a: {} } });
    expect(parsed.allow.a.tools).toEqual([]);
  });

  it("strictObject REJECTS an unknown top-level key (typo guard, fails-closed)", () => {
    expect(AutonomyMcpConfigSchema.safeParse({ enabld: true }).success).toBe(false);
  });

  it("strictObject REJECTS an unknown per-server key (typo guard, fails-closed)", () => {
    expect(
      AutonomyMcpConfigSchema.safeParse({ allow: { a: { tools: [], toolz: [] } } }).success,
    ).toBe(false);
  });
});

describe("permitsMcpTool (pure inbound allowlist resolver — deny by absence)", () => {
  const cfg: AutonomyMcpConfig = AutonomyMcpConfigSchema.parse({
    enabled: true,
    allow: {
      files: { tools: ["read_file", "list_dir"], classification: "safe" },
      gated: { tools: ["do_thing"], classification: "permission-gated" },
      unclassified: { tools: ["x"] }, // classification absent ⇒ never-export ⇒ deny
    },
  });

  it("PERMITS a listed tool on a 'safe'-classified server", () => {
    expect(permitsMcpTool(cfg, "files", "read_file")).toBe(true);
  });

  it("PERMITS a listed tool on a 'permission-gated' server (the approval gate fires in the executor, not here)", () => {
    expect(permitsMcpTool(cfg, "gated", "do_thing")).toBe(true);
  });

  it("DENIES an unlisted server (deny by absence — the fresh-agent default)", () => {
    expect(permitsMcpTool(cfg, "other", "read_file")).toBe(false);
  });

  it("DENIES a listed server but an unlisted tool", () => {
    expect(permitsMcpTool(cfg, "files", "write_file")).toBe(false);
  });

  it("DENIES a listed server+tool whose classification is ABSENT (undefined ⇒ never-export ⇒ deny)", () => {
    expect(permitsMcpTool(cfg, "unclassified", "x")).toBe(false);
  });

  it("DENIES everything for a fresh empty allow map (the layer-2 default-deny)", () => {
    const empty = AutonomyMcpConfigSchema.parse({});
    expect(permitsMcpTool(empty, "files", "read_file")).toBe(false);
  });

  it("is prototype-safe: a '__proto__'/'constructor' server name resolves no inherited object", () => {
    expect(permitsMcpTool(cfg, "__proto__", "read_file")).toBe(false);
    expect(permitsMcpTool(cfg, "constructor", "read_file")).toBe(false);
  });
});
