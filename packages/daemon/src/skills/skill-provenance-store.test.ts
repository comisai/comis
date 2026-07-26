// SPDX-License-Identifier: Apache-2.0
/**
 * Spec for the durable skill-provenance store.
 *
 * Pre-patch state: `./skill-provenance-store.js` does not exist. These tests
 * fail at import resolution, the correct tests-first state for a new module.
 *
 * The store answers "which skills are installed, from where, at what content
 * hash, at what trust" — durably, so the answer survives a daemon restart. It
 * is the anchor everything downstream needs: tamper detection on re-import, the
 * bundled-MCP connect gate (which must know a tier after a restart, not just at
 * install time), and `comis skills info`.
 *
 * Deliberately mirrors `bundle-install-state.ts`: a `0o600` daemon-private JSON
 * file under the data dir, NOT a lockfile inside the `chokidar`-watched skills
 * tree, and a malformed file degrades to empty rather than blocking boot.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readSkillProvenance,
  recordSkillProvenance,
  forgetSkillProvenance,
  provenanceKey,
  SKILL_PROVENANCE_FILE_NAME,
  type SkillProvenanceRecord,
} from "./skill-provenance-store.js";
import { recordSeededSkillProvenance } from "./skill-provenance-backfill.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(tmpdir(), `skill-prov-${randomUUID().slice(0, 8)}-`));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function record(overrides: Partial<SkillProvenanceRecord> = {}): SkillProvenanceRecord {
  return {
    source: "github",
    ref: "https://github.com/owner/repo/tree/main/skills/my-skill",
    contentHash: "sha256:" + "a".repeat(64),
    importedAt: "2026-07-26T10:00:00.000Z",
    importedBy: { agentId: "agent-a", userId: "operator" },
    trust: "community",
    verdict: "safe",
    findingCounts: { critical: 0, warn: 0 },
    ...overrides,
  };
}

function statePath(): string {
  return join(dataDir, SKILL_PROVENANCE_FILE_NAME);
}

describe("provenanceKey", () => {
  it("composes the key from scope and name so the two scopes never collide", () => {
    expect(provenanceKey("local", "my-skill")).toBe("local:my-skill");
    expect(provenanceKey("shared", "my-skill")).toBe("shared:my-skill");
    expect(provenanceKey("local", "my-skill")).not.toBe(provenanceKey("shared", "my-skill"));
  });
});

describe("readSkillProvenance — absent and malformed files", () => {
  it("returns an empty state when the file does not exist yet", () => {
    expect(readSkillProvenance(dataDir)).toEqual({});
  });

  it("returns an empty state on malformed JSON rather than throwing", () => {
    // A corrupt state file must not block boot; the worst case is that
    // provenance appears unknown and the operator re-imports.
    fs.writeFileSync(statePath(), "{ not json", { mode: 0o600 });
    expect(readSkillProvenance(dataDir)).toEqual({});
  });

  it("returns an empty state when the top level is an array, not an object", () => {
    fs.writeFileSync(statePath(), "[1,2,3]", { mode: 0o600 });
    expect(readSkillProvenance(dataDir)).toEqual({});
  });

  it("drops individual entries that fail the shape check but keeps valid siblings", () => {
    const good = record();
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ "local:good": good, "local:bad": "not-an-object", "local:alsobad": null }),
      { mode: 0o600 },
    );
    const state = readSkillProvenance(dataDir);
    expect(Object.keys(state)).toEqual(["local:good"]);
    expect(state["local:good"]).toMatchObject({ source: "github", trust: "community" });
  });

  it("drops an entry whose trust tier is not a known value", () => {
    // A hand-edited file must not be able to invent a tier the policy layer
    // does not understand.
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ "local:x": { ...record(), trust: "superuser" } }),
      { mode: 0o600 },
    );
    expect(readSkillProvenance(dataDir)).toEqual({});
  });

  it("drops entries with unknown sources or malformed registry evidence", () => {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        "local:good": record(),
        "local:unknown-source": { ...record(), source: "unreviewed" },
        "local:bad-evidence": {
          ...record({ source: "registry" }),
          evidence: { registryId: 42, securityPassed: "yes" },
        },
      }),
      { mode: 0o600 },
    );

    expect(Object.keys(readSkillProvenance(dataDir))).toEqual(["local:good"]);
  });
});

describe("recordSkillProvenance", () => {
  it("records freshly seeded bundle bytes as shared first-party provenance", () => {
    const skillDir = join(dataDir, "skills", "bundled-example");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: bundled-example\ndescription: Bundled example\ntype: prompt\n---\n\nUse this skill.\n",
    );

    const result = recordSeededSkillProvenance({
      dataDir,
      name: "bundled-example",
      agentId: "default",
      skillDir,
    });

    expect(result.ok).toBe(true);
    expect(readSkillProvenance(dataDir)["shared:bundled-example"]).toMatchObject({
      source: "seed",
      trust: "first-party",
      verdict: "safe",
      importedBy: { agentId: "default" },
      backfilled: false,
    });
  });

  it("writes the record and reads it back under the scoped key", () => {
    const result = recordSkillProvenance(dataDir, "local", "my-skill", record());
    expect(result.ok).toBe(true);

    const state = readSkillProvenance(dataDir);
    expect(state["local:my-skill"]).toEqual(record());
  });

  it("creates the state file with mode 0o600 (daemon-private)", () => {
    recordSkillProvenance(dataDir, "local", "my-skill", record());
    expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
  });

  it("keeps the same skill's two scopes as independent records", () => {
    recordSkillProvenance(dataDir, "local", "my-skill", record({ trust: "agent-authored" }));
    recordSkillProvenance(dataDir, "shared", "my-skill", record({ trust: "operator" }));

    const state = readSkillProvenance(dataDir);
    expect(state["local:my-skill"]?.trust).toBe("agent-authored");
    expect(state["shared:my-skill"]?.trust).toBe("operator");
  });

  it("replaces a prior record for the same key rather than merging into it", () => {
    recordSkillProvenance(dataDir, "local", "my-skill", record({ verdict: "caution" }));
    recordSkillProvenance(
      dataDir,
      "local",
      "my-skill",
      record({ verdict: "safe", contentHash: "sha256:" + "b".repeat(64) }),
    );

    const stored = readSkillProvenance(dataDir)["local:my-skill"];
    expect(stored?.verdict).toBe("safe");
    expect(stored?.contentHash).toBe("sha256:" + "b".repeat(64));
  });

  it("preserves unrelated skills when recording a new one", () => {
    recordSkillProvenance(dataDir, "local", "first", record());
    recordSkillProvenance(dataDir, "local", "second", record({ source: "upload" }));

    const state = readSkillProvenance(dataDir);
    expect(Object.keys(state).sort()).toEqual(["local:first", "local:second"]);
  });

  it("creates the data dir when it does not exist yet", () => {
    const nested = join(dataDir, "fresh");
    expect(recordSkillProvenance(nested, "local", "my-skill", record()).ok).toBe(true);
    expect(fs.existsSync(join(nested, SKILL_PROVENANCE_FILE_NAME))).toBe(true);
  });

  it("stores an optional registry evidence block verbatim when present", () => {
    const withEvidence = record({
      source: "registry",
      ref: "registry:acme/my-skill@1.2.0",
      evidence: { publisherHandle: "acme", securityPassed: true, checkedAt: "2026-07-26T09:00:00.000Z" },
    });
    recordSkillProvenance(dataDir, "local", "my-skill", withEvidence);
    expect(readSkillProvenance(dataDir)["local:my-skill"]?.evidence).toEqual({
      publisherHandle: "acme",
      securityPassed: true,
      checkedAt: "2026-07-26T09:00:00.000Z",
    });
  });

  it("omits ref for a locally-authored skill instead of inventing one", () => {
    const local = record({ source: "create", trust: "operator" });
    delete (local as { ref?: string }).ref;
    recordSkillProvenance(dataDir, "local", "hand-written", local);

    const stored = readSkillProvenance(dataDir)["local:hand-written"];
    expect(stored?.source).toBe("create");
    expect(stored?.ref).toBeUndefined();
  });
});

describe("recordSkillProvenance — content-free", () => {
  it("never stores skill body text, only counts and a hash", () => {
    recordSkillProvenance(dataDir, "local", "my-skill", record({ findingCounts: { critical: 1, warn: 3 } }));
    const raw = fs.readFileSync(statePath(), "utf-8");

    // The record's whole point is to be safe to read, log, and paste into a
    // review — so it carries a hash and counts, never the scanned text.
    expect(raw).toContain('"critical": 1');
    expect(raw).toContain("sha256:");
    expect(raw).not.toMatch(/matchedText|body|content"\s*:\s*"[^"]{40}/);
  });
});

describe("forgetSkillProvenance", () => {
  it("removes the record for a deleted skill", () => {
    recordSkillProvenance(dataDir, "local", "my-skill", record());
    expect(forgetSkillProvenance(dataDir, "local", "my-skill").ok).toBe(true);
    expect(readSkillProvenance(dataDir)["local:my-skill"]).toBeUndefined();
  });

  it("leaves the other scope's record intact", () => {
    recordSkillProvenance(dataDir, "local", "my-skill", record());
    recordSkillProvenance(dataDir, "shared", "my-skill", record());

    forgetSkillProvenance(dataDir, "local", "my-skill");

    const state = readSkillProvenance(dataDir);
    expect(state["local:my-skill"]).toBeUndefined();
    expect(state["shared:my-skill"]).toBeDefined();
  });

  it("is a no-op for a key that was never recorded", () => {
    expect(forgetSkillProvenance(dataDir, "local", "never-existed").ok).toBe(true);
  });
});
