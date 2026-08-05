// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  enforceCitationEvidence,
  historicalCitationDigests,
} from "./citation-evidence.js";

function urlDigest(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

describe("exact citation evidence grounding", () => {
  it("removes a one-character citation mutation that lacks an exact fetch digest", () => {
    const fetched = "https://httpbingo.org/base64/UkVTRUFSQ0hfT1ZFUlJJREVfMjAyNjA4MDQ=";
    const mutated = "https://httpbingo.org/base64/UkVTRUFSQ0hfT1ZFUlJJREVfMjAyNjA4MDE=";
    const mdn = "https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API";

    const guarded = enforceCitationEvidence({
      response: `- [MDN](${mdn})\n- [hostile-page fixture](${mutated})`,
      allowedUrlDigests: [urlDigest(mdn), urlDigest(fetched)],
      enabled: true,
    });

    expect(guarded).toEqual({
      response: `- [MDN](${mdn})\n- hostile-page fixture`,
      corrected: true,
      reason: "citation_without_fetch_evidence",
      matchedDigests: [urlDigest(mdn)],
      removedCitationCount: 1,
    });
    expect(guarded.response).not.toContain(mutated);
  });

  it("preserves exact fetched citations and a code-formatted unreachable URL", () => {
    const fetched = "https://html.spec.whatwg.org/multipage/webstorage.html";
    const response =
      `[WHATWG](${fetched})\nUnreachable and not used as a source: \`https://missing.invalid/source\``;

    expect(enforceCitationEvidence({
      response,
      allowedUrlDigests: [urlDigest(fetched)],
      enabled: true,
    })).toEqual({
      response,
      corrected: false,
      matchedDigests: [urlDigest(fetched)],
      removedCitationCount: 0,
    });
  });

  it("does not filter citations outside an evidence-bearing research turn", () => {
    const response = "Project home: https://example.com/product";
    expect(enforceCitationEvidence({
      response,
      allowedUrlDigests: [],
      enabled: false,
    })).toEqual({
      response,
      corrected: false,
      matchedDigests: [],
      removedCitationCount: 0,
    });
  });

  it("reads only assistant evidence from before the current request", () => {
    const trusted = "a".repeat(64);
    const current = "b".repeat(64);
    expect(historicalCitationDigests({
      messages: [
        { role: "user", content: "research this" },
        { role: "assistant", citationEvidenceDigests: [trusted] },
        { role: "user", content: "where is that from" },
        { role: "assistant", citationEvidenceDigests: [current] },
      ],
    })).toEqual([trusted]);
  });
});
