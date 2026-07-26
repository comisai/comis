// SPDX-License-Identifier: Apache-2.0
/**
 * One-time provenance backfill for skills discovered without a durable record.
 *
 * Existing installations are treated as operator-approved so enabling the
 * bundled-MCP trust gate does not disconnect a working deployment merely
 * because it predates `installed-skills.json`. The record is marked
 * `backfilled: true`, and the current on-disk bundle is still fully vetted so
 * its hash, verdict, and finding counts are honest.
 *
 * @module
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { safePath, systemDateFrom, systemNowMs } from "@comis/core";
import { ok, tryCatch, type Result } from "@comis/shared";
import { vetSkillBundle, type SkillBundleFile } from "@comis/skills";
import {
  recordSkillProvenance,
  type SkillProvenanceRecord,
  type SkillProvenanceScope,
} from "./skill-provenance-store.js";

/** Inputs for one missing provenance entry. */
export interface BackfillSkillProvenanceArgs {
  readonly dataDir: string;
  readonly scope: SkillProvenanceScope;
  readonly name: string;
  readonly agentId: string;
  readonly skillDir: string;
  readonly manifestPath: string;
}

/** Inputs for provenance recorded immediately after a bundled skill is seeded. */
export interface RecordSeededSkillProvenanceArgs {
  readonly dataDir: string;
  readonly name: string;
  readonly agentId: string;
  readonly skillDir: string;
}

/** Recursively materialize the real skill directory into the vetting file-map shape. */
function collectDirectoryFiles(root: string): Result<SkillBundleFile[], Error> {
  return tryCatch(() => {
    const files: SkillBundleFile[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        const absolute = safePath(root, ...relative.split("/"));
        if (entry.isDirectory()) {
          walk(absolute, relative);
          continue;
        }
        const stat = lstatSync(absolute);
        if (entry.isSymbolicLink()) {
          files.push({
            path: relative,
            content: readlinkSync(absolute),
            mode: stat.mode,
            type: "symlink",
          });
          continue;
        }
        if (entry.isFile()) {
          files.push({
            path: relative,
            content: readFileSync(absolute),
            mode: stat.mode,
            type: "file",
          });
        }
      }
    };
    walk(root, "");
    return files;
  });
}

/** Collect a discovered folder skill or normalize a root Markdown skill to SKILL.md. */
export function collectSkillBundleFiles(
  skillDir: string,
  manifestPath: string,
): Result<SkillBundleFile[], Error> {
  const canonicalManifest = safePath(skillDir, "SKILL.md");
  if (manifestPath === canonicalManifest) return collectDirectoryFiles(skillDir);
  return tryCatch(() => [{ path: "SKILL.md", content: readFileSync(manifestPath), type: "file" }]);
}

/** Build and persist one operator-tier backfill record. */
export function backfillSkillProvenance(
  args: BackfillSkillProvenanceArgs,
): Result<SkillProvenanceRecord, Error> {
  const files = collectSkillBundleFiles(args.skillDir, args.manifestPath);
  if (!files.ok) return files;

  const vetted = vetSkillBundle({ files: files.value, trust: "operator" });
  const critical = vetted.findings.filter((finding) => finding.severity === "CRITICAL").length;
  const record: SkillProvenanceRecord = {
    source: "backfill",
    contentHash: vetted.contentHash,
    importedAt: systemDateFrom(systemNowMs()).toISOString(),
    importedBy: { agentId: args.agentId },
    trust: "operator",
    verdict: vetted.verdict,
    findingCounts: { critical, warn: vetted.findings.length - critical },
    backfilled: true,
  };
  const written = recordSkillProvenance(args.dataDir, args.scope, args.name, record);
  if (!written.ok) return written;
  return ok(record);
}

/** Record a freshly seeded bundle as first-party from its exact installed bytes. */
export function recordSeededSkillProvenance(
  args: RecordSeededSkillProvenanceArgs,
): Result<SkillProvenanceRecord, Error> {
  const manifestPath = safePath(args.skillDir, "SKILL.md");
  const files = collectSkillBundleFiles(args.skillDir, manifestPath);
  if (!files.ok) return files;

  const vetted = vetSkillBundle({ files: files.value, trust: "first-party" });
  const critical = vetted.findings.filter((finding) => finding.severity === "CRITICAL").length;
  const record: SkillProvenanceRecord = {
    source: "seed",
    contentHash: vetted.contentHash,
    importedAt: systemDateFrom(systemNowMs()).toISOString(),
    importedBy: { agentId: args.agentId },
    trust: "first-party",
    verdict: vetted.verdict,
    findingCounts: { critical, warn: vetted.findings.length - critical },
    backfilled: false,
  };
  const written = recordSkillProvenance(args.dataDir, "shared", args.name, record);
  if (!written.ok) return written;
  return ok(record);
}
