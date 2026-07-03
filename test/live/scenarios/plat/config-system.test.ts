// SPDX-License-Identifier: Apache-2.0
/**
 * PLAT-02 — config-system certification (the keystone deterministic file).
 *
 * Certifies the config system end-to-end at the pure-function layer:
 *   - fail-fast on invalid config (the closed ConfigError codes: FILE_NOT_FOUND / PARSE_ERROR /
 *     VALIDATION_ERROR / ENV_VAR_ERROR);
 *   - layering/cascade precedence (deepMerge object-recurse / array-replace / primitive-override /
 *     undefined-ignore / proto-filter; mergeLayered later-wins; loadLayered defaults < envLayer < YAML);
 *   - ${VAR} resolution (substituteEnvVars resolves + missing-var ENV_VAR_ERROR; loadConfigFile round-trip;
 *     findUnresolvedEnvRefs surfaces an unresolved ref);
 *   - the isImmutableConfigPath truth-table (security/security.storage immutable ⇒ restart-required;
 *     agents.*.maxSteps / agents.*.model / integrations.mcp.servers mutable);
 *   - the config-audit record (createConfigWriteAuditRecordBase + finalizeConfigWriteAuditRecord) carries a
 *     result + no secret value; the REAL config:patched event shape round-trips on a TypedEventBus.
 *
 * Deterministic, no daemon/key/network. The live config.patch RPC + SIGUSR2-restart + last-known-good
 * rollback over the gateway is Stage-C (it.skip).
 *
 * NOTE: generic config mutation emits audit:event + config:patched + the config-audit JSONL stream — NOT a
 * generic config:mutated (that event is integrations.mcp.servers-scoped only).
 *
 * costTier: "$0".
 *
 * @module
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  validateConfig,
  loadConfigFile,
  deepMerge,
  mergeLayered,
  loadLayered,
  substituteEnvVars,
  findUnresolvedEnvRefs,
  isImmutableConfigPath,
  MUTABLE_CONFIG_OVERRIDES,
  IMMUTABLE_CONFIG_PREFIXES,
  TypedEventBus,
} from "@comis/core";
import {
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
} from "@comis/observability";
import {
  INVALID_CONFIGS,
  MALFORMED_YAML,
  ARRAY_TOP_LEVEL,
  ENV_VAR_FIXTURE,
  makeGetSecret,
  LAYER_BASE,
  LAYER_OVERRIDE,
  writeTmpConfigFile,
  makeTmpDataDir,
  SECRET_CANARY,
} from "../../harness/plat-config.js";
import * as fs from "node:fs";

const isLive = !!process.env["COMIS_LIVE"];

const tmpDir = makeTmpDataDir();
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PLAT-02 Stage-B — fail-fast on invalid config (closed ConfigError codes)
// ---------------------------------------------------------------------------

describe("PLAT-02 Stage-B — config fail-fast (closed ConfigError codes)", () => {
  for (const { name, raw } of INVALID_CONFIGS) {
    it(`validateConfig rejects: ${name}`, () => {
      const r = validateConfig(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("VALIDATION_ERROR");
        expect(typeof r.error.message).toBe("string");
      }
    });
  }

  it("loadConfigFile(missing path) ⇒ FILE_NOT_FOUND", () => {
    const r = loadConfigFile(`/nonexistent-${Date.now()}.yaml`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FILE_NOT_FOUND");
  });

  it("loadConfigFile(malformed YAML) ⇒ PARSE_ERROR", () => {
    const p = writeTmpConfigFile(tmpDir, "bad.yaml", MALFORMED_YAML);
    const r = loadConfigFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PARSE_ERROR");
  });

  it("loadConfigFile(array top-level) ⇒ PARSE_ERROR", () => {
    const p = writeTmpConfigFile(tmpDir, "arr.json", ARRAY_TOP_LEVEL);
    const r = loadConfigFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PARSE_ERROR");
  });
});

// ---------------------------------------------------------------------------
// PLAT-02 Stage-B — layering / cascade precedence
// ---------------------------------------------------------------------------

describe("PLAT-02 Stage-B — layering / cascade precedence", () => {
  it("deepMerge: objects recurse, arrays replace, primitives override, undefined ignored", () => {
    const merged = deepMerge(LAYER_BASE, LAYER_OVERRIDE);
    // object recursion: nested.keep survives from base, nested.shared overridden.
    expect((merged.nested as Record<string, unknown>).keep).toBe("base");
    expect((merged.nested as Record<string, unknown>).shared).toBe("override");
    // array replace (not concat): the override's [9] wins entirely.
    expect(merged.arr).toEqual([9]);
    // primitive override.
    expect(merged.prim).toBe("override");
    // undefined override value is ignored (base survives).
    const merged2 = deepMerge({ a: "base" }, { a: undefined });
    expect(merged2.a).toBe("base");
  });

  it("deepMerge: __proto__ pollution key is filtered", () => {
    const merged = deepMerge({ safe: 1 }, JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>);
    expect((merged as Record<string, unknown>).safe).toBe(1);
    // The prototype was NOT polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("mergeLayered: later layer wins (via the raw merged out-param)", () => {
    const raw: { value?: Record<string, unknown> } = {};
    mergeLayered([{ tenantId: "first" }, { tenantId: "second" }], raw);
    expect(raw.value?.tenantId).toBe("second");
  });

  it("loadLayered: explicit YAML beats the envLayer (defaults < envLayer < YAML)", () => {
    const fileA = writeTmpConfigFile(tmpDir, "layerA.yaml", "tenantId: from-yaml");
    const raw: { value?: Record<string, unknown> } = {};
    const r = loadLayered([fileA], { envLayer: { tenantId: "from-env" }, rawMergedOut: raw });
    expect(r.ok).toBe(true);
    // The YAML layer is applied after the envLayer, so it wins.
    expect(raw.value?.tenantId).toBe("from-yaml");
  });
});

// ---------------------------------------------------------------------------
// PLAT-02 Stage-B — ${VAR} resolution
// ---------------------------------------------------------------------------

describe("PLAT-02 Stage-B — ${VAR} resolution", () => {
  it("substituteEnvVars resolves a ${VAR} from getSecret", () => {
    const r = substituteEnvVars(ENV_VAR_FIXTURE, makeGetSecret());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as Record<string, unknown>).tenantId).toBe("resolved-value");
  });

  it("substituteEnvVars on a missing var ⇒ ENV_VAR_ERROR", () => {
    const r = substituteEnvVars({ k: "${MISSING}" }, () => undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ENV_VAR_ERROR");
  });

  it("loadConfigFile({getSecret}) round-trips a ${VAR} to its resolved value", () => {
    const p = writeTmpConfigFile(tmpDir, "var.yaml", "tenantId: ${TEST_VAR}");
    const r = loadConfigFile(p, { getSecret: makeGetSecret() });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as Record<string, unknown>).tenantId).toBe("resolved-value");
  });

  it("findUnresolvedEnvRefs surfaces an unresolved ref", () => {
    const refs = findUnresolvedEnvRefs({ k: "${MISSING}" }, () => undefined);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.varName === "MISSING")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PLAT-02 Stage-B — immutable-keys truth-table (security.storage ⇒ restart-required)
// ---------------------------------------------------------------------------

describe("PLAT-02 Stage-B — isImmutableConfigPath truth-table", () => {
  it("rejects runtime mutation of security/security.storage/gateway.tls/agents/channels/integrations/providers/tooling/executor (immutable)", () => {
    expect(isImmutableConfigPath("security")).toBe(true);
    // security.storage selects the secret-store backend at boot ⇒ immutable ⇒ requires a restart to change.
    expect(isImmutableConfigPath("security", "storage")).toBe(true);
    expect(isImmutableConfigPath("gateway", "tls")).toBe(true);
    expect(isImmutableConfigPath("agents")).toBe(true);
    expect(isImmutableConfigPath("channels")).toBe(true);
    expect(isImmutableConfigPath("integrations")).toBe(true);
    expect(isImmutableConfigPath("providers")).toBe(true);
    expect(isImmutableConfigPath("tooling")).toBe(true);
    expect(isImmutableConfigPath("executor")).toBe(true);
  });

  it("agents.*.maxSteps / agents.*.model / integrations.mcp.servers ⇒ mutable override", () => {
    expect(isImmutableConfigPath("agents", "default.maxSteps")).toBe(false);
    expect(isImmutableConfigPath("agents", "default.model")).toBe(false);
    expect(isImmutableConfigPath("integrations", "mcp.servers")).toBe(false);
  });

  it("allows a plainly-mutable path (memory.maxEntries is not immutable)", () => {
    expect(isImmutableConfigPath("memory", "maxEntries")).toBe(false);
  });

  it("the immutable/mutable guard tables are configured (non-empty)", () => {
    expect(MUTABLE_CONFIG_OVERRIDES.length).toBeGreaterThan(0);
    expect(IMMUTABLE_CONFIG_PREFIXES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PLAT-02 Stage-B — config-audit record + the REAL config:patched event
// ---------------------------------------------------------------------------

describe("PLAT-02 Stage-B — config-audit record + config:patched event", () => {
  it("a config-audit record carries result and leaks no secret", () => {
    const base = createConfigWriteAuditRecordBase({
      source: "config-patch-rpc",
      configPath: `${tmpDir}/config.local.yaml`,
      pid: 1234,
      ppid: 1,
      argv: ["node", "daemon.js"],
      cwd: tmpDir,
      execArgv: [],
      watchMode: false,
      entryScript: "/x/comis/packages/daemon/dist/daemon.js",
    });
    expect(base).toBeDefined();

    const renamed = finalizeConfigWriteAuditRecord(base!, { result: "rename" });
    expect(renamed.result).toBe("rename");
    // The audit record carries provenance — NOT the secret value.
    expect(JSON.stringify(renamed)).not.toContain(SECRET_CANARY);

    const rejected = finalizeConfigWriteAuditRecord(base!, {
      result: "rejected",
      errorMessage: "Config path is immutable",
    });
    expect(rejected.result).toBe("rejected");
  });

  it("the REAL config:patched event ({section,key?,patchedBy,timestamp}) round-trips on a TypedEventBus", () => {
    const bus = new TypedEventBus();
    const seen: Array<{ section: string; key?: string }> = [];
    bus.on("config:patched", (e) => seen.push(e));
    bus.emit("config:patched", {
      section: "agents",
      key: "default.maxSteps",
      patchedBy: "system",
      timestamp: Date.now(),
    });
    expect(seen.length).toBe(1);
    expect(seen[0]!.section).toBe("agents");
    expect(seen[0]!.key).toBe("default.maxSteps");
  });
});

// ---------------------------------------------------------------------------
// PLAT-02 Stage-C — live config.patch RPC + SIGUSR2-restart + rollback (env-gated)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("PLAT-02 Stage-C — live config.patch RPC + restart + rollback (COMIS_LIVE)", () => {
  it.skip("SKIPPED(no-daemon/no-network) — live config.patch over the gateway → atomic YAML write → SIGUSR2 restart → last-known-good rollback on a bad config; needs a booted daemon container + the gateway HTTP server", () => {
    // Deferred to a COMIS_LIVE operator run. The pure guard (isImmutableConfigPath), the
    // config-audit record, and the config:patched event shape are covered in Stage-B above.
  });
});
