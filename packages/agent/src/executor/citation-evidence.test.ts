// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  appendCitationEvidenceRecord,
  enforceCitationEvidence,
  historicalCitationDigests,
  isCitationSourceRequest,
} from "./citation-evidence.js";
import * as citationEvidenceModule from "./citation-evidence.js";
import { sanitizeSessionSecrets } from "../session/sanitize-session-secrets.js";

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

  it("keeps a fetched citation written as prose with sentence punctuation", () => {
    const fetched = "https://example.com/report";
    const response = `Source: ${fetched}. Cited again as ${fetched}, then "${fetched}".`;

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

  it("removes an unverified prose URL but keeps the sentence terminator", () => {
    const fetched = "https://example.com/report";
    const guarded = enforceCitationEvidence({
      response: "Source: https://unverified.example/x. Nothing else.",
      allowedUrlDigests: [urlDigest(fetched)],
      enabled: true,
    });

    expect(guarded.response).toBe("Source: . Nothing else.");
    expect(guarded.removedCitationCount).toBe(1);
    expect(guarded.corrected).toBe(true);
  });

  it("keeps a fetched citation whose path carries balanced parentheses", () => {
    const fetched = "https://en.wikipedia.org/wiki/Comis_(software)";
    const response = `See [Comis (software)](${fetched}) — bare form ${fetched}.`;

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

  it("does not echo an unverified URL back through a markdown link label", () => {
    const unverified = "https://unverified.example/x";
    const guarded = enforceCitationEvidence({
      response: `Read more: [${unverified}](${unverified})`,
      allowedUrlDigests: [urlDigest("https://example.com/report")],
      enabled: true,
    });

    expect(guarded.response).not.toContain("unverified.example");
    expect(guarded.corrected).toBe(true);
    expect(guarded.removedCitationCount).toBeGreaterThanOrEqual(1);
  });

  it("strips an unverified URL out of an evidence-backed link's label", () => {
    const fetched = "https://example.com/report";
    const guarded = enforceCitationEvidence({
      response: `[https://unverified.example/x](${fetched})`,
      allowedUrlDigests: [urlDigest(fetched)],
      enabled: true,
    });

    expect(guarded.response).not.toContain("unverified.example");
    expect(guarded.response).toContain(fetched);
    expect(guarded.corrected).toBe(true);
    expect(guarded.matchedDigests).toEqual([urlDigest(fetched)]);
  });

  it("does not leave an unverified autolink inside a link label", () => {
    const fetched = "https://example.com/report";
    const guarded = enforceCitationEvidence({
      response: `[see <https://unverified.example/x> too](${fetched})`,
      allowedUrlDigests: [urlDigest(fetched)],
      enabled: true,
    });

    expect(guarded.response).not.toContain("unverified.example");
    expect(guarded.response).toContain(fetched);
    expect(guarded.corrected).toBe(true);
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

  it("reads only valid runtime journal receipts", () => {
    const trusted = "a".repeat(64);
    expect(historicalCitationDigests({
      getEntries: () => [
        {
          type: "message",
          message: { role: "assistant", citationEvidenceDigests: ["b".repeat(64)] },
        },
        {
          type: "custom",
          customType: "citation_evidence",
          data: { sourceMessageId: "message_a", urlDigests: [trusted] },
        },
        {
          type: "custom",
          customType: "citation_evidence",
          data: { urlDigests: ["c".repeat(64)] },
        },
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

  it("uses fresh fetch evidence instead of historical citation receipts", () => {
    const candidate = (citationEvidenceModule as Record<string, unknown>)
      .citationEvidenceDigestsForTurn;
    expect(candidate).toBeTypeOf("function");
    const selectDigests = candidate as (params: {
      currentFetchDigests: readonly string[];
      relayedDigests: readonly string[];
      historicalDigests: readonly string[];
    }) => string[];
    const current = urlDigest("https://example.com/current");
    const relayed = urlDigest("https://example.com/relayed");
    const historical = urlDigest("https://example.com/historical");

    expect(selectDigests({
      currentFetchDigests: [current],
      relayedDigests: [relayed],
      historicalDigests: [historical],
    })).toEqual([current, relayed]);
    expect(selectDigests({
      currentFetchDigests: [],
      relayedDigests: [],
      historicalDigests: [historical],
    })).toEqual([historical]);
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

  it("survives durable repair and session reopen without losing citation evidence", () => {
    const scratch = mkdtempSync(resolve(tmpdir(), "citation-evidence-journal-"));
    try {
      const manager = SessionManager.create(scratch, scratch);
      manager.appendMessage({ role: "user", content: "research this", timestamp: 1 });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "[Source](https://example.com/durable-source)" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-luna",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const digest = urlDigest("https://example.com/durable-source");
      expect(appendCitationEvidenceRecord({
        sessionManager: manager,
        sourceMessageId: "message_a",
        urlDigests: [digest],
      }).ok).toBe(true);
      const sessionFile = manager.getSessionFile();
      expect(sessionFile).toBeDefined();
      expect(sanitizeSessionSecrets(sessionFile!)).toBe(0);

      const reopened = SessionManager.open(sessionFile!, scratch, scratch);
      expect(historicalCitationDigests(reopened)).toEqual([digest]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("recognizes a casual source question without an apostrophe", () => {
    expect(isCitationSourceRequest("wheres that from")).toBe(true);
  });

  it("still recognizes explicit attribution requests", () => {
    for (const request of [
      "cite your sources",
      "what's your source for that?",
      "any sources?",
      "can you add references",
      "where is this from",
    ]) {
      expect(isCitationSourceRequest(request)).toBe(true);
    }
  });

  it("does not treat non-attribution uses of source/reference as citation requests", () => {
    for (const request of [
      "which config file is the source of truth for the gateway port?",
      "where does the source code for the gateway live",
      "is this project open source",
      "point me at the reference implementation",
      "keep the source tree tidy",
    ]) {
      expect(isCitationSourceRequest(request)).toBe(false);
    }
  });

  it("leaves a bare URL alone when a non-attribution question mentions the source of truth", () => {
    const request = "which config file is the source of truth for the gateway port?";
    const response = "config.yaml decides it; the daemon then listens on http://localhost:4766";
    const guarded = enforceCitationEvidence({
      response,
      allowedUrlDigests: [],
      enabled: isCitationSourceRequest(request),
    });

    expect(guarded.corrected).toBe(false);
    expect(guarded.response).toBe(response);
  });
});
