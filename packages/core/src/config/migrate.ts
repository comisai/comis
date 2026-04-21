// SPDX-License-Identifier: Apache-2.0
/**
 * Config migration: transforms legacy config keys into current schema structures.
 *
 * Runs before Zod validation so that old config files with flat streaming keys
 * (pacingMinMs, pacingMaxMs, coalesceMaxChars) are not rejected by z.strictObject().
 *
 * Pure function -- deep-clones input, never mutates the original.
 *
 * @module
 */

/**
 * Migrate legacy streaming root-level defaults.
 *
 * Transforms `defaultPacingMinMs` / `defaultPacingMaxMs` into
 * `defaultDeliveryTiming: { minMs, maxMs }`.
 *
 * Skips migration if `defaultDeliveryTiming` already exists (user has migrated).
 */
function migrateStreamingRoot(streaming: Record<string, unknown>): void {
  const hasLegacyMin = "defaultPacingMinMs" in streaming;
  const hasLegacyMax = "defaultPacingMaxMs" in streaming;

  if (!hasLegacyMin && !hasLegacyMax) {
    return;
  }

  // Only migrate if the new nested object does not already exist
  if (!("defaultDeliveryTiming" in streaming)) {
    const dt: Record<string, unknown> = {};
    if (hasLegacyMin) dt.minMs = streaming.defaultPacingMinMs;
    if (hasLegacyMax) dt.maxMs = streaming.defaultPacingMaxMs;
    streaming.defaultDeliveryTiming = dt;
  }

  // Delete legacy keys regardless (they are not in the new schema)
  delete streaming.defaultPacingMinMs;
  delete streaming.defaultPacingMaxMs;
}

/**
 * Migrate a single per-channel entry.
 *
 * Transforms `pacingMinMs`, `pacingMaxMs` into `deliveryTiming: { minMs, maxMs }`
 * and `coalesceMaxChars` into `coalescer: { maxChars }`.
 *
 * Skips each nested object's migration if it already exists.
 */
function migratePerChannelEntry(entry: Record<string, unknown>): void {
  const hasLegacyPacingMin = "pacingMinMs" in entry;
  const hasLegacyPacingMax = "pacingMaxMs" in entry;
  const hasLegacyCoalesce = "coalesceMaxChars" in entry;

  // Migrate pacing keys -> deliveryTiming
  if (hasLegacyPacingMin || hasLegacyPacingMax) {
    if (!("deliveryTiming" in entry)) {
      const dt: Record<string, unknown> = {};
      if (hasLegacyPacingMin) dt.minMs = entry.pacingMinMs;
      if (hasLegacyPacingMax) dt.maxMs = entry.pacingMaxMs;
      entry.deliveryTiming = dt;
    }
    delete entry.pacingMinMs;
    delete entry.pacingMaxMs;
  }

  // Migrate coalesceMaxChars -> coalescer.maxChars
  if (hasLegacyCoalesce) {
    if (!("coalescer" in entry)) {
      entry.coalescer = { maxChars: entry.coalesceMaxChars };
    }
    delete entry.coalesceMaxChars;
  }
}

/**
 * Migrate per-channel entries within `streaming.perChannel`.
 */
function migratePerChannel(perChannel: Record<string, unknown>): void {
  for (const key of Object.keys(perChannel)) {
    const entry = perChannel[key];
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      migratePerChannelEntry(entry as Record<string, unknown>);
    }
  }
}

/**
 * Transform legacy config keys into the current schema structure.
 *
 * This is a pure function: it deep-clones the input and returns a new object.
 * It is designed to be called after merging config layers but before Zod validation.
 *
 * Legacy keys migrated:
 * - `streaming.defaultPacingMinMs` -> `streaming.defaultDeliveryTiming.minMs`
 * - `streaming.defaultPacingMaxMs` -> `streaming.defaultDeliveryTiming.maxMs`
 * - `streaming.perChannel.*.pacingMinMs` -> `streaming.perChannel.*.deliveryTiming.minMs`
 * - `streaming.perChannel.*.pacingMaxMs` -> `streaming.perChannel.*.deliveryTiming.maxMs`
 * - `streaming.perChannel.*.coalesceMaxChars` -> `streaming.perChannel.*.coalescer.maxChars`
 *
 * @param raw - Raw config object (post-merge, pre-validation)
 * @returns Transformed config object with legacy keys migrated
 */
export function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(raw);

  const streaming = result.streaming;
  if (streaming === null || streaming === undefined || typeof streaming !== "object" || Array.isArray(streaming)) {
    return result;
  }

  const s = streaming as Record<string, unknown>;

  // Migrate root-level streaming defaults
  migrateStreamingRoot(s);

  // Migrate per-channel entries
  const perChannel = s.perChannel;
  if (perChannel !== null && perChannel !== undefined && typeof perChannel === "object" && !Array.isArray(perChannel)) {
    migratePerChannel(perChannel as Record<string, unknown>);
  }

  return result;
}
