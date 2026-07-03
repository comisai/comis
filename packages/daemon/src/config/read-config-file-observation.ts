// SPDX-License-Identifier: Apache-2.0
/**
 * `readConfigFileObservation` — daemon-side aggregator that produces the
 * file-state observation for one config path.
 *
 * Returns a `ConfigFileObservation` containing snapshots of:
 *   - the target config file (`snapshot`),
 *   - its `<base>.last-good.yaml` sibling (`lkg`),
 *   - its `<base>.bak.yaml` sibling (`backup`).
 *
 * Each sibling is independently `null` when absent — the caller's
 * `createConfigObserveAuditRecord` projects the snapshot fields onto
 * the record's LKG-triple / backup-triple slots, nulling each when the
 * corresponding snapshot is null. The audit records reserve space
 * for the backup writer even though no in-tree producer ships today
 * (the backup field set is a stable contract for the future writer).
 *
 * Boundary discipline:
 *   - Lives in `@comis/daemon` because it is policy (which siblings
 *     to consult). The substrate (`@comis/observability`) provides
 *     `readFileSnapshot`; the daemon composes the policy.
 *   - Mirrors `last-known-good.ts:lastKnownGoodPath` for LKG sibling
 *     resolution to keep the convention single-sourced.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { dirname, basename } from "node:path";

import { safePath } from "@comis/core";
import { readFileSnapshot, type FileSnapshot } from "@comis/observability";

import { lastKnownGoodPath } from "./last-known-good.js";

/** Backup-sibling filename suffix. Convention: `<base>.bak.yaml`. */
const BACKUP_SUFFIX = ".bak.yaml";

/** One aggregated observation of a config path + its LKG / backup siblings. */
export interface ConfigFileObservation {
  /** Absolute path of the config file the daemon attempted to read. */
  readonly configPath: string;
  /** True when the target config file exists at boot. */
  readonly exists: boolean;
  /** Snapshot of the target file; null when it does not exist. */
  readonly snapshot: FileSnapshot | null;
  /** Snapshot of the `<base>.last-good.yaml` sibling; null when absent. */
  readonly lkg: FileSnapshot | null;
  /** Snapshot of the `<base>.bak.yaml` sibling; null when absent. */
  readonly backup: FileSnapshot | null;
}

/**
 * Derive the backup-sibling path next to a config file.
 *
 * `/home/user/.comis/config.yaml` → `/home/user/.comis/config.bak.yaml`
 *
 * The backup writer does not exist in-tree today. This
 * helper reserves the slot so the eventual writer ships against a
 * stable convention and `readConfigFileObservation` does not need a
 * schema bump when the file starts appearing on disk.
 */
function backupPath(configPath: string): string {
  const dir = dirname(configPath);
  const base = basename(configPath, ".yaml");
  return safePath(dir, `${base}${BACKUP_SUFFIX}`);
}

/**
 * Aggregate the file-state observation for one config path.
 *
 * The `snapshot`, `lkg`, and `backup` fields are independently null
 * when the corresponding file is absent or unreadable. `exists`
 * mirrors the target file's reachability (NOT the siblings — they have
 * their own null contract).
 *
 * `configPath` MUST be absolute. The caller (daemon bootstrap) passes
 * either an entry from `DEFAULT_CONFIG_PATHS` or a `COMIS_CONFIG_PATHS`
 * split component; both are absolute by construction at that call
 * site.
 */
export function readConfigFileObservation(
  configPath: string,
): ConfigFileObservation {
  const exists = existsSync(configPath);
  const snapshot = exists ? readFileSnapshot(configPath) : null;
  const lkg = readFileSnapshot(lastKnownGoodPath(configPath));
  const backup = readFileSnapshot(backupPath(configPath));
  return { configPath, exists, snapshot, lkg, backup };
}
