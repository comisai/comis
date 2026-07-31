// SPDX-License-Identifier: Apache-2.0
/** Bounded content-free skill availability facts persisted with prompt telemetry. */

const MAX_UNAVAILABLE_SKILLS = 25;
const MAX_SKILL_NAME_CHARS = 128;
const MAX_SKILL_REASON_CHARS = 512;

export function boundedUnavailableSkills(value: unknown): Array<{ name: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ name: string; reason: string }> = [];
  for (const item of value.slice(0, MAX_UNAVAILABLE_SKILLS)) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.name !== "string" || typeof candidate.reason !== "string") continue;
    result.push({
      name: candidate.name.slice(0, MAX_SKILL_NAME_CHARS),
      reason: candidate.reason.slice(0, MAX_SKILL_REASON_CHARS),
    });
  }
  return result;
}
