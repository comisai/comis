// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  parseMemoryExportEnvelope,
  MemoryExportEnvelopeSchema,
  type MemoryExportEntry,
} from "./memory-export-envelope.js";

const VALID_ENTRY: MemoryExportEntry = {
  id: "e1111111-0000-0000-0000-000000000001",
  content: "test memory content",
  trust_level: "learned",
  memory_type: "semantic",
  tags: ["tag1"],
  source_who: "user",
  source_channel: null,
  source_session_key: null,
  created_at: 1748000000000,
  occurred_at: null,
  proof_count: null,
  source_ids: null,
  confidence: null,
  observation_kind: null,
  pattern_type: null,
};

const VALID_ENVELOPE = {
  schemaVersion: "comis-memory-export-v1",
  exportedAt: 1748000000000,
  scope: { tenantId: "default", agentId: "agent1" },
  entryCount: 1,
  entries: [VALID_ENTRY],
};

describe("parseMemoryExportEnvelope — fail-closed version enforcement", () => {
  it("returns err when schemaVersion is an unrecognized version string", () => {
    const result = parseMemoryExportEnvelope({ ...VALID_ENVELOPE, schemaVersion: "comis-memory-export-v2" });
    expect(result.ok).toBe(false);
  });

  it("returns err when schemaVersion is a beta/preview variant", () => {
    const result = parseMemoryExportEnvelope({ ...VALID_ENVELOPE, schemaVersion: "comis-memory-export-v1-beta" });
    expect(result.ok).toBe(false);
  });

  it("returns err when schemaVersion field is missing entirely", () => {
    const { schemaVersion: _omit, ...noVersion } = VALID_ENVELOPE;
    const result = parseMemoryExportEnvelope(noVersion);
    expect(result.ok).toBe(false);
  });

  it("returns ok with parsed envelope for a valid comis-memory-export-v1 payload", () => {
    const result = parseMemoryExportEnvelope(VALID_ENVELOPE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe("comis-memory-export-v1");
      expect(result.value.entries).toHaveLength(1);
    }
  });

  it("returns err for an extra unknown top-level field (strictObject enforcement)", () => {
    const result = parseMemoryExportEnvelope({ ...VALID_ENVELOPE, unknownField: "oops" });
    expect(result.ok).toBe(false);
  });
});

describe("MemoryExportEnvelopeSchema — DoS cap enforcement", () => {
  it("rejects entries array larger than 10000 items", () => {
    const bigEntries = Array.from({ length: 10001 }, (_, i) => ({ ...VALID_ENTRY, id: `id-${i}` }));
    const result = MemoryExportEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, entries: bigEntries, entryCount: 10001 });
    expect(result.success).toBe(false);
  });

  it("accepts entries array with exactly 10000 items", () => {
    const maxEntries = Array.from({ length: 10000 }, (_, i) => ({ ...VALID_ENTRY, id: `id-${i}` }));
    const result = MemoryExportEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, entries: maxEntries, entryCount: 10000 });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// entryCount must equal entries.length — a mismatch is a data-integrity signal
// (crafted envelope) and parseMemoryExportEnvelope must return err, not ok.
// ---------------------------------------------------------------------------

describe("parseMemoryExportEnvelope — entryCount cross-validation", () => {
  it("returns err when entryCount is greater than entries.length", () => {
    const result = parseMemoryExportEnvelope({ ...VALID_ENVELOPE, entryCount: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/entryCount|mismatch|entries/i);
    }
  });

  it("returns err when entryCount is less than entries.length", () => {
    const multiEntryEnvelope = {
      ...VALID_ENVELOPE,
      entryCount: 0,
      entries: [VALID_ENTRY],
    };
    const result = parseMemoryExportEnvelope(multiEntryEnvelope);
    expect(result.ok).toBe(false);
  });

  it("returns ok when entryCount exactly matches entries.length", () => {
    // This should still pass — the happy path must not regress.
    const result = parseMemoryExportEnvelope(VALID_ENVELOPE);
    expect(result.ok).toBe(true);
  });

  it("returns ok for an empty entries array when entryCount is 0", () => {
    const emptyEnvelope = {
      ...VALID_ENVELOPE,
      entryCount: 0,
      entries: [],
    };
    const result = parseMemoryExportEnvelope(emptyEnvelope);
    expect(result.ok).toBe(true);
  });
});
