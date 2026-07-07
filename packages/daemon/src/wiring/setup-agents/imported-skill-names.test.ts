// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the per-agent imported-skill-name lookup.
 *
 * The lookup drives the `imported` trust-tier stamp during discovery
 * enrichment, so its scope/agent filtering is proven against a REAL provenance
 * store on disk (records written through the store's own lock-guarded writer),
 * never a mock: a shared record is visible to every agent, a local record only
 * to its owning agent, a missing store stamps nothing (fail-safe), and every
 * call re-reads the store so a just-completed import is reflected immediately.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeProvenanceRecord,
  withSkillImportLock,
  SKILL_IMPORT_COMMIT_LOCK,
  type ProvenanceRecord,
} from "@comis/skills";
import { buildImportedSkillNamesLookup } from "./imported-skill-names.js";

function record(overrides: Partial<ProvenanceRecord> & Pick<ProvenanceRecord, "name" | "scope" | "agentId">): ProvenanceRecord {
  return {
    source: "github",
    identifier: "https://github.com/owner/repo/tree/main/skills/x",
    contentHash: "deadbeef",
    scanVerdict: { clean: true, findingCount: 0 },
    files: ["SKILL.md"],
    importedAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    importedBy: overrides.agentId,
    ...overrides,
  };
}

async function write(dataDir: string, rec: ProvenanceRecord): Promise<void> {
  const result = await withSkillImportLock(SKILL_IMPORT_COMMIT_LOCK, () =>
    writeProvenanceRecord(dataDir, rec),
  );
  if (!result.ok) throw new Error(`fixture write failed: ${result.error.message}`);
}

describe("buildImportedSkillNamesLookup — scope/agent filtering against the real store", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "comis-imported-names-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a shared-scope record is visible to the owning agent AND every other agent", async () => {
    await write(dataDir, record({ name: "shared-skill", scope: "shared", agentId: "default" }));

    expect(buildImportedSkillNamesLookup(dataDir, "default")()).toEqual(new Set(["shared-skill"]));
    expect(buildImportedSkillNamesLookup(dataDir, "other-agent")()).toEqual(new Set(["shared-skill"]));
  });

  it("a local-scope record is visible ONLY to its owning agent", async () => {
    await write(dataDir, record({ name: "mine", scope: "local", agentId: "agent-a" }));
    await write(dataDir, record({ name: "theirs", scope: "local", agentId: "agent-b" }));

    expect(buildImportedSkillNamesLookup(dataDir, "agent-a")()).toEqual(new Set(["mine"]));
    expect(buildImportedSkillNamesLookup(dataDir, "agent-b")()).toEqual(new Set(["theirs"]));
    expect(buildImportedSkillNamesLookup(dataDir, "agent-c")()).toEqual(new Set());
  });

  it("mixed store: an agent sees the union of shared records and its own local records", async () => {
    await write(dataDir, record({ name: "shared-skill", scope: "shared", agentId: "default" }));
    await write(dataDir, record({ name: "mine", scope: "local", agentId: "agent-a" }));
    await write(dataDir, record({ name: "theirs", scope: "local", agentId: "agent-b" }));

    expect(buildImportedSkillNamesLookup(dataDir, "agent-a")()).toEqual(
      new Set(["shared-skill", "mine"]),
    );
  });

  it("a missing store yields an empty set (fail-safe: absence never stamps imported)", () => {
    expect(buildImportedSkillNamesLookup(dataDir, "default")()).toEqual(new Set());
  });

  it("reads fresh on every call: a record written after the lookup was built appears on the next call", async () => {
    const lookup = buildImportedSkillNamesLookup(dataDir, "agent-a");
    expect(lookup()).toEqual(new Set());

    await write(dataDir, record({ name: "late-arrival", scope: "local", agentId: "agent-a" }));
    expect(lookup()).toEqual(new Set(["late-arrival"]));
  });
});
