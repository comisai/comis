// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the provenance-summary enrichment the skills-list surface
 * uses. A listed skill that has an import record gains a content-free summary
 * (acquisition channel + hash prefix + import timestamp, plus — for a
 * registry-sourced import — the recorded registry origin); a skill with no
 * record is returned unchanged.
 *
 * Drives the REAL provenance store against a temp data dir (no store mock) so
 * the summary reflects what actually round-trips to disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeProvenanceRecord, type ProvenanceRecord } from "@comis/skills";
import { enrichWithProvenanceSummary } from "./skill-import-runner.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), `skill-import-runner-${randomUUID().slice(0, 8)}-`));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    name: "demo-skill",
    scope: "local",
    agentId: "alice",
    source: "archive",
    identifier: "https://example.invalid/demo.skill",
    contentHash: "0".repeat(64),
    scanVerdict: { clean: true, findingCount: 0 },
    files: ["SKILL.md"],
    importedAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
    importedBy: "alice",
    ...overrides,
  };
}

describe("enrichWithProvenanceSummary — registry origin on the list summary", () => {
  it("surfaces provenanceSummary.registry for a record that records one", async () => {
    await writeProvenanceRecord(
      dataDir,
      makeRecord({ name: "reg-skill", source: "wellknown", registry: "https://reg.example" }),
    );
    const [entry] = enrichWithProvenanceSummary([{ name: "reg-skill" }], dataDir, "alice");
    expect(entry?.provenanceSummary?.registry).toBe("https://reg.example");
    expect(entry?.provenanceSummary?.source).toBe("wellknown");
  });

  it("omits provenanceSummary.registry for a record that has none (archive/github)", async () => {
    await writeProvenanceRecord(dataDir, makeRecord({ name: "plain-skill", source: "archive" }));
    const [entry] = enrichWithProvenanceSummary([{ name: "plain-skill" }], dataDir, "alice");
    expect(entry?.provenanceSummary).toBeDefined();
    expect(entry?.provenanceSummary?.registry).toBeUndefined();
  });

  it("returns a skill with no import record unchanged (no provenanceSummary attached)", () => {
    const [entry] = enrichWithProvenanceSummary([{ name: "unrecorded" }], dataDir, "alice");
    expect(entry?.provenanceSummary).toBeUndefined();
  });
});
