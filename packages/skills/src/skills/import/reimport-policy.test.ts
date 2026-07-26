// SPDX-License-Identifier: Apache-2.0
/** Pure content-hash and trust policy for skill re-imports. */
import { describe, expect, it } from "vitest";
import { decideSkillReimport } from "./reimport-policy.js";

describe("decideSkillReimport", () => {
  it("returns no-op when the candidate and incumbent hashes match", () => {
    expect(
      decideSkillReimport({
        incumbentHash: "sha256:a",
        incumbentTrust: "first-party",
        candidateHash: "sha256:a",
        candidateTrust: "community",
        confirmed: false,
      }),
    ).toBe("no_op");
  });

  it("refuses different bytes from a lower-trust candidate", () => {
    expect(
      decideSkillReimport({
        incumbentHash: "sha256:a",
        incumbentTrust: "operator",
        candidateHash: "sha256:b",
        candidateTrust: "community",
        confirmed: true,
      }),
    ).toBe("refuse");
  });

  it("requires confirmation for different bytes at equal trust", () => {
    const input = {
      incumbentHash: "sha256:a",
      incumbentTrust: "community" as const,
      candidateHash: "sha256:b",
      candidateTrust: "community" as const,
    };

    expect(decideSkillReimport({ ...input, confirmed: false })).toBe("confirm");
    expect(decideSkillReimport({ ...input, confirmed: true })).toBe("install");
  });

  it("still requires confirmation when the candidate has higher trust", () => {
    const input = {
      incumbentHash: "sha256:a",
      incumbentTrust: "agent-authored" as const,
      candidateHash: "sha256:b",
      candidateTrust: "operator" as const,
    };

    expect(decideSkillReimport({ ...input, confirmed: false })).toBe("confirm");
    expect(decideSkillReimport({ ...input, confirmed: true })).toBe("install");
  });
});
