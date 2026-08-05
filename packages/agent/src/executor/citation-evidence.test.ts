// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  enforceCitationEvidence,
  historicalCitationDigests,
} from "./citation-evidence.js";
import * as citationEvidenceModule from "./citation-evidence.js";

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

  it("reads runtime citation receipts from append-only session entries", () => {
    const digest = urlDigest("https://example.com/durable-source");
    expect(historicalCitationDigests({
      getEntries: () => [
        { type: "message", message: { role: "user", content: "research this" } },
        {
          type: "custom",
          customType: "citation_evidence",
          data: {
            sourceMessageId: "message_a",
            urlDigests: [digest],
          },
        },
      ],
    })).toEqual([digest]);
  });

  it("appends a bounded runtime citation receipt to the session journal", () => {
    const candidate = (citationEvidenceModule as Record<string, unknown>)
      .appendCitationEvidenceRecord;
    expect(candidate).toBeTypeOf("function");
    const entries: unknown[] = [];
    const manager = {
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
        return "entry_a";
      },
    };
    const digest = urlDigest("https://example.com/durable-source");

    const result = (candidate as (params: {
      sessionManager: typeof manager;
      sourceMessageId: string;
      urlDigests: readonly string[];
    }) => { ok: boolean })({
      sessionManager: manager,
      sourceMessageId: "message_a",
      urlDigests: [digest],
    });

    expect(result.ok).toBe(true);
    expect(entries).toEqual([{
      type: "custom",
      customType: "citation_evidence",
      data: {
        sourceMessageId: "message_a",
        urlDigests: [digest],
      },
    }]);
  });
});
