// SPDX-License-Identifier: Apache-2.0
/** Content-free installed-skill exposure aggregation for system health. */

import { readSkillProvenance } from "../../skills/skill-provenance-store.js";

/** Current configured registry ids, scoped to the agent that imported a skill. */
export type RegistryAllowlistByAgent = ReadonlyMap<string, ReadonlySet<string>>;

/** Counts surfaced by the daemon-wide system-health report. */
export interface SkillExposureSummary {
  readonly imported: number;
  readonly community: number;
  readonly registry: number;
  readonly nonAllowlistedRegistry: number;
  readonly pendingMcp: number;
  readonly registryAllowlistKnown: boolean;
}

const IMPORT_SOURCES: ReadonlySet<string> = new Set([
  "github",
  "archive",
  "wellknown",
  "registry",
]);

/** Reduce durable provenance without reading any skill content. */
export function computeSkillExposure(
  dataDir: string,
  registryAllowlistByAgent?: RegistryAllowlistByAgent,
): SkillExposureSummary {
  const records = Object.values(readSkillProvenance(dataDir));
  let imported = 0;
  let community = 0;
  let registry = 0;
  let nonAllowlistedRegistry = 0;
  let pendingMcp = 0;

  for (const record of records) {
    if (IMPORT_SOURCES.has(record.source)) imported++;
    if (record.trust === "community") community++;
    if ((record.pendingMcpServers?.length ?? 0) > 0) pendingMcp++;
    if (record.source !== "registry") continue;

    registry++;
    const registryId = record.evidence?.registryId;
    const agentAllowlist = registryAllowlistByAgent?.get(record.importedBy.agentId);
    if (registryId === undefined || agentAllowlist?.has(registryId) !== true) {
      nonAllowlistedRegistry++;
    }
  }

  return {
    imported,
    community,
    registry,
    nonAllowlistedRegistry,
    pendingMcp,
    registryAllowlistKnown: registryAllowlistByAgent !== undefined,
  };
}

/** Project per-agent immutable config into the ids needed by the aggregate. */
export function buildRegistryAllowlistByAgent(
  agents: Readonly<Record<string, {
    readonly skills?: {
      readonly import?: {
        readonly registries?: readonly { readonly id: string; readonly kind: "wellknown" | "registry" }[];
      };
    };
  }>>,
): RegistryAllowlistByAgent {
  const allowlists = new Map<string, ReadonlySet<string>>();
  for (const [agentId, config] of Object.entries(agents)) {
    const ids = new Set(
      (config.skills?.import?.registries ?? [])
        .filter((registry) => registry.kind === "registry")
        .map((registry) => registry.id),
    );
    allowlists.set(agentId, ids);
  }
  return allowlists;
}
