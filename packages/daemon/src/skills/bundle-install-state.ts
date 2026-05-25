// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-private installed-bundles state file.
 *
 * The trust root for "did WE install this MCP entry as a bundle?". Distinct
 * from the `_bundleSource` field on `McpServerEntry` in `config.yaml` — that
 * field is now INFORMATIONAL / AUDIT-only (operators inspecting config.yaml
 * see provenance) and the resolver MUST NOT use it to decide "replace in
 * place vs collision". The decision is driven by THIS state file.
 *
 * Threat model: an operator hand-edits `config.yaml` and injects
 * `_bundleSource: "skill-x"` onto a user-authored entry. Without this state
 * file, the next install of skill-x would silently replace that entry via
 * the resolver's idempotent-replace path. With this state file, the resolver
 * sees no record of `(skill-x, that-server-name)` and classifies the entry
 * as user-owned → collision error, requires `--force` flag.
 *
 * File location: `${dataDir}/installed-bundles.json` (mode 0o600 — owner-only
 * R/W — same confidentiality invariant as auth-profiles.json).
 *
 * File format (JSON):
 *   {
 *     "<skillId>": {
 *       "<serverName>": "<entryFingerprint>",
 *       ...
 *     },
 *     ...
 *   }
 *
 * The fingerprint is a SHA-256 hash over a canonical projection of the
 * entry's connect-affecting fields (transport, command, args, url, env,
 * headers, cwd). It is informational — the bundle resolver only checks
 * `hasBundleRecord` (presence), not equality — but is recorded so future
 * auditing or "detect a bundle entry that was hand-edited" tooling has
 * the anchor it needs.
 *
 * Writers: ONLY the bundle-install path (`bundle-install-helper.ts`
 * `applyBundleInstall` after `persistMcpServers`) and the boot-orchestrator
 * (`setup-skill-bundles.ts` after `persistMcpServers`). NOT the resolver.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ok, err, type Result } from "@comis/shared";
import { safePath } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import type { McpServerEntry } from "@comis/core";

const STATE_FILE_NAME = "installed-bundles.json";

/**
 * State shape: outer map skillId → inner map serverName → fingerprint.
 * Both layers are open string-keyed records — JSON-round-trippable.
 */
export type InstalledBundleState = Record<string, Record<string, string>>;

/**
 * Read the installed-bundles state file. A missing file or malformed JSON
 * returns an EMPTY state (`{}`) so the resolver's collision check is
 * fail-safe (no record ⇒ never classify an entry as bundle-managed).
 *
 * @param dataDir Absolute path to the Comis data directory (e.g. `~/.comis`).
 * @returns The state object; never undefined.
 */
export function readBundleInstallState(dataDir: string): InstalledBundleState {
  const filePath = safePath(dataDir, STATE_FILE_NAME);
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Shape check is intentionally shallow — only verify the outer level is
    // an object whose values are objects whose values are strings. The
    // resolver never reads the fingerprint string itself, so loose shape
    // tolerance here keeps a partially-corrupt state file from breaking
    // boot.
    const state: InstalledBundleState = {};
    for (const [skillId, inner] of Object.entries(parsed as Record<string, unknown>)) {
      if (inner === null || typeof inner !== "object" || Array.isArray(inner)) continue;
      const innerRec: Record<string, string> = {};
      for (const [serverName, fp] of Object.entries(inner as Record<string, unknown>)) {
        if (typeof fp === "string") innerRec[serverName] = fp;
      }
      state[skillId] = innerRec;
    }
    return state;
  } catch {
    // Malformed JSON or unreadable file ⇒ treat as empty. Safer than
    // throwing — the worst case is the resolver classifies known bundle
    // entries as user-owned, triggering a collision (operator runs --force
    // to recover). Throwing here would block boot entirely.
    return {};
  }
}

/**
 * Record the entries we just installed as a bundle for `skillId`. Replaces
 * any prior recording for the SAME skillId (so a re-install with a different
 * server set correctly forgets entries that are no longer in the bundle).
 *
 * Atomicity: writes the WHOLE state file via the symlink-safe substrate
 * (`writeRegularFile` from `@comis/observability` — mode 0o600,
 * O_NOFOLLOW, unlink-before-open). Concurrent writers within the same
 * process serialize via the absence of `await` boundaries during the
 * write step; cross-process writers are not contemplated (the daemon is
 * the only writer).
 *
 * Returns `Result<void, Error>` — callers SHOULD log on failure but the
 * fallback behavior (state file appears empty next read) is a fail-CLOSED
 * stance: the resolver classifies the entries as user-owned on next boot,
 * requiring `--force` to re-install.
 *
 * @param dataDir Comis data dir (the state file lives at `dataDir/installed-bundles.json`).
 * @param skillId The skill we just installed entries for.
 * @param entries The bundle entries we just persisted (their names + fingerprints recorded).
 */
export function recordBundleEntries(
  dataDir: string,
  skillId: string,
  entries: readonly McpServerEntry[],
): Result<void, Error> {
  // Ensure the data dir exists with mode 0o700 (daemon-private state invariant).
  const dirResult = ensureContainedDir({ dir: dataDir, mode: 0o700 });
  if (!dirResult.ok) {
    return err(
      new Error(`bundle-install-state: failed to ensure dataDir ${dataDir}: ${dirResult.error.message}`),
    );
  }

  const state = readBundleInstallState(dataDir);
  // Replace the entire skill's record so de-installed entries are forgotten.
  state[skillId] = {};
  for (const entry of entries) {
    state[skillId]![entry.name] = computeEntryFingerprint(entry);
  }

  const filePath = safePath(dataDir, STATE_FILE_NAME);
  const writeResult = writeRegularFile({
    path: filePath,
    content: JSON.stringify(state, null, 2),
  });
  if (!writeResult.ok) {
    return err(
      new Error(`bundle-install-state: failed to write ${filePath}: ${writeResult.error.message}`),
    );
  }
  return ok(undefined);
}

/**
 * Remove a skill's recorded entries (called when a skill is deleted).
 * Returns `Result<void, Error>`.
 */
export function forgetBundle(dataDir: string, skillId: string): Result<void, Error> {
  const state = readBundleInstallState(dataDir);
  if (!(skillId in state)) return ok(undefined);
  delete state[skillId];

  const filePath = safePath(dataDir, STATE_FILE_NAME);
  const writeResult = writeRegularFile({
    path: filePath,
    content: JSON.stringify(state, null, 2),
  });
  if (!writeResult.ok) {
    return err(
      new Error(`bundle-install-state: failed to write ${filePath}: ${writeResult.error.message}`),
    );
  }
  return ok(undefined);
}

/**
 * Canonical fingerprint of a bundle entry's connect-affecting fields.
 *
 * Captures: transport, command, args, url, env (keys + values), headers,
 * cwd. Does NOT include `_bundleSource` or `_bundleArchive` (provenance
 * markers, not connect parameters), `enabled` (operator toggle, not
 * identity), or per-server reliability/idle/utility tuning fields
 * (they don't change the SHAPE of the entry, only its runtime behavior).
 *
 * Sort-stabilized JSON.stringify is used so reordering object keys does
 * not change the hash.
 */
export function computeEntryFingerprint(entry: McpServerEntry): string {
  const canonical: Record<string, unknown> = {
    transport: entry.transport,
  };
  if (entry.command !== undefined) canonical.command = entry.command;
  if (entry.args !== undefined) canonical.args = entry.args;
  if (entry.url !== undefined) canonical.url = entry.url;
  if (entry.cwd !== undefined) canonical.cwd = entry.cwd;
  if (entry.env !== undefined) {
    const sortedEnv: Record<string, string> = {};
    for (const k of Object.keys(entry.env).sort()) {
      sortedEnv[k] = entry.env[k]!;
    }
    canonical.env = sortedEnv;
  }
  if (entry.headers !== undefined) {
    const sortedHeaders: Record<string, string> = {};
    for (const k of Object.keys(entry.headers).sort()) {
      sortedHeaders[k] = entry.headers[k]!;
    }
    canonical.headers = sortedHeaders;
  }
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Check whether `(skillId, serverName)` is recorded in the state.
 *
 * The resolver uses this as the SOLE source of truth for "is this
 * existing entry actually ours to replace?". The `_bundleSource` field
 * on the entry itself is no longer trusted for this decision — a
 * hand-edited config.yaml could spoof it.
 */
export function hasBundleRecord(
  state: InstalledBundleState,
  skillId: string,
  serverName: string,
): boolean {
  return state[skillId]?.[serverName] !== undefined;
}
