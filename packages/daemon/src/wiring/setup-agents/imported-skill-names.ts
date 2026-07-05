// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent imported-skill-name lookup for discovery enrichment.
 *
 * Returns the set of skill names the provenance store records for THIS agent —
 * shared skills key on the shared owner; local skills on this agent id. The
 * registry stamps a matched skill `source: "imported"` (advisory downward only:
 * a fail-safe empty store stamps nothing; absence never elevates). Read fresh on
 * every call so a just-completed import (which re-inits the registry) is
 * reflected on the next description build.
 *
 * @module
 */

import { readProvenanceStore } from "@comis/skills";

/** Build the fresh-reading imported-name lookup for `agentId` under `dataDir`. */
export function buildImportedSkillNamesLookup(
  dataDir: string,
  agentId: string,
): () => ReadonlySet<string> {
  return () => {
    const names = new Set<string>();
    for (const record of Object.values(readProvenanceStore(dataDir))) {
      if (record.scope === "shared" || (record.scope === "local" && record.agentId === agentId)) {
        names.add(record.name);
      }
    }
    return names;
  };
}
