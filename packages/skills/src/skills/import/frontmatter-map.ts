// SPDX-License-Identifier: Apache-2.0
/**
 * Foreign-frontmatter mapper.
 *
 * `SkillManifestSchema` is a `z.strictObject` (`../manifest/schema.ts`), so an
 * unrecognized key is a PARSE FAILURE. The community convention Comis's format
 * is shaped after spells its keys in kebab-case (`allowed-tools`,
 * `argument-hint`), which means a perfectly benign skill authored against that
 * convention fails validation today. Since the vetting gate treats a parse
 * failure as a block, this mapper is what makes the stricter gate safe to ship.
 *
 * Contract, in priority order:
 *   1. Map what is semantically equivalent.
 *   2. DROP everything else, with a warning that names the key.
 *   3. Never reinterpret, and never silently park a value somewhere it will be
 *      coerced (notably `metadata`, which is `Record<string, string>`).
 *
 * Warnings carry keys and actions ONLY — never values, so they are safe to log
 * and to place in audit metadata.
 *
 * Pure: no fs, no net, no clock, no mutation of the caller's object.
 *
 * @module
 */

import type { MappingWarning } from "./bundle-types.js";

// ---------------------------------------------------------------------------
// Key tables
// ---------------------------------------------------------------------------

/** kebab-case alias → Comis-native camelCase field. */
const KEBAB_ALIASES: ReadonlyMap<string, string> = new Map([
  ["allowed-tools", "allowedTools"],
  ["argument-hint", "argumentHint"],
  ["user-invocable", "userInvocable"],
  ["disable-model-invocation", "disableModelInvocation"],
  ["input-schema", "inputSchema"],
  ["mcp-servers", "mcpServers"],
]);

/**
 * Keys that imply code execution. Dropped, never mapped: a Comis skill is
 * prompt-only, so importing the prompt half and discarding the executable half
 * is the honest outcome — with a warning loud enough that the operator knows
 * the skill is degraded.
 */
const EXECUTABLE_KEYS: ReadonlySet<string> = new Set([
  "entrypoint",
  "entry_point",
  "entryPoint",
  "run",
  "command",
  "exec",
  "scripts",
  "postInstall",
  "post_install",
  "preInstall",
  "pre_install",
  "install",
  "hooks",
]);

/** Fields `SkillManifestSchema` accepts verbatim. */
const NATIVE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "type",
  "version",
  "license",
  "userInvocable",
  "disableModelInvocation",
  "allowedTools",
  "argumentHint",
  "permissions",
  "inputSchema",
  "metadata",
  "comis",
  "mcpServers",
]);

/**
 * `metadata` sub-blocks other hosts use for runtime constraints. Only the two
 * genuinely-equivalent shapes are consumed (`os`, `requires`); the rest of the
 * sub-block is dropped with the parent key named.
 */
const HOST_RUNTIME_KEYS: readonly string[] = ["hostRuntime", "host_runtime", "runtime"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize a host `os` value the way `OsFieldSchema` would: array of lowercase strings. */
function normalizeOs(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value.toLowerCase()];
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

/** Normalize a host `requires` value into Comis's `{bins, env}` shape. */
function normalizeRequires(value: unknown): { bins: string[]; env: string[] } | undefined {
  if (!isPlainObject(value)) return undefined;
  const bins = Array.isArray(value["bins"]) ? value["bins"].filter((v): v is string => typeof v === "string") : [];
  const env = Array.isArray(value["env"]) ? value["env"].filter((v): v is string => typeof v === "string") : [];
  if (bins.length === 0 && env.length === 0) return undefined;
  return { bins, env };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Result of {@link mapForeignFrontmatter}. */
export interface MapForeignFrontmatterResult {
  /** A new object suitable for `SkillManifestSchema.safeParse`. */
  readonly frontmatter: Record<string, unknown>;
  /** One entry per remapped-with-conflict or dropped key. Deterministically ordered. */
  readonly warnings: readonly MappingWarning[];
}

/**
 * Map foreign frontmatter onto Comis's manifest shape.
 *
 * @param raw Parsed YAML frontmatter, exactly as `parseFrontmatter` returned it.
 *   Not mutated.
 */
export function mapForeignFrontmatter(raw: Record<string, unknown>): MapForeignFrontmatterResult {
  const out: Record<string, unknown> = {};
  const warnings: MappingWarning[] = [];
  // Author-supplied comis: block is the base; host-runtime mappings merge over
  // it without clobbering keys the author set explicitly.
  const nativeComis = raw["comis"];
  const hasNativeComis = Object.hasOwn(raw, "comis");
  const validNativeComis = isPlainObject(nativeComis);
  const comisBlock: Record<string, unknown> = validNativeComis ? { ...nativeComis } : {};
  let comisTouched = validNativeComis;

  // Pass 1 — native keys straight through (so a camelCase twin always wins a
  // conflict with its kebab alias, regardless of YAML key order).
  for (const key of Object.keys(raw)) {
    if (NATIVE_KEYS.has(key) && key !== "comis" && key !== "metadata") {
      out[key] = raw[key];
    }
  }

  // Pass 2 — everything else, in stable key order.
  for (const key of Object.keys(raw).sort()) {
    if (key === "comis") continue; // handled via comisBlock
    if (NATIVE_KEYS.has(key) && key !== "metadata") continue; // taken in pass 1

    if (key === "metadata") {
      const metadata = raw["metadata"];
      if (!isPlainObject(metadata)) {
        // A non-object metadata cannot satisfy Record<string,string>; drop it
        // rather than let the parse fail on a field the author likely copied
        // from another host.
        warnings.push({ key, action: "dropped_unmappable" });
        continue;
      }
      const remaining: Record<string, unknown> = {};
      for (const metaKey of Object.keys(metadata).sort()) {
        if (HOST_RUNTIME_KEYS.includes(metaKey)) {
          const block = metadata[metaKey];
          const qualifiedBlock = `metadata.${metaKey}`;
          if (!isPlainObject(block)) {
            warnings.push({ key: qualifiedBlock, action: "dropped_unmappable" });
            continue;
          }
          for (const runtimeKey of Object.keys(block).sort()) {
            const qualifiedKey = `${qualifiedBlock}.${runtimeKey}`;
            if (runtimeKey === "os") {
              const os = normalizeOs(block[runtimeKey]);
              if (os === undefined) {
                warnings.push({ key: qualifiedKey, action: "dropped_unmappable" });
              } else if (comisBlock["os"] === undefined) {
                comisBlock["os"] = os;
                comisTouched = true;
              } else {
                warnings.push({ key: qualifiedKey, action: "duplicate_key" });
              }
              continue;
            }
            if (runtimeKey === "requires") {
              const rawRequires = block[runtimeKey];
              const requires = normalizeRequires(rawRequires);
              if (requires === undefined) {
                warnings.push({ key: qualifiedKey, action: "dropped_unmappable" });
              } else if (comisBlock["requires"] === undefined) {
                comisBlock["requires"] = requires;
                comisTouched = true;
              } else {
                warnings.push({ key: qualifiedKey, action: "duplicate_key" });
              }
              if (isPlainObject(rawRequires)) {
                for (const requirementKey of Object.keys(rawRequires).sort()) {
                  if (requirementKey === "bins" || requirementKey === "env") continue;
                  warnings.push({
                    key: `${qualifiedKey}.${requirementKey}`,
                    action: EXECUTABLE_KEYS.has(requirementKey)
                      ? "dropped_executable"
                      : "dropped_unmappable",
                  });
                }
              }
              continue;
            }
            warnings.push({
              key: qualifiedKey,
              action: EXECUTABLE_KEYS.has(runtimeKey)
                ? "dropped_executable"
                : "dropped_unmappable",
            });
          }
          continue;
        }
        if (typeof metadata[metaKey] === "string") {
          remaining[metaKey] = metadata[metaKey];
        } else {
          warnings.push({
            key: `metadata.${metaKey}`,
            action: EXECUTABLE_KEYS.has(metaKey)
              ? "dropped_executable"
              : "dropped_unmappable",
          });
        }
      }
      if (Object.keys(remaining).length > 0) out["metadata"] = remaining;
      continue;
    }

    const alias = KEBAB_ALIASES.get(key);
    if (alias !== undefined) {
      if (out[alias] !== undefined) {
        // Both spellings present. The Comis-native key wins; silent
        // last-write-wins on a security-relevant field is the ambiguity to
        // avoid, so the loser is reported.
        warnings.push({ key, action: "duplicate_key" });
      } else {
        out[alias] = raw[key];
      }
      continue;
    }

    if (EXECUTABLE_KEYS.has(key)) {
      warnings.push({ key, action: "dropped_executable" });
      continue;
    }

    warnings.push({ key, action: "dropped_unmappable" });
  }

  if (comisTouched && Object.keys(comisBlock).length > 0) {
    out["comis"] = comisBlock;
  } else if (hasNativeComis && !validNativeComis) {
    // `comis` is a native field. Preserve an invalid native value so strict
    // manifest validation reports it instead of silently deleting it.
    out["comis"] = nativeComis;
  }

  return { frontmatter: out, warnings };
}
