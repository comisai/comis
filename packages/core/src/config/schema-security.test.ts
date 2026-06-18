// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { AgentToAgentConfigSchema, SecurityConfigSchema } from "./schema-security.js";
import type { CredentialStorageMode } from "./schema-security.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// SecurityConfigSchema.storage — RED tests (added before production patch)
// ---------------------------------------------------------------------------

describe("SecurityConfigSchema.storage credential storage backend", () => {
  it("security.storage defaults to encrypted when not specified", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.storage).toBe("encrypted");
    }
  });

  it("security.storage accepts all three valid values: encrypted, file, env", () => {
    for (const value of ["encrypted", "file", "env"] as const) {
      const result = SecurityConfigSchema.safeParse({ storage: value });
      expect(result.success, `Expected storage "${value}" to be accepted`).toBe(true);
      if (result.success) {
        expect(result.data.storage).toBe(value);
      }
    }
  });

  it("security.storage rejects an unknown value with a Zod error", () => {
    const result = SecurityConfigSchema.safeParse({ storage: "plaintext" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CredentialStorageMode type — GREEN test (compile-time + runtime sentinel;
// landed in GREEN commit per AGENTS.md §2.10 since type cannot compile
// against pre-patch code where the type did not exist).
// ---------------------------------------------------------------------------

describe("CredentialStorageMode type covers encrypted, file, and env", () => {
  it("CredentialStorageMode accepts encrypted as a valid value", () => {
    const _check: CredentialStorageMode = "encrypted";
    expect(_check).toBe("encrypted");
  });

  it("CredentialStorageMode accepts file as a valid value", () => {
    const _check: CredentialStorageMode = "file";
    expect(_check).toBe("file");
  });

  it("CredentialStorageMode accepts env as a valid value", () => {
    const _check: CredentialStorageMode = "env";
    expect(_check).toBe("env");
  });

  it("CredentialStorageMode is derived from the security.storage enum shape", () => {
    // The storage field uses .default("encrypted") which wraps a ZodEnum.
    // Access the inner enum via innerType() to read the options array.
    const enumValues = SecurityConfigSchema.shape.storage.removeDefault().options;
    expect(enumValues).toContain("encrypted");
    expect(enumValues).toContain("file");
    expect(enumValues).toContain("env");
    expect(enumValues).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// AgentToAgentConfigSchema.subAgentSessionPersistence
// ---------------------------------------------------------------------------

describe("AgentToAgentConfigSchema.subAgentSessionPersistence", () => {
  it("defaults to true when omitted", () => {
    const result = AgentToAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(true);
    }
  });

  it("accepts explicit true", () => {
    const result = AgentToAgentConfigSchema.safeParse({
      subAgentSessionPersistence: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(true);
    }
  });

  it("accepts explicit false", () => {
    const result = AgentToAgentConfigSchema.safeParse({
      subAgentSessionPersistence: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(false);
    }
  });

  it("rejects non-boolean value", () => {
    const result = AgentToAgentConfigSchema.safeParse({
      subAgentSessionPersistence: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("is present in SecurityConfigSchema parsed output", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.subAgentSessionPersistence).toBe(true);
    }
  });

  it("is present in SecurityConfigSchema when set to true", () => {
    const result = SecurityConfigSchema.safeParse({
      agentToAgent: { subAgentSessionPersistence: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.subAgentSessionPersistence).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AgentToAgentConfigSchema.tokenBudget (BUDGET-03) — per-spawn token budget
// default; co-located under the existing security.agentToAgent section (D1),
// so NO new SECTION_REGISTRY entry. null (default) = inherit graph share when a
// graph budget is set, else unbounded (today's behavior).
// ---------------------------------------------------------------------------

describe("AgentToAgentConfigSchema.tokenBudget", () => {
  it("defaults to null when omitted", () => {
    const result = AgentToAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tokenBudget).toBeNull();
    }
  });

  it("accepts a positive-integer value and preserves it", () => {
    const result = AgentToAgentConfigSchema.safeParse({ tokenBudget: 100_000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tokenBudget).toBe(100_000);
    }
  });

  it("rejects zero, negative, and fractional values (positive int when non-null)", () => {
    expect(AgentToAgentConfigSchema.safeParse({ tokenBudget: 0 }).success).toBe(false);
    expect(AgentToAgentConfigSchema.safeParse({ tokenBudget: -1 }).success).toBe(false);
    expect(AgentToAgentConfigSchema.safeParse({ tokenBudget: 2.5 }).success).toBe(false);
  });

  it("accepts explicit null (inherit / unbounded)", () => {
    const result = AgentToAgentConfigSchema.safeParse({ tokenBudget: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tokenBudget).toBeNull();
    }
  });

  it("is present in SecurityConfigSchema parsed output defaulting to null", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.tokenBudget).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AgentToAgentConfigSchema.delivery.maxRetries (DELIVERY-01/02) — max transient
// delivery retries before dead-lettering. Co-located under the existing
// security.agentToAgent section (D1), so NO new SECTION_REGISTRY entry. Every
// field .default() (AGENTS.md §6.4): parsing `{}` yields delivery.maxRetries=3.
// ---------------------------------------------------------------------------

describe("AgentToAgentConfigSchema.delivery.maxRetries", () => {
  it("defaults to 3 when delivery is omitted entirely", () => {
    const result = AgentToAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delivery.maxRetries).toBe(3);
    }
  });

  it("defaults to 3 when delivery is present but maxRetries is omitted", () => {
    const result = AgentToAgentConfigSchema.safeParse({ delivery: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delivery.maxRetries).toBe(3);
    }
  });

  it("accepts the in-range boundary values 0 and 10", () => {
    for (const value of [0, 10]) {
      const result = AgentToAgentConfigSchema.safeParse({ delivery: { maxRetries: value } });
      expect(result.success, `Expected maxRetries ${value} to be accepted`).toBe(true);
      if (result.success) {
        expect(result.data.delivery.maxRetries).toBe(value);
      }
    }
  });

  it("rejects out-of-range values 11 (>max 10) and -1 (<min 0)", () => {
    expect(AgentToAgentConfigSchema.safeParse({ delivery: { maxRetries: 11 } }).success).toBe(false);
    expect(AgentToAgentConfigSchema.safeParse({ delivery: { maxRetries: -1 } }).success).toBe(false);
  });

  it("rejects a fractional value (int only)", () => {
    expect(AgentToAgentConfigSchema.safeParse({ delivery: { maxRetries: 2.5 } }).success).toBe(false);
  });

  it("is present in SecurityConfigSchema parsed output defaulting to 3", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.delivery.maxRetries).toBe(3);
    }
  });

  it("adds ZERO new SECTION_REGISTRY entries — delivery nests in the existing security.agentToAgent section (D1)", () => {
    // The delivery field is a nested object under the already-registered
    // `security.agentToAgent` section. There must be no `delivery` token in the
    // section registry — a new registry entry would be a churn regression.
    const registrySrc = readFileSync(resolve(here, "./section-registry.ts"), "utf8");
    expect(registrySrc).not.toMatch(/['"`]delivery['"`]/);
    expect(registrySrc).not.toMatch(/maxRetries/);
  });
});

// ---------------------------------------------------------------------------
// AgentToAgentConfigSchema.sandboxNoDowngrade (SANDBOX-02/03, D1) — the one
// documented off-switch for the fail-closed sandbox no-downgrade gate. Defaults
// TRUE (pure safety / fail-closed). Co-located under the existing
// security.agentToAgent section, so NO new SECTION_REGISTRY entry. Every field
// .default() (AGENTS.md §6.4) — the spawn gate reads it, never `?? true`.
// ---------------------------------------------------------------------------

describe("AgentToAgentConfigSchema.sandboxNoDowngrade", () => {
  it("defaults to true when omitted (fail-closed by default)", () => {
    const result = AgentToAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sandboxNoDowngrade).toBe(true);
    }
  });

  it("accepts explicit false and round-trips it (the documented off-switch)", () => {
    const result = AgentToAgentConfigSchema.safeParse({ sandboxNoDowngrade: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sandboxNoDowngrade).toBe(false);
    }
  });

  it("accepts explicit true and round-trips it", () => {
    const result = AgentToAgentConfigSchema.safeParse({ sandboxNoDowngrade: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sandboxNoDowngrade).toBe(true);
    }
  });

  it("rejects a non-boolean value", () => {
    expect(AgentToAgentConfigSchema.safeParse({ sandboxNoDowngrade: "yes" }).success).toBe(false);
  });

  it("is present in SecurityConfigSchema parsed output defaulting to true", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentToAgent.sandboxNoDowngrade).toBe(true);
    }
  });

  it("adds ZERO new SECTION_REGISTRY entries — sandboxNoDowngrade nests in the existing security.agentToAgent section (D1)", () => {
    // The field nests in the already-registered `security.agentToAgent` section.
    // There must be no `sandboxNoDowngrade` token in the section registry — a new
    // registry entry would be a churn regression (the 170/171 tokenBudget/delivery
    // precedent).
    const registrySrc = readFileSync(resolve(here, "./section-registry.ts"), "utf8");
    expect(registrySrc).not.toMatch(/sandboxNoDowngrade/);
  });
});
