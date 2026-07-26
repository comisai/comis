// SPDX-License-Identifier: Apache-2.0
/**
 * Durable skill-provenance store.
 *
 * Answers "which skills are installed, from where, at what content hash, at
 * what trust" — durably, so the answer survives a daemon restart. Recorded
 * AFTER a successful install (never at vet time: a record for a skill whose
 * write then failed would be a lie).
 *
 * This is the anchor the rest of the import work needs:
 *   - tamper detection on re-import (compare the recorded `contentHash`),
 *   - the bundled-MCP connect gate (it must know a tier after a restart, not
 *     only at the moment of install),
 *   - `comis skills info` / an obs view of community-skill exposure.
 *
 * **Location.** `${dataDir}/installed-skills.json`, mode `0o600` — a deliberate
 * clone of `bundle-install-state.ts`'s pattern, and deliberately NOT a lockfile
 * inside the skills tree: that tree is walked by discovery and watched by
 * `chokidar` (`skills.watchEnabled` defaults true), so a state file living
 * there would either be discovered as content or trigger reload churn on every
 * write.
 *
 * **Degradation.** A missing, unreadable, or malformed file reads as EMPTY
 * rather than throwing. Provenance is evidence, not a lock: an unknown record
 * must never block boot. Individual entries failing the shape check are dropped
 * while valid siblings survive, so one hand-edit cannot erase the whole file's
 * usefulness.
 *
 * **Content-free.** The record carries a source, a reference, a hash, counts,
 * and identities — never skill text, and never credentials (a `ref` is a
 * public locator). It is safe to read, log, and paste into a review.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { ok, err, type Result } from "@comis/shared";
import { safePath } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import type { SkillInstallSource, SkillTrustTier } from "@comis/skills";

/** State file name under the data dir. */
export const SKILL_PROVENANCE_FILE_NAME = "installed-skills.json";

/** The scopes a skill can be installed into (mirrors `SkillScopeSchema`). */
export type SkillProvenanceScope = "local" | "shared";

/** Registry-supplied metadata. Recorded as evidence; never a trust grant. */
export interface SkillProvenanceEvidence {
  readonly registryId?: string;
  readonly publisherHandle?: string;
  readonly publisherVerified?: boolean;
  readonly securityStatus?: string;
  readonly securityPassed?: boolean;
  readonly securityAuditUrl?: string;
  readonly checkedAt?: string;
  readonly registryDecision?: string;
}

/** Content-free bundled MCP entry withheld from persistence and connection. */
export interface PendingSkillMcpServer {
  readonly name: string;
  readonly transport: "stdio" | "sse" | "http";
  readonly reason: string;
}

/** One installed skill's provenance. */
export interface SkillProvenanceRecord {
  /** Which install path produced this skill. */
  readonly source: SkillInstallSource;
  /**
   * Public locator the skill came from — a URL, a `wellknown:` reference, or a
   * `registry:slug@version`. Absent for locally-authored skills, where there is
   * nothing to point at. NEVER carries credentials.
   */
  readonly ref?: string;
  /** Canonical `"sha256:…"` digest of the installed bundle. */
  readonly contentHash: string;
  /** ISO-8601 install time. */
  readonly importedAt: string;
  /** Who performed the install. */
  readonly importedBy: { readonly agentId: string; readonly userId?: string };
  /** Derived tier — never declared by the skill. */
  readonly trust: SkillTrustTier;
  /** The vetting verdict at install time. */
  readonly verdict: "safe" | "caution" | "dangerous";
  /** Finding counts at install time. Counts only — never the findings' text. */
  readonly findingCounts: { readonly critical: number; readonly warn: number };
  /** Optional registry metadata. Evidence for the operator, never a trust grant. */
  readonly evidence?: SkillProvenanceEvidence;
  /** Bundled MCP entries waiting for explicit operator activation. */
  readonly pendingMcpServers?: readonly PendingSkillMcpServer[];
  /**
   * Set when the record was synthesized by a one-time backfill of skills that
   * predate this store, rather than observed at install. Weaker provenance, and
   * surfaced as such.
   */
  readonly backfilled?: boolean;
}

/** The state file's shape: scoped key → record. */
export type SkillProvenanceState = Record<string, SkillProvenanceRecord>;

/** Tiers accepted from disk. A hand-edited file cannot invent a new one. */
const VALID_TIERS: ReadonlySet<string> = new Set([
  "first-party",
  "operator",
  "community",
  "agent-authored",
]);

/** Verdicts accepted from disk. */
const VALID_VERDICTS: ReadonlySet<string> = new Set(["safe", "caution", "dangerous"]);

/** Install sources accepted from durable state. */
const VALID_SOURCES: ReadonlySet<string> = new Set([
  "seed",
  "backfill",
  "create",
  "update",
  "upload",
  "github",
  "archive",
  "wellknown",
  "registry",
]);

function hasOptionalType(
  record: Record<string, unknown>,
  key: string,
  type: "string" | "boolean",
): boolean {
  return record[key] === undefined || typeof record[key] === type;
}

function isValidEvidence(value: unknown): value is SkillProvenanceEvidence {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (
    hasOptionalType(evidence, "registryId", "string") &&
    hasOptionalType(evidence, "publisherHandle", "string") &&
    hasOptionalType(evidence, "publisherVerified", "boolean") &&
    hasOptionalType(evidence, "securityStatus", "string") &&
    hasOptionalType(evidence, "securityPassed", "boolean") &&
    hasOptionalType(evidence, "securityAuditUrl", "string") &&
    hasOptionalType(evidence, "checkedAt", "string") &&
    hasOptionalType(evidence, "registryDecision", "string")
  );
}

/**
 * The store key for a skill.
 *
 * Scoped because `local` and `shared` are genuinely different installs — the
 * same name can exist in an agent's workspace and in the shared dir with
 * different bytes, different origins, and different trust.
 */
export function provenanceKey(scope: SkillProvenanceScope, name: string): string {
  return `${scope}:${name}`;
}

/** Shallow structural validation of one entry read from disk. */
function isValidRecord(value: unknown): value is SkillProvenanceRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (typeof r["source"] !== "string" || !VALID_SOURCES.has(r["source"])) return false;
  if (typeof r["contentHash"] !== "string") return false;
  if (typeof r["importedAt"] !== "string") return false;
  if (!hasOptionalType(r, "ref", "string") || !hasOptionalType(r, "backfilled", "boolean")) return false;
  if (typeof r["trust"] !== "string" || !VALID_TIERS.has(r["trust"])) return false;
  if (typeof r["verdict"] !== "string" || !VALID_VERDICTS.has(r["verdict"])) return false;
  const by = r["importedBy"];
  if (by === null || typeof by !== "object" || Array.isArray(by)) return false;
  const importedBy = by as Record<string, unknown>;
  if (typeof importedBy["agentId"] !== "string" || !hasOptionalType(importedBy, "userId", "string")) return false;
  const counts = r["findingCounts"];
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return false;
  const c = counts as Record<string, unknown>;
  if (typeof c["critical"] !== "number" || typeof c["warn"] !== "number") return false;
  if (!isValidEvidence(r["evidence"])) return false;
  const pending = r["pendingMcpServers"];
  if (pending === undefined) return true;
  if (!Array.isArray(pending)) return false;
  return pending.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const p = entry as Record<string, unknown>;
    return (
      typeof p["name"] === "string" &&
      (p["transport"] === "stdio" || p["transport"] === "sse" || p["transport"] === "http") &&
      typeof p["reason"] === "string"
    );
  });
}

/**
 * Read the provenance state.
 *
 * @param dataDir Absolute path to the Comis data directory (e.g. `~/.comis`).
 * @returns The state object; never undefined. Malformed input reads as `{}`,
 *   and an individually-malformed entry is dropped while its siblings survive.
 */
export function readSkillProvenance(dataDir: string): SkillProvenanceState {
  const filePath = safePath(dataDir, SKILL_PROVENANCE_FILE_NAME);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: SkillProvenanceState = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidRecord(value)) state[key] = value;
    }
    return state;
  } catch {
    // Malformed JSON or unreadable file ⇒ empty. Provenance is evidence, not a
    // lock; throwing here would let one corrupt file block boot.
    return {};
  }
}

/** Write the whole state file through the symlink-safe substrate (mode 0o600). */
function persist(dataDir: string, state: SkillProvenanceState): Result<void, Error> {
  const dirResult = ensureContainedDir({ dir: dataDir, mode: 0o700 });
  if (!dirResult.ok) {
    return err(
      new Error(`skill-provenance: failed to ensure dataDir ${dataDir}: ${dirResult.error.message}`),
    );
  }
  const filePath = safePath(dataDir, SKILL_PROVENANCE_FILE_NAME);
  const writeResult = writeRegularFile({ path: filePath, content: JSON.stringify(state, null, 2) });
  if (!writeResult.ok) {
    return err(new Error(`skill-provenance: failed to write ${filePath}: ${writeResult.error.message}`));
  }
  return ok(undefined);
}

/**
 * Record an installed skill's provenance, replacing any prior record for the
 * same scope+name (a re-install supersedes; it does not merge, so a stale hash
 * or tier can never survive underneath a fresh install).
 *
 * Callers SHOULD log on failure but MUST NOT fail the install: the skill is
 * already on disk, and the worst case of a missed record is that provenance
 * reads as unknown until the next install of that skill.
 */
export function recordSkillProvenance(
  dataDir: string,
  scope: SkillProvenanceScope,
  name: string,
  record: SkillProvenanceRecord,
): Result<void, Error> {
  const state = readSkillProvenance(dataDir);
  state[provenanceKey(scope, name)] = record;
  return persist(dataDir, state);
}

/** Drop a skill's record — called when the skill itself is deleted. */
export function forgetSkillProvenance(
  dataDir: string,
  scope: SkillProvenanceScope,
  name: string,
): Result<void, Error> {
  const state = readSkillProvenance(dataDir);
  const key = provenanceKey(scope, name);
  if (!(key in state)) return ok(undefined);
  delete state[key];
  return persist(dataDir, state);
}
