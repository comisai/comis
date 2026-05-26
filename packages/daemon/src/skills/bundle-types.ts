// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle resolver discriminated-union error variants + ResolvedBundle
 * interface. Extracted from the resolver source so downstream callers
 * (install hook, boot orchestrator) can `import type { BundleError,
 * ResolvedBundle }` without pulling the async resolver function into
 * their type-import graph.
 *
 * @module
 */

import type { McpServerEntry } from "@comis/core";

/**
 * Bundle error variants. Discriminated by `kind`. The caller maps each
 * variant to a bracketed-code RPC error string:
 *   - "name_collision"   ⇒ "[bundle_install_rejected:name_collision]"
 *   - "plaintext_secret" ⇒ "[bundle_install_rejected:plaintext_secret]"
 *   - "osv_malware"      ⇒ "[bundle_install_rejected:osv_malware]"
 *   - "schema_invalid"   ⇒ "[bundle_install_rejected:schema_invalid]"
 *
 * Resolution is zero-side-effect: ANY of these variants means the caller
 * (install hook OR boot orchestrator) MUST NOT invoke `persistMcpServers`,
 * MUST NOT spawn transports, MUST NOT log secret values.
 */
export type BundleError =
  | {
      kind: "name_collision";
      collisions: ReadonlyArray<{
        /** Bundle entry's name that collided with currentServers. */
        name: string;
        /** _bundleSource of the existing entry (undefined ⇒ user-authored). */
        existingBundleSource?: string;
        /** The skillId attempting to install this entry. */
        thisSkill: string;
      }>;
    }
  | {
      kind: "plaintext_secret";
      /** The bundle entry whose env tripped the heuristic. */
      serverName: string;
      /** Env key whose VALUE matched looksLikeSecretValue. The VALUE
       *  is NEVER included — operator-facing logs and the BundleError
       *  payload both surface only the key name. */
      envKey: string;
    }
  | {
      kind: "osv_malware";
      /** The bundle entry whose stdio command targets a malicious pkg. */
      serverName: string;
      /** Package name as extracted by extractMcpPackageName(command,args). */
      packageName: string;
      /** OSV advisory IDs matched (MAL-* per OpenSSF malicious-pkg dataset). */
      advisoryIds: readonly string[];
    }
  | {
      kind: "schema_invalid";
      /** Free-form details for diagnostic — typically a Zod issue message. */
      details: string;
    };

/**
 * Successful resolver output. Caller (install hook OR boot orchestrator)
 * commits this verbatim via `persistMcpServers(nextServers, ...)` followed
 * by `manager.connect(...)` for each entry in `connectQueue`.
 */
export interface ResolvedBundle {
  /**
   * The full new integrations.mcp.servers array. The caller passes this
   * verbatim to persistMcpServers — deepMerge replaces arrays wholesale,
   * so the array IS the commit. Sorted alphabetically by name for
   * deterministic YAML round-trip (the idempotence proof step).
   */
  readonly nextServers: readonly McpServerEntry[];
  /**
   * Entries the caller should invoke `manager.connect(...)` on. These are
   * the NEW or REPLACED bundle entries — NOT preserved user entries (those
   * already have connections managed by setupMcp / prior mcp.connect
   * calls). Order matches manifestMcpServers.
   */
  readonly connectQueue: readonly McpServerEntry[];
  /**
   * Diagnostic info: when --force or user-override triggered an archive,
   * this surfaces the archived entries so callers can log a structured
   * warn line for operator visibility.
   */
  readonly archivedOverrides: ReadonlyArray<{
    /** Bundle entry's name (the same name on both sides of the collision). */
    name: string;
    /** The entry that was displaced into the _bundleArchive slot. */
    archive: McpServerEntry;
    /** Why the archive fired. force_collision: --force overrode a name
     *  clash. user_override: user-override semantic (the boot path's
     *  user-wins-whole case). */
    cause: "user_override" | "force_collision";
  }>;
}
