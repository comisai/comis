// SPDX-License-Identifier: Apache-2.0
/**
 * AST mutators for `comis config sync-tooling`.
 *
 * Pure helpers (no fs I/O, no Commander wiring). Given a parsed `Document`
 * (yaml@2.8.4) and a set of discovered artifacts, mutate the AST to either:
 *   - write the four-section skeleton when `tooling:` is absent, OR
 *   - append-only diff against an existing block (preserving operator edits).
 *
 * Wire boundary: the caller (Wave 3 `commands/config.ts` action) wraps
 * `parseDocument` + this module + `doc.toString()` in a `Result` shell;
 * AST-shape errors (e.g. `tooling:` is a scalar instead of a map) bubble
 * up as thrown and the action emits exit-code-3.
 *
 * Key invariants:
 *   - D-17: only manage `capabilityClusters`, `mcp.capabilityHints`,
 *     `skills.capabilityHints`, `installDetours`, `capabilityIndex`.
 *   - D-19: `capabilityClusters.clusters` is operator territory after init.
 *   - D-22: never overwrite an existing entry's description / replacesPackages.
 *   - Pitfall 4: pruning a Pair drops its commentBefore atomically.
 *   - Pitfall 5: commentBefore on `replacesPackages` requires a Scalar key.
 *   - Pitfall 6: MCP description is ALWAYS the literal "TODO" stub.
 *   - Pitfall 9: guard `doc.contents === null` before any setIn.
 *
 * @module
 */

import { isMap, isPair, isScalar, Scalar, type Document } from "yaml";
import type { DiscoveredArtifacts, DiscoveredMcp, DiscoveredSkill } from "./discover.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plan describing the diff that `applyToDocument` would execute (read-only). */
export interface MutationPlan {
  /** Hint keys to add under tooling.mcp.capabilityHints. */
  readonly mcpAdds: string[];
  /** Hint keys to remove from tooling.mcp.capabilityHints. */
  readonly mcpRemoves: string[];
  /** Hint keys to add under tooling.skills.capabilityHints. */
  readonly skillAdds: string[];
  /** Hint keys to remove from tooling.skills.capabilityHints. */
  readonly skillRemoves: string[];
  /** True iff `tooling:` was absent and a full skeleton must be written. */
  readonly needsSkeleton: boolean;
}

/** Counts returned by `applyToDocument` for the post-write summary line. */
export interface MutationCounts {
  readonly mcpAdded: number;
  readonly mcpRemoved: number;
  readonly skillAdded: number;
  readonly skillRemoved: number;
}

// ---------------------------------------------------------------------------
// Constants — D-07 default cluster IDs
// ---------------------------------------------------------------------------

const MCP_DEFAULT_CLUSTER = "external-integrations";
const SKILL_DEFAULT_CLUSTER = "prompt-skills";
const REPLACES_PACKAGES_COMMENT = " TODO: list npm/pip packages this MCP replaces";

// ---------------------------------------------------------------------------
// Skeleton (init-when-absent)
// ---------------------------------------------------------------------------

/**
 * Build the four-section skeleton (D-18, D-19) on a Document with no tooling: key.
 *
 * Sections written:
 *   - tooling.capabilityClusters.clusters: {}
 *   - tooling.mcp.capabilityHints: { ...mcps }
 *   - tooling.skills.capabilityHints: { ...skills }
 *   - tooling.installDetours.mode: "advise"
 *   - tooling.capabilityIndex.enabled: true
 */
export function buildSkeleton(doc: Document, artifacts: DiscoveredArtifacts): void {
  ensureRootMap(doc);

  // capabilityClusters always written empty (D-19) — operator's territory.
  doc.setIn(["tooling", "capabilityClusters", "clusters"], doc.createNode({}));

  // Always create both capabilityHints maps as empty objects FIRST (D-18 — empty
  // map, not missing key). Then add each discovered hint via setIn so its key
  // is wrapped in a Scalar we can attach commentBefore to.
  doc.setIn(["tooling", "mcp", "capabilityHints"], doc.createNode({}));
  doc.setIn(["tooling", "skills", "capabilityHints"], doc.createNode({}));

  for (const m of artifacts.mcps) {
    addMcpHint(doc, m);
  }
  for (const s of artifacts.skills) {
    addSkillHint(doc, s);
  }

  // installDetours + capabilityIndex defaults (D-18).
  doc.setIn(["tooling", "installDetours", "mode"], "advise");
  doc.setIn(["tooling", "capabilityIndex", "enabled"], true);
}

// ---------------------------------------------------------------------------
// Plan computation (read-only against an existing doc)
// ---------------------------------------------------------------------------

/**
 * Compute additions and removals against the existing AST without mutating it.
 *
 * `needsSkeleton` is true iff `tooling:` is absent — the caller picks
 * `buildSkeleton` over the incremental path.
 */
export function computeMutationPlan(
  doc: Document,
  artifacts: DiscoveredArtifacts,
): MutationPlan {
  const needsSkeleton = doc.hasIn(["tooling"]) === false;

  const existingMcpKeys = readHintKeys(doc, ["tooling", "mcp", "capabilityHints"]);
  const existingSkillKeys = readHintKeys(doc, ["tooling", "skills", "capabilityHints"]);

  const discoveredMcpNames = new Set(artifacts.mcps.map((m) => m.name));
  const discoveredSkillNames = new Set(artifacts.skills.map((s) => s.name));

  const existingMcpSet = new Set(existingMcpKeys);
  const existingSkillSet = new Set(existingSkillKeys);

  const mcpAdds = artifacts.mcps
    .filter((m) => !existingMcpSet.has(m.name))
    .map((m) => m.name);
  const mcpRemoves = existingMcpKeys.filter((k) => !discoveredMcpNames.has(k));
  const skillAdds = artifacts.skills
    .filter((s) => !existingSkillSet.has(s.name))
    .map((s) => s.name);
  const skillRemoves = existingSkillKeys.filter((k) => !discoveredSkillNames.has(k));

  return { mcpAdds, mcpRemoves, skillAdds, skillRemoves, needsSkeleton };
}

// ---------------------------------------------------------------------------
// Apply — orchestrator (skeleton, incremental, or overwrite)
// ---------------------------------------------------------------------------

/**
 * Apply additions + prunes to the doc. Returns counts for the post-write summary.
 *
 * Three branches:
 *   - `overwrite: true` — delete + rebuild managed sections except
 *     `capabilityClusters` (D-19 operator-only territory).
 *   - `tooling:` is absent — `buildSkeleton`.
 *   - else (incremental) — diff via `computeMutationPlan` and apply.
 */
export function applyToDocument(
  doc: Document,
  artifacts: DiscoveredArtifacts,
  options: { overwrite: boolean },
): MutationCounts {
  if (options.overwrite) {
    return applyOverwrite(doc, artifacts);
  }

  const plan = computeMutationPlan(doc, artifacts);
  if (plan.needsSkeleton) {
    buildSkeleton(doc, artifacts);
    return {
      mcpAdded: artifacts.mcps.length,
      mcpRemoved: 0,
      skillAdded: artifacts.skills.length,
      skillRemoved: 0,
    };
  }

  return applyIncremental(doc, artifacts, plan);
}

// ---------------------------------------------------------------------------
// Internal — overwrite branch
// ---------------------------------------------------------------------------

function applyOverwrite(
  doc: Document,
  artifacts: DiscoveredArtifacts,
): MutationCounts {
  ensureRootMap(doc);

  // PRESERVE tooling.capabilityClusters byte-for-byte (D-19) by NOT touching it.
  // DELETE the four other managed sections (guarded — yaml@2.8.4 deleteIn
  // throws when an intermediate path doesn't exist), then re-emit them.
  if (doc.hasIn(["tooling", "mcp", "capabilityHints"])) {
    doc.deleteIn(["tooling", "mcp", "capabilityHints"]);
  }
  if (doc.hasIn(["tooling", "skills", "capabilityHints"])) {
    doc.deleteIn(["tooling", "skills", "capabilityHints"]);
  }
  if (doc.hasIn(["tooling", "installDetours"])) {
    doc.deleteIn(["tooling", "installDetours"]);
  }
  if (doc.hasIn(["tooling", "capabilityIndex"])) {
    doc.deleteIn(["tooling", "capabilityIndex"]);
  }

  // Re-create empty capabilityHints maps (D-18 — present, empty), then add hints.
  doc.setIn(["tooling", "mcp", "capabilityHints"], doc.createNode({}));
  doc.setIn(["tooling", "skills", "capabilityHints"], doc.createNode({}));
  for (const m of artifacts.mcps) addMcpHint(doc, m);
  for (const s of artifacts.skills) addSkillHint(doc, s);

  doc.setIn(["tooling", "installDetours", "mode"], "advise");
  doc.setIn(["tooling", "capabilityIndex", "enabled"], true);

  return {
    mcpAdded: artifacts.mcps.length,
    mcpRemoved: 0,
    skillAdded: artifacts.skills.length,
    skillRemoved: 0,
  };
}

// ---------------------------------------------------------------------------
// Internal — incremental branch (D-22 preserves operator edits on existing entries)
// ---------------------------------------------------------------------------

function applyIncremental(
  doc: Document,
  artifacts: DiscoveredArtifacts,
  plan: MutationPlan,
): MutationCounts {
  // Adds: only for keys NOT already present. For these, write a fresh skeleton
  // entry. Existing entries are NEVER touched (D-22).
  const mcpByName = new Map(artifacts.mcps.map((m) => [m.name, m] as const));
  const skillByName = new Map(artifacts.skills.map((s) => [s.name, s] as const));

  // Only ensure the parent map exists when we actually have something to add
  // — otherwise we'd splat an empty `tooling.skills.capabilityHints: {}` into
  // a config that has no `tooling.skills` block, breaking REQ-7 byte-identity
  // for unchanged configs. Use createNode so the value is a YAMLMap, not a
  // bare JS object (yaml's setIn can't traverse into a non-Collection value).
  if (plan.mcpAdds.length > 0 && !doc.hasIn(["tooling", "mcp", "capabilityHints"])) {
    doc.setIn(["tooling", "mcp", "capabilityHints"], doc.createNode({}));
  }
  if (plan.skillAdds.length > 0 && !doc.hasIn(["tooling", "skills", "capabilityHints"])) {
    doc.setIn(["tooling", "skills", "capabilityHints"], doc.createNode({}));
  }

  for (const name of plan.mcpAdds) {
    const m = mcpByName.get(name);
    if (m) addMcpHint(doc, m);
  }
  for (const name of plan.skillAdds) {
    const s = skillByName.get(name);
    if (s) addSkillHint(doc, s);
  }

  // Removes: deleteIn drops the Pair AND its commentBefore (Pitfall 4 — semantic).
  for (const name of plan.mcpRemoves) {
    doc.deleteIn(["tooling", "mcp", "capabilityHints", name]);
  }
  for (const name of plan.skillRemoves) {
    doc.deleteIn(["tooling", "skills", "capabilityHints", name]);
  }

  return {
    mcpAdded: plan.mcpAdds.length,
    mcpRemoved: plan.mcpRemoves.length,
    skillAdded: plan.skillAdds.length,
    skillRemoved: plan.skillRemoves.length,
  };
}

// ---------------------------------------------------------------------------
// Internal — single-entry add (used by skeleton + incremental + overwrite)
// ---------------------------------------------------------------------------

function addMcpHint(doc: Document, mcp: DiscoveredMcp): void {
  const basePath = ["tooling", "mcp", "capabilityHints", mcp.name];
  // D-07 default cluster + Pitfall 6 stub description + D-08 empty replacesPackages.
  doc.setIn([...basePath, "cluster"], MCP_DEFAULT_CLUSTER);
  doc.setIn([...basePath, "description"], "TODO");
  doc.setIn([...basePath, "replacesPackages"], []);
  attachReplacesPackagesComment(doc, basePath);
}

function addSkillHint(doc: Document, skill: DiscoveredSkill): void {
  const basePath = ["tooling", "skills", "capabilityHints", skill.name];
  // D-07 / D-09: explicit cluster wins; otherwise the prompt-skills default.
  // Pitfall 7: description fallback to TODO when discover yielded undefined.
  const cluster = skill.cluster ?? SKILL_DEFAULT_CLUSTER;
  const description = skill.description ?? "TODO";
  doc.setIn([...basePath, "cluster"], cluster);
  doc.setIn([...basePath, "description"], description);
  doc.setIn([...basePath, "replacesPackages"], []);
  attachReplacesPackagesComment(doc, basePath);
}

/**
 * Attach the `# TODO: list npm/pip packages this MCP replaces` comment to the
 * `replacesPackages` key Pair (Pitfall 5). Requires the key to be a Scalar
 * node — yaml@2.8.4 represents map keys as raw strings by default after
 * `setIn(..., [])`, so we replace the raw string key with `new Scalar(name)`
 * before assigning `commentBefore`.
 */
function attachReplacesPackagesComment(doc: Document, basePath: string[]): void {
  const innerMap = doc.getIn(basePath, true);
  if (!isMap(innerMap)) return;
  for (const p of innerMap.items) {
    if (!isPair(p)) continue;
    const keyVal = isScalar(p.key) ? p.key.value : p.key;
    if (keyVal !== "replacesPackages") continue;
    if (!isScalar(p.key)) {
      // Rewrap the raw string key as a Scalar so commentBefore renders.
      // The Pair generic is unconstrained at runtime; the cast is safe.
      (p as { key: unknown }).key = new Scalar(keyVal);
    }
    if (isScalar(p.key)) {
      p.key.commentBefore = REPLACES_PACKAGES_COMMENT;
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Internal — read existing capabilityHints keys
// ---------------------------------------------------------------------------

function readHintKeys(doc: Document, hintMapPath: string[]): string[] {
  if (!doc.hasIn(hintMapPath)) return [];
  const node = doc.getIn(hintMapPath, true);
  if (!isMap(node)) return [];
  const keys: string[] = [];
  for (const p of node.items) {
    if (!isPair(p)) continue;
    const k = isScalar(p.key) ? p.key.value : p.key;
    if (typeof k === "string") keys.push(k);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Internal — Pitfall 9 guard
// ---------------------------------------------------------------------------

function ensureRootMap(doc: Document): void {
  if (doc.contents === null || doc.contents === undefined) {
    // createNode of {} returns a YAMLMap. The Document<Node> generic is wider
    // than YAMLMap so the cast is required at the type level.
    (doc as { contents: unknown }).contents = doc.createNode({});
  }
}
