// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { AgentToAgentConfigSchema, SecurityConfigSchema } from "./schema-security.js";
import type { CredentialStorageMode } from "./schema-security.js";

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
  it("defaults to false when omitted", () => {
    const result = AgentToAgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subAgentSessionPersistence).toBe(false);
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
      expect(result.data.agentToAgent.subAgentSessionPersistence).toBe(false);
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
