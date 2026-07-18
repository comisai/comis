// SPDX-License-Identifier: Apache-2.0
/**
 * The config-posture membership digest — the single place the support bundle
 * derives a view of the raw config, built to be content-free by construction.
 *
 * `buildConfigPosture` takes only NAMES: the raw top-level keys the config file
 * actually wrote (pre-defaults) and the system findings. No config VALUE ever
 * enters the function, so none can leave it. It reports which top-level
 * sections are present by iterating the FIXED AppConfigSchema universe and
 * keeping the names the raw config wrote — the output is provably a subset of
 * that universe, so an unknown or mistyped key cannot appear. The system
 * `config_posture` finding is plucked by code and its closed labels + COUNT are
 * copied verbatim (that finding is already content-free — labels like
 * `gateway.tls (off)` and a stranded-secret count, never a secret value).
 *
 * This is why the digest is safe on the writer's trusted-leaf path (which does
 * path substitution only, not value-shape masking): membership-only output has
 * nothing to mask. The extended no-secret-survives contract is the proof.
 *
 * @module
 */

import { AppConfigSchema } from "@comis/core";
import type { ConfigPostureDigest } from "./types.js";

/**
 * A system finding element as carried on `SystemHealthReport.findings[]`: a short
 * code, a content-free detail (closed labels + counts), a count, and a hint.
 * This is the pluck target — the `config_posture` member becomes the digest's
 * posture block.
 */
export interface SystemPostureFinding {
  readonly code: string;
  readonly detail: string;
  readonly count: number;
  readonly hint: string;
}

/**
 * The authoritative top-level config-section universe: the exported schema
 * shape, the single source of truth for what a top-level section name can be.
 * A raw key outside this set (a typo, an unknown section) is dropped, so the
 * digest can never emit a name the schema does not define.
 */
const CONFIG_SECTION_UNIVERSE: readonly string[] = Object.keys(AppConfigSchema.shape);

/** The system finding code whose closed labels + COUNT the digest surfaces. */
const CONFIG_POSTURE_FINDING_CODE = "config_posture";

/**
 * Build the content-free config-posture digest from the raw top-level config
 * keys and the system findings.
 *
 * `rawTopLevelKeys` is the set of section names the config file wrote before
 * schema defaults were applied — NAMES only. The result's `sections` is the
 * intersection with the fixed AppConfigSchema universe (iterated, so the output
 * is a subset of the universe and can never carry a value or an unknown key).
 * `configPosture` is the system `config_posture` finding's detail/count/hint, or
 * null when the finding is absent.
 */
export function buildConfigPosture(
  rawTopLevelKeys: readonly string[],
  systemFindings: readonly SystemPostureFinding[],
): ConfigPostureDigest {
  const rawKeys = new Set(rawTopLevelKeys);
  const sections = CONFIG_SECTION_UNIVERSE.filter((name) => rawKeys.has(name));

  const posture = systemFindings.find((finding) => finding.code === CONFIG_POSTURE_FINDING_CODE);

  return {
    schemaVersion: 1,
    sections,
    configPosture:
      posture !== undefined
        ? { detail: posture.detail, count: posture.count, hint: posture.hint }
        : null,
  };
}
