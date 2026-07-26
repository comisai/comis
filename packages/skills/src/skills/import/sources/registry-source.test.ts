// SPDX-License-Identifier: Apache-2.0
/** Pure registry response-mapping contract. */
import { describe, expect, it } from "vitest";
import { deriveSkillTrustTier } from "../trust-tier.js";
import {
  mapSkillRegistryResolution,
  parseSkillRegistryRef,
} from "./registry-source.js";

const detail = {
  skill: { slug: "summarize" },
  latestVersion: { version: "1.2.3" },
};

const verdict = {
  schema: "registry.skill.security-verdicts.v1",
  items: [
    {
      ok: true,
      decision: "pass",
      reasons: [],
      requestedSlug: "summarize",
      slug: "summarize",
      requestedVersion: "1.2.3",
      version: "1.2.3",
      publisherHandle: "publisher_a",
      publisherVerified: true,
      checkedAt: 1_700_000_000_000,
      securityAuditUrl: "https://registry.example/publisher_a/summarize/security-audit",
      security: { status: "clean", passed: true },
    },
  ],
};

describe("parseSkillRegistryRef", () => {
  it("parses exact and latest registry references without broadening slugs", () => {
    expect(parseSkillRegistryRef("summarize")).toEqual({
      ok: true,
      value: { slug: "summarize" },
    });
    expect(parseSkillRegistryRef("summarize@1.2.3")).toEqual({
      ok: true,
      value: { slug: "summarize", version: "1.2.3" },
    });
    expect(parseSkillRegistryRef("../summarize@1.2.3").ok).toBe(false);
  });
});

describe("mapSkillRegistryResolution", () => {
  it("maps the resolved version and full registry evidence tuple", () => {
    const result = mapSkillRegistryResolution({
      ref: { slug: "summarize" },
      detail,
      verdict,
      downloadUrl: "https://registry.example/api/v1/download?slug=summarize&version=1.2.3",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        slug: "summarize",
        version: "1.2.3",
        download: {
          kind: "archive",
          url: "https://registry.example/api/v1/download?slug=summarize&version=1.2.3",
        },
        evidence: {
          publisherHandle: "publisher_a",
          publisherVerified: true,
          securityStatus: "clean",
          securityPassed: true,
          securityAuditUrl: "https://registry.example/publisher_a/summarize/security-audit",
          checkedAt: "2023-11-14T22:13:20.000Z",
          registryDecision: "pass",
        },
      },
    });
  });

  it("rejects response drift and identity mismatches instead of importing ambiguous bytes", () => {
    expect(
      mapSkillRegistryResolution({
        ref: { slug: "summarize" },
        detail: { ...detail, skill: { slug: "different" } },
        verdict,
        downloadUrl: "https://registry.example/api/v1/download?slug=summarize&version=1.2.3",
      }),
    ).toMatchObject({ ok: false, error: { kind: "identity_mismatch" } });

    expect(
      mapSkillRegistryResolution({
        ref: { slug: "summarize" },
        detail,
        verdict: { items: [{ decision: "pass" }] },
        downloadUrl: "https://registry.example/api/v1/download?slug=summarize&version=1.2.3",
      }),
    ).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });

  it("keeps registry security evidence separate from trust derivation", () => {
    const result = mapSkillRegistryResolution({
      ref: { slug: "summarize", version: "1.2.3" },
      detail,
      verdict,
      downloadUrl: "https://registry.example/api/v1/download?slug=summarize&version=1.2.3",
    });
    expect(result.ok).toBe(true);

    expect(
      deriveSkillTrustTier({
        source: "registry",
        callingAgentId: "default",
        defaultAgentId: "default",
      }),
    ).toBe("community");
    if (result.ok) expect(result.value.evidence.securityPassed).toBe(true);
  });
});
