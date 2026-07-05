// SPDX-License-Identifier: Apache-2.0
/**
 * Normalize authored SKILL.md frontmatter into the internal manifest shape,
 * BEFORE the strict schema runs.
 *
 * Two authored carriers converge here to the SAME internal object:
 *   - the spec-pure form — exactly the six top-level spec fields, with platform
 *     extensions under a `metadata.comis` JSON string and the version under
 *     `metadata.version`; and
 *   - the pre-migration top-level form (extensions at the top level), which is
 *     read with a deprecation warning and is never rewritten.
 *
 * The transform only moves the carrier. The returned object is validated by the
 * unchanged strict `SkillManifestSchema` afterward — that is where the platform
 * sub-schemas (permissions, comis namespace, mcpServers) actually run and where
 * any unknown internal key is rejected. Malformed `metadata.comis` JSON fails
 * here instead, with an error naming the key.
 *
 * @module
 */
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { isSpecPureFrontmatter } from "./spec-purity.js";

/** Pino-compatible logger interface. The skills package already uses this shape; reuse here. */
interface DiscoveryLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Optional context threaded through the lift: a logger for the deprecation
 * warning on the pre-migration path, and the skill name for its payload.
 */
export interface LiftContext {
  logger?: DiscoveryLogger;
  skillName?: string;
}

/** Platform extension keys carried inside the `metadata.comis` JSON string. */
const METADATA_COMIS_KEYS: readonly string[] = [
  "userInvocable",
  "disableModelInvocation",
  "argumentHint",
  "permissions",
  "inputSchema",
  "comis",
  "mcpServers",
];

/** Internal top-level keys whose authored home moved under the metadata carrier. */
const PRE_MIGRATION_KEYS: readonly string[] = [
  "type",
  "version",
  ...METADATA_COMIS_KEYS,
  "allowedTools",
];

/**
 * The single own-key pollution vector: `__proto__`. `JSON.parse` and the YAML
 * parser both materialize it as an own data property, and a later bracket copy
 * (`residual[key] = ...`) would invoke the inherited `__proto__` setter. A
 * `constructor` / `prototype` DATA key is NOT a vector -- copying it only shadows
 * with an own property -- so it is not refused (a JSON-Schema property may be
 * named either).
 */
const DANGEROUS_KEYS = new Set<string>(["__proto__"]);

/**
 * Deep-scan a parsed JSON value for an own `__proto__` key at any depth.
 * `JSON.parse` materializes `__proto__` as an own data property (it does not
 * pollute the prototype), and the strict schema does not flag it, so the lift
 * refuses such a payload at this boundary rather than merge it onward.
 */
function hasDangerousKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((element) => hasDangerousKey(element));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (hasDangerousKey((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

/** Compatibility prose beyond this length draws an advisory warning (no rejection). */
const MAX_COMPATIBILITY_LENGTH = 500;

/** The authored home a moved pre-migration key belongs under. */
function authoredHomeFor(key: string): string {
  if (key === "version") return "metadata.version";
  if (key === "type") return "(no longer an authored field)";
  return "metadata.comis";
}

/**
 * Normalize authored frontmatter into the internal manifest shape.
 *
 * @param raw - The parsed YAML frontmatter object (own-enumerable keys only are read).
 * @param ctx - Optional logger + skill name for the deprecation / advisory warnings.
 * @returns The normalized internal-shape object, or an error naming `metadata.comis`
 *          when its JSON carrier is malformed.
 */
export function liftAuthoredFrontmatter(
  raw: Record<string, unknown>,
  ctx: LiftContext,
): Result<Record<string, unknown>, Error> {
  return isSpecPureFrontmatter(raw) ? liftSpecPure(raw, ctx) : liftPreMigration(raw, ctx);
}

/**
 * Spec-pure branch: rebuild the internal top-level shape from the six-field
 * carrier. Never spreads the parsed input onto internal defaults; assigns only
 * a fixed set of safe literal keys.
 */
function liftSpecPure(
  raw: Record<string, unknown>,
  ctx: LiftContext,
): Result<Record<string, unknown>, Error> {
  const internal: Record<string, unknown> = {};

  for (const key of ["name", "description", "license", "compatibility"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      internal[key] = raw[key];
    }
  }

  const authoredTools = raw["allowed-tools"];
  if (authoredTools !== undefined) {
    // A present-but-non-string allowed-tools is refused, not dropped: an empty
    // internal allowedTools means "no restriction", so silently discarding a
    // list would fail open on the tool-restriction boundary.
    if (typeof authoredTools !== "string") {
      return err(
        new Error(
          "allowed-tools must be a space-separated string naming the exact tools the skill may use, not a list",
        ),
      );
    }
    internal["allowedTools"] = authoredTools.split(/\s+/).filter(Boolean);
  }

  const rawMeta = raw["metadata"];
  if (rawMeta !== undefined) {
    if (rawMeta === null || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
      // Not a map — hand it to the strict schema, which rejects it with a clear path.
      internal["metadata"] = rawMeta;
    } else {
      const residual = liftMetadataMap(rawMeta as Record<string, unknown>, internal);
      if (!residual.ok) return residual;
      // Empty-metadata normalization: an emptied residual map becomes undefined
      // (the internal schema has no default for metadata) so the only-version+comis
      // form converges with the pre-migration form, which carries no metadata.
      if (Object.keys(residual.value).length > 0) {
        internal["metadata"] = residual.value;
      }
    }
  }

  const compat = internal["compatibility"];
  if (typeof compat === "string" && compat.length > MAX_COMPATIBILITY_LENGTH) {
    ctx.logger?.warn(
      {
        errorKind: "config" as const,
        skillName: ctx.skillName,
        hint: `Shorten the compatibility note to ${MAX_COMPATIBILITY_LENGTH} characters or fewer; it is prose for readers and carries no platform behavior.`,
      },
      "Skill compatibility note exceeds the recommended length.",
    );
  }

  return ok(internal);
}

/**
 * Extract `version` and the `metadata.comis` extension bag out of the metadata
 * map and onto `internal`, returning the residual metadata map (a fresh copy).
 */
function liftMetadataMap(
  rawMeta: Record<string, unknown>,
  internal: Record<string, unknown>,
): Result<Record<string, unknown>, Error> {
  const residual: Record<string, unknown> = {};
  for (const key of Object.keys(rawMeta)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    residual[key] = rawMeta[key];
  }

  if (Object.prototype.hasOwnProperty.call(residual, "version")) {
    internal["version"] = residual["version"];
    delete residual["version"];
  }

  if (Object.prototype.hasOwnProperty.call(residual, "comis")) {
    const merged = mergeExtensionBag(residual["comis"], internal);
    if (!merged.ok) return merged;
    delete residual["comis"];
  }

  return ok(residual);
}

/**
 * Parse the `metadata.comis` JSON string and merge its known extension keys onto
 * the internal top level. `JSON.parse` runs with no reviver; failures return an
 * error naming `metadata.comis`. A payload carrying a prototype-polluting key at
 * any depth is refused (naming the key), since the strict schema does not flag
 * one. Only the fixed extension-key set is merged, so a spec top-level field
 * cannot be overridden.
 */
function mergeExtensionBag(
  rawValue: unknown,
  internal: Record<string, unknown>,
): Result<Record<string, unknown>, Error> {
  if (typeof rawValue !== "string") {
    return err(new Error("metadata.comis must be a JSON string carrying the platform extension fields"));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch (e) {
    return err(new Error(`metadata.comis is not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return err(new Error("metadata.comis must be a JSON object carrying the platform extension fields"));
  }

  if (hasDangerousKey(parsed)) {
    return err(new Error("metadata.comis carries a prototype-polluting __proto__ key and was refused"));
  }

  const bag = parsed as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (METADATA_COMIS_KEYS.includes(key)) {
      internal[key] = bag[key];
    }
  }
  return ok(internal);
}

/**
 * Pre-migration branch: the object is already internal-shape (or carries an
 * unknown key the strict schema will reject). It is passed through unchanged; a
 * deprecation warning names each present pre-migration key and its authored home.
 */
function liftPreMigration(
  raw: Record<string, unknown>,
  ctx: LiftContext,
): Result<Record<string, unknown>, Error> {
  const movedKeys: Array<{ from: string; to: string }> = [];
  for (const key of PRE_MIGRATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      movedKeys.push({ from: key, to: authoredHomeFor(key) });
    }
  }

  if (ctx.logger && movedKeys.length > 0) {
    ctx.logger.warn(
      {
        errorKind: "config" as const,
        skillName: ctx.skillName,
        movedKeys,
        hint:
          "Author skill frontmatter with the metadata carrier: put version under metadata.version " +
          "and userInvocable/disableModelInvocation/argumentHint/permissions/inputSchema/comis/mcpServers " +
          "in the metadata.comis JSON string. The top-level form is read with a deprecation warning.",
      },
      "Skill frontmatter authors platform extension fields at the top level; author them under the metadata carrier instead.",
    );
  }

  return ok(raw);
}
