// SPDX-License-Identifier: Apache-2.0
/**
 * Pure bundle resolver.
 *
 * Computes the next `integrations.mcp.servers` array + connect queue +
 * override archive given a skill's bundled `mcpServers` declaration and
 * the current user config. NO side effects: never writes files, never
 * spawns transports, never logs secret values (only structured field
 * names). The caller (the skill-install hook OR the boot orchestrator)
 * commits the Result via persistMcpServers + manager.connect.
 *
 * Atomic two-phase invariant: every safety gate runs over EVERY bundle
 * entry BEFORE any caller-side commit. ANY gate failure returns err and
 * the caller MUST treat as zero-write zero-connect.
 *
 * The resolver is the transactional wrapper that the install hook and
 * the boot orchestrator commit-or-abort on.
 *
 * Idempotence: identical input ⇒ identical output (sort by name
 * guarantees byte-equal JSON round-trip). Calling the resolver on its
 * own output is a fixed point.
 *
 * Cycle-safety note: imports `looksLikePlaintextSecret` via the LEAF module
 * path (`../api/mcp-plaintext-secret.js`) rather than the `@comis/daemon`
 * barrel — this file lives INSIDE `packages/daemon/src/`, so a barrel
 * import would close a self-cycle through `packages/daemon/src/index.ts`.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import type { McpServerEntry } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { looksLikePlaintextSecret } from "../api/mcp-plaintext-secret.js";
import {
  osvMalwareCheck,
  extractMcpPackageName,
  DEFAULT_OSV_CACHE_DIR,
} from "@comis/skills";
import type { BundleError, ResolvedBundle } from "./bundle-types.js";
import {
  hasBundleRecord,
  type InstalledBundleState,
} from "./bundle-install-state.js";

export type { BundleError, ResolvedBundle };

/**
 * Resolver input.
 *
 * The caller assembles this from:
 *   - `skillId` ← skill being installed (becomes _bundleSource on entries).
 *   - `manifestMcpServers` ← post-preprocess array from
 *     SkillManifestSchema.parse.
 *   - `currentServers` ← container.config.integrations.mcp.servers
 *     (or disk YAML on the boot path).
 *   - `force` ← `--force` flag from RPC params or `false` for boot.
 *   - `osvCheckEnabled` / `osvCacheTtlMs` ← forwarded from
 *     container.config.integrations.mcp root.
 *   - `logger` ← Pino logger (canonical fields; never logs secret values).
 */
export interface ResolveBundleInput {
  /** The skill installing the bundle (becomes _bundleSource on new entries). */
  readonly skillId: string;
  /** Post-preprocess array of bundle entries from SkillManifestSchema.parse. */
  readonly manifestMcpServers: readonly McpServerEntry[];
  /** Current integrations.mcp.servers from container.config (or disk). */
  readonly currentServers: readonly McpServerEntry[];
  /** When true, name-collision archives the existing entry rather than rejecting. */
  readonly force: boolean;
  /** Forwarded from container.config.integrations.mcp.osvCheckEnabled. */
  readonly osvCheckEnabled?: boolean;
  /** Forwarded from container.config.integrations.mcp.osvCacheTtlMs. */
  readonly osvCacheTtlMs?: number;
  /** Pino logger; canonical fields; never logs secrets. */
  readonly logger: ComisLogger;
  /**
   * Trust-root: the daemon-private installed-bundles state read from
   * `${dataDir}/installed-bundles.json`. The resolver checks
   * `hasBundleRecord(state, skillId, name)` — NOT `existing._bundleSource`
   * — to decide whether an existing entry is one we previously installed
   * (replace-in-place) or user-authored (collision).
   *
   * Omitting this field is equivalent to passing `{}` (no recorded
   * bundles). The omission case treats EVERY existing entry as user-owned,
   * so callers that genuinely want the prior `_bundleSource`-as-trust-root
   * behavior must thread the actual state through. The install-helper and
   * boot-orchestrator both pass it explicitly.
   */
  readonly installedBundleState?: InstalledBundleState;
}

/**
 * Pure resolver. Validates the manifest against the current config and
 * returns a Result the caller commits or aborts on.
 *
 * Algorithm:
 *
 *   STEP 1 — Name-collision detection (synchronous, no network).
 *     Build Map<name, McpServerEntry> for O(N) lookup. Walk bundle entries:
 *       - No existing match ⇒ clean add (tag with _bundleSource).
 *       - Existing match with _bundleSource === input.skillId ⇒ idempotent
 *         replace-in-place.
 *       - Existing match with different _bundleSource OR no _bundleSource:
 *         - force=false ⇒ accumulate to collision list.
 *         - force=true ⇒ bundle entry wins; existing entry archived to
 *           the new entry's _bundleArchive slot.
 *
 *   STEP 2 — Plaintext-secret scan (synchronous, no network).
 *     For each bundle entry's env block (skipping entries with
 *     `disablePlaintextSecretCheck === true`), run looksLikePlaintextSecret
 *     over each VALUE. First match short-circuits the whole resolver with
 *     err({kind:"plaintext_secret"}). Log emits envKey (the NAME) but
 *     NEVER the value.
 *
 *   STEP 3 — OSV malware check (async; osvMalwareCheck's internal
 *     runOnOsvFetchChain serializes the network portion).
 *     For each stdio bundle entry with a recognizable package
 *     (extractMcpPackageName returns non-null), query OSV. First malicious
 *     verdict short-circuits with err({kind:"osv_malware"}). Gate is
 *     opt-out via input.osvCheckEnabled === false.
 *
 *   STEP 4 — Assemble nextServers + connectQueue + archivedOverrides.
 *     Final map of all entries (current + new + collision-replaced),
 *     materialized as a sorted-by-name array for determinism.
 *
 * @param input Resolver input (see ResolveBundleInput).
 * @returns Result with ResolvedBundle on success OR BundleError variant
 *          on first gate failure. NO side effects on either path.
 */
export async function resolveBundle(
  input: ResolveBundleInput,
): Promise<Result<ResolvedBundle, BundleError>> {
  // -------------------------------------------------------------------------
  // STEP 1: Name-collision detection — synchronous walk.
  // -------------------------------------------------------------------------
  //
  // currentByName starts as the existing server map and is mutated in place
  // for the two cases where an EXISTING entry is REPLACED:
  //   - idempotent replace-in-place (matching _bundleSource).
  //   - force-collision (bundle entry wins, existing archived).
  // Clean adds accumulate to `newBundleEntries` and are merged into
  // currentByName at STEP 4 (after the safety gates pass).

  const currentByName = new Map<string, McpServerEntry>(
    input.currentServers.map((entry) => [entry.name, entry]),
  );
  const collisionList: Array<{
    name: string;
    existingBundleSource?: string;
    thisSkill: string;
  }> = [];
  const archivedOverrides: Array<{
    name: string;
    archive: McpServerEntry;
    cause: "user_override" | "force_collision";
  }> = [];
  const newBundleEntries: McpServerEntry[] = [];

  // Trust root for "did WE install this entry as a bundle?". An
  // empty state (no file, malformed file, or absent from input) treats
  // EVERY existing entry as user-owned regardless of its _bundleSource
  // field — the fail-CLOSED stance that defeats provenance spoofing.
  const installedBundleState: InstalledBundleState = input.installedBundleState ?? {};

  for (const bundleEntry of input.manifestMcpServers) {
    const existing = currentByName.get(bundleEntry.name);
    if (existing === undefined) {
      // Clean add — tag with provenance and accumulate. The entry lands
      // in currentByName at STEP 4 after safety gates pass.
      newBundleEntries.push({ ...bundleEntry, _bundleSource: input.skillId });
      continue;
    }
    // The trust-root check. The existing entry is "ours to replace"
    // ONLY IF the daemon's private state file records us (this skillId) as
    // having installed an entry with this name. The entry's own
    // `_bundleSource` field is informational — a hand-edited config.yaml
    // could spoof it, and using it as the trust root opens a silent-
    // replace privilege-escalation vector.
    if (hasBundleRecord(installedBundleState, input.skillId, bundleEntry.name)) {
      // Idempotent replace-in-place. The new entry's definition
      // overwrites the existing slot; _bundleSource stays the same skill.
      // _bundleArchive (if any) is NOT carried forward — last-write-wins
      // semantics for the archive slot.
      currentByName.set(bundleEntry.name, {
        ...bundleEntry,
        _bundleSource: input.skillId,
      });
      continue;
    }
    // Cross-bundle OR user-owned collision (including the spoofed-
    // `_bundleSource` case: existing.entry._bundleSource may match
    // input.skillId, but the state file does NOT record us as having
    // installed it — so we MUST classify it as user-owned).
    if (!input.force) {
      collisionList.push({
        name: bundleEntry.name,
        existingBundleSource: existing._bundleSource,
        thisSkill: input.skillId,
      });
      continue;
    }
    // force=true: bundle entry wins; existing entry archived to the new
    // entry's _bundleArchive slot. Operators can audit via
    // `comis mcp list --show-bundle-overrides`.
    const replacementEntry: McpServerEntry = {
      ...bundleEntry,
      _bundleSource: input.skillId,
      _bundleArchive: existing,
    };
    currentByName.set(bundleEntry.name, replacementEntry);
    archivedOverrides.push({
      name: bundleEntry.name,
      archive: existing,
      cause: "force_collision",
    });
  }

  if (collisionList.length > 0) {
    // Reject the WHOLE bundle on any collision when !force. Zero
    // side effects — collisions are diagnostic only, no archive is set.
    input.logger.warn(
      {
        method: "skills.bundle.resolve",
        skillId: input.skillId,
        collisionCount: collisionList.length,
        hint: "Bundle install rejected: name collision with existing MCP entries; pass force=true to override",
        errorKind: "config" as const,
      },
      "Bundle resolver: name-collision reject",
    );
    return err({ kind: "name_collision", collisions: collisionList });
  }

  // -------------------------------------------------------------------------
  // STEP 2: Plaintext-secret scan — synchronous, no network.
  // -------------------------------------------------------------------------
  //
  // Iterate input.manifestMcpServers (NOT currentByName) — the gate only
  // applies to entries the BUNDLE is contributing. Existing user entries
  // were already gated by mcp.connect's pre-Zod check;
  // re-checking them here would surface a false-positive on already-
  // accepted operator-set values.

  for (const entry of input.manifestMcpServers) {
    if (!entry.env) continue;
    if (entry.disablePlaintextSecretCheck === true) continue;
    for (const [envKey, value] of Object.entries(entry.env)) {
      if (typeof value !== "string") continue;
      if (looksLikePlaintextSecret(value)) {
        input.logger.warn(
          {
            method: "skills.bundle.resolve",
            entityId: entry.name,
            skillId: input.skillId,
            envKey, // NEVER log the value — only the key name
            hint: "Bundle entry env contains a value matching the plaintext-secret heuristic; install rejected. Use ${KEY} env-refs instead, or set disablePlaintextSecretCheck: true per-entry to opt out.",
            errorKind: "validation" as const,
          },
          "Bundle resolver: plaintext-secret reject",
        );
        return err({ kind: "plaintext_secret", serverName: entry.name, envKey });
      }
    }
  }

  // -------------------------------------------------------------------------
  // STEP 3: OSV malware check — async; serialized via runOnOsvFetchChain.
  // -------------------------------------------------------------------------
  //
  // Gate is opt-out via osvCheckEnabled === false. Stops at the first
  // malicious verdict; later entries are not queried.
  // Non-stdio entries and stdio entries without a recognizable package
  // (extractMcpPackageName returns null for `node`, `python3`, etc.) skip
  // the OSV check — they fall through to mcp-client-connect's existing
  // OSV gate at runtime.

  if (input.osvCheckEnabled !== false) {
    for (const entry of input.manifestMcpServers) {
      if (entry.transport !== "stdio") continue;
      if (entry.command === undefined) continue;
      const pkg = extractMcpPackageName(entry.command, entry.args);
      if (pkg === null) continue;
      const verdictResult = await osvMalwareCheck(pkg.name, pkg.ecosystem, {
        cacheDir: DEFAULT_OSV_CACHE_DIR,
        ttlMs: input.osvCacheTtlMs ?? 86_400_000,
        logger: input.logger,
      });
      if (verdictResult.verdict === "malicious") {
        input.logger.warn(
          {
            method: "skills.bundle.resolve",
            entityId: entry.name,
            skillId: input.skillId,
            packageName: pkg.name,
            ecosystem: pkg.ecosystem,
            advisoryIds: verdictResult.advisoryIds,
            hint: "OSV reports malicious advisory for bundle entry's package; install rejected. Skill author MUST update the bundled mcpServers command to a non-malicious package.",
            errorKind: "dependency" as const,
          },
          "Bundle resolver: OSV malware reject",
        );
        return err({
          kind: "osv_malware",
          serverName: entry.name,
          packageName: pkg.name,
          advisoryIds: verdictResult.advisoryIds,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4: Assemble nextServers + connectQueue.
  // -------------------------------------------------------------------------
  //
  // currentByName already holds: original entries + idempotent replaces +
  // force-collision wins. Merge in newBundleEntries (the clean adds) then
  // materialize sorted by name for deterministic YAML round-trip.

  for (const entry of newBundleEntries) {
    currentByName.set(entry.name, entry);
  }
  const nextServers: McpServerEntry[] = Array.from(currentByName.values()).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  // connectQueue: the bundle entries (clean adds + force-collision wins +
  // idempotent replaces) — preserves manifest order so connect attempts
  // happen in the skill author's declared order. For each bundle entry,
  // look up the FINAL shape from currentByName (which may carry
  // _bundleArchive from a force-collision).
  const connectQueue: McpServerEntry[] = input.manifestMcpServers.map(
    (bundleEntry) => {
      const finalEntry = currentByName.get(bundleEntry.name);
      // currentByName is guaranteed to contain every bundle name: clean
      // adds were inserted above; force-collisions wrote during STEP 1;
      // idempotent replaces wrote during STEP 1. The `??` fallback
      // preserves type safety without affecting runtime behavior.
      return finalEntry ?? bundleEntry;
    },
  );

  return ok({
    nextServers,
    connectQueue,
    archivedOverrides,
  });
}
