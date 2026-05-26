// SPDX-License-Identifier: Apache-2.0
/**
 * Header-credential classifier tests (Phase 1 — SEC keystone).
 *
 * RED anchor: the module does not exist pre-patch, so the import fails.
 * classifyHeaderCredential maps (name, value) → kind:
 *   - "ref"           — env-ref string (${VAR}/$VAR/$${VAR}) OR SecretRef object
 *   - "oauth-bearer"  — a Bearer-scheme value wrapping a secret-looking remainder
 *   - "static-secret" — a raw secret value with no auth scheme
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { classifyHeaderCredential } from "./credential-classify.js";

describe("classifyHeaderCredential", () => {
  it("classifies an ${VAR} env-ref string as ref", () => {
    expect(classifyHeaderCredential("Authorization", "${TOK}")).toEqual({ kind: "ref" });
  });

  it("classifies a bare $VAR env-ref string as ref", () => {
    expect(classifyHeaderCredential("Authorization", "$TOK")).toEqual({ kind: "ref" });
  });

  it("classifies a SecretRef object as ref", () => {
    expect(
      classifyHeaderCredential("Authorization", {
        source: "env",
        provider: "vault",
        id: "TOK",
      }),
    ).toEqual({ kind: "ref" });
  });

  it("classifies a Bearer-scheme secret as oauth-bearer", () => {
    expect(
      classifyHeaderCredential(
        "Authorization",
        "Bearer hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEf",
      ),
    ).toEqual({ kind: "oauth-bearer" });
  });

  it("classifies a raw schemeless secret value as static-secret", () => {
    expect(
      classifyHeaderCredential("X-Api-Key", "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef"),
    ).toEqual({ kind: "static-secret" });
  });
});
