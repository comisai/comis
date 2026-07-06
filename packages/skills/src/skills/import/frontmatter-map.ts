// SPDX-License-Identifier: Apache-2.0
/**
 * Foreign-frontmatter mapper — the format-compatibility gate for skill import.
 *
 * The internal manifest schema is a `z.strictObject`, so a fully-conforming
 * manifest authored for ANOTHER ecosystem (or in a legacy/pre-migration Comis
 * form) is rejected outright by an unmapped foreign key. This pure transform
 * converges such a manifest onto the SPEC-PURE carrier — exactly the six
 * top-level fields with every platform extension under one `metadata.comis`
 * JSON-string key — which the shipped `parseSkillManifest` then lifts and
 * validates. The mapper NEVER silently reinterprets a field: it assigns only a
 * fixed set of known keys (never spreads the untrusted input), and every field
 * without an internal home is DROPPED with a warning naming the exact key.
 *
 * Executable entrypoint declarations are never mapped — import is prompt-only,
 * so an entrypoint/script declaration drops with a loud warning rather than
 * carrying an execution vector into the manifest.
 *
 * Legacy pre-migration Comis top-level fields (`comis:`, `userInvocable`, …)
 * are passed through untouched; the shipped lift converts them (with its own
 * deprecation warning). This module does not re-implement that lift.
 *
 * @module
 */
import type { ErrorKind } from "@comis/core";

/**
 * A single non-fatal mapping decision the operator should see: a dropped or
 * normalized field. Mirrors the shipped lift's warning shape (`hint` +
 * `errorKind`); `key` names the exact foreign field for assertions and audit.
 */
export interface MapWarning {
  /** The exact foreign key (dotted for nested paths, e.g. `metadata.openclaw.install`). */
  readonly key: string;
  /** Operator-facing message; always contains the key. */
  readonly message: string;
  /** Actionable hint naming the field and why it has no internal home. */
  readonly hint: string;
  /** Closed-union error class; a mapping decision is always a configuration matter. */
  readonly errorKind: ErrorKind;
}

/** The mapper's output: a spec-pure frontmatter object + the drop/normalize log. */
export interface ForeignMapResult {
  /** Spec-pure frontmatter — feed to `parseSkillManifest` to lift + validate. */
  readonly specPure: Record<string, unknown>;
  /** Every field dropped or normalized, each naming its key. */
  readonly warnings: MapWarning[];
}

/** Free-prose compatibility beyond this length draws an advisory warning. */
const MAX_COMPATIBILITY_LENGTH = 500;

/** A valid manifest name slug (mirrors `SkillNameSchema`, pre-refine). */
const NAME_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Executable-entrypoint declaration keys. None is ever mapped: import is
 * prompt-only, so each drops with a loud warning rather than smuggling an
 * execution vector into the manifest.
 */
const EXECUTABLE_ENTRYPOINT_KEYS: ReadonlySet<string> = new Set([
  "entrypoint",
  "main",
  "exec",
  "run",
  "scripts",
  "command",
  "bin",
  "binary",
  "executable",
]);

/**
 * Pre-migration Comis top-level fields. Passed through untouched so the shipped
 * lift converts them (with its deprecation warning) — never re-implemented here.
 */
const LEGACY_PASSTHROUGH_KEYS: ReadonlySet<string> = new Set([
  "userInvocable",
  "disableModelInvocation",
  "argumentHint",
  "permissions",
  "inputSchema",
  "comis",
  "mcpServers",
  "allowedTools",
]);

/**
 * Author-declared fields the strict schema validates but the prompt tier NEVER
 * acts on: they are not projected into the runtime prompt-skill descriptor and
 * no runtime path reads them (only `allowed-tools` restricts an imported skill's
 * tools). They pass through so the schema still validates their shape, but a
 * warning names them so an untrusted import cannot imply a runtime grant that
 * does not exist ("never spread untrusted input" made explicit at this boundary).
 */
const INERT_IMPORTED_AUTHOR_FIELDS: ReadonlySet<string> = new Set(["permissions", "inputSchema"]);

/**
 * The single own-key pollution vector at this boundary: `__proto__`. A YAML/JSON
 * parser materializes it as an own data property, and a later bracket-copy would
 * invoke the inherited setter — so it is never copied onto any output object.
 */
function isDangerousKey(key: string): boolean {
  return key === "__proto__";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Push a drop/normalize warning naming the key. */
function warn(warnings: MapWarning[], key: string, message: string, hint: string): void {
  warnings.push({ key, message, hint, errorKind: "config" });
}

/** A scalar coerced to its faithful string form; `undefined` for non-scalars. */
function coerceScalarString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

/** A string, or the string members of an array; `[]` otherwise. */
function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Normalize an OS declaration to a string list (schema lowercases downstream). */
function coerceOsList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string");
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** A namespace value as an object: a plain object, or a JSON string; else undefined. */
function coerceNamespaceObject(value: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function dedup(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** Merge prerequisite bins/env into the comis namespace bag (deduped). */
function mergeRequires(comisBag: Record<string, unknown>, bins: string[], env: string[]): void {
  if (bins.length === 0 && env.length === 0) return;
  const existing = isPlainObject(comisBag["requires"])
    ? (comisBag["requires"] as { bins?: string[]; env?: string[] })
    : {};
  comisBag["requires"] = {
    bins: dedup([...(existing.bins ?? []), ...bins]),
    env: dedup([...(existing.env ?? []), ...env]),
  };
}

/** Fold a `requires`-shaped block: keep bins/env, drop every other key with a warning. */
function foldRequires(
  value: unknown,
  comisBag: Record<string, unknown>,
  warnings: MapWarning[],
  path: string,
): void {
  if (!isPlainObject(value)) {
    warn(
      warnings,
      path,
      `'${path}' is not a prerequisites object and was dropped.`,
      `Author '${path}' as an object with 'bins' and/or 'env' string lists.`,
    );
    return;
  }
  let bins: string[] = [];
  let env: string[] = [];
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) continue;
    if (key === "bins") bins = stringArray(value[key]);
    else if (key === "env") env = stringArray(value[key]);
    else {
      warn(
        warnings,
        `${path}.${key}`,
        `'${path}.${key}' has no internal manifest home and was dropped.`,
        `Comis records declared prerequisites (bins/env) but does not consume '${key}'.`,
      );
    }
  }
  mergeRequires(comisBag, bins, env);
}

/**
 * Fold the sibling `metadata.openclaw` extension namespace into the internal
 * comis block: skillKey/primaryEnv/os/requires map (near-identity); every other
 * key (the checksum-less `install[]` binary-installer spec, `always`, `emoji`,
 * `homepage`, `requires.anyBins`/`config`, …) drops with a key-naming warning.
 */
function foldSiblingNamespace(
  value: unknown,
  comisBag: Record<string, unknown>,
  warnings: MapWarning[],
): void {
  const ns = coerceNamespaceObject(value);
  if (ns === undefined) {
    warn(
      warnings,
      "metadata.openclaw",
      `The metadata.openclaw namespace was not an object and was dropped.`,
      `Author metadata.openclaw as an object (or a JSON string) carrying skillKey/primaryEnv/os/requires.`,
    );
    return;
  }
  for (const key of Object.keys(ns)) {
    if (isDangerousKey(key)) continue;
    const value_ = ns[key];
    switch (key) {
      case "skillKey": {
        const s = coerceScalarString(value_);
        if (s !== undefined) comisBag["skill-key"] = s;
        break;
      }
      case "primaryEnv": {
        const s = coerceScalarString(value_);
        if (s !== undefined) comisBag["primary-env"] = s;
        break;
      }
      case "os": {
        const os = coerceOsList(value_);
        if (os) comisBag["os"] = os;
        break;
      }
      case "requires":
        foldRequires(value_, comisBag, warnings, "metadata.openclaw.requires");
        break;
      default:
        warn(
          warnings,
          `metadata.openclaw.${key}`,
          `'metadata.openclaw.${key}' has no internal manifest home and was dropped.`,
          `Comis maps skillKey/primaryEnv/os/requires; it does not install or consume '${key}'.`,
        );
    }
  }
}

/** Map a top-level `prerequisites` block onto comis requires where shapes match. */
function mapPrerequisites(
  value: unknown,
  comisBag: Record<string, unknown>,
  warnings: MapWarning[],
): void {
  if (!isPlainObject(value)) {
    warn(
      warnings,
      "prerequisites",
      `'prerequisites' is not an object and was dropped.`,
      `Author prerequisites as an object with 'commands' and/or 'env_vars' string lists.`,
    );
    return;
  }
  let bins: string[] = [];
  let env: string[] = [];
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) continue;
    if (key === "commands") bins = stringArray(value[key]);
    else if (key === "env_vars") env = stringArray(value[key]);
    else {
      warn(
        warnings,
        `prerequisites.${key}`,
        `'prerequisites.${key}' has no internal manifest home and was dropped.`,
        `Comis maps prerequisites.commands -> requires.bins and prerequisites.env_vars -> requires.env; '${key}' has no match.`,
      );
    }
  }
  mergeRequires(comisBag, bins, env);
}

/**
 * Process the spec `metadata` map: keep string entries, flatten scalar values to
 * their string form, fold the sibling `metadata.openclaw` namespace, pass an
 * already-spec-pure `metadata.comis` JSON string through, and drop any nested
 * (object/array/null) value with a key-naming warning (never crash the strict
 * string-to-string metadata).
 */
function processMetadataMap(
  value: unknown,
  comisBag: Record<string, unknown>,
  metaMap: Record<string, unknown>,
  warnings: MapWarning[],
): void {
  if (!isPlainObject(value)) {
    warn(
      warnings,
      "metadata",
      `The metadata block was not a map and was dropped.`,
      `Author metadata as a string-to-string map.`,
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (isDangerousKey(key)) continue;
    const entry = value[key];
    if (key === "openclaw") {
      foldSiblingNamespace(entry, comisBag, warnings);
      continue;
    }
    if (key === "comis" && typeof entry === "string") {
      // An already-spec-pure carrier: preserve it (foreign namespaces, if any,
      // are reconciled at assembly).
      metaMap["comis"] = entry;
      continue;
    }
    if (typeof entry === "string") {
      metaMap[key] = entry;
      continue;
    }
    const scalar = coerceScalarString(entry);
    if (scalar !== undefined) {
      metaMap[key] = scalar;
      continue;
    }
    const shape = Array.isArray(entry) ? "list" : entry === null ? "null" : "object";
    warn(
      warnings,
      `metadata.${key}`,
      `The nested metadata value 'metadata.${key}' has no string representation and was dropped.`,
      `metadata values must be strings; 'metadata.${key}' was a ${shape} and was dropped.`,
    );
  }
}

/** Normalize the authored name to a valid manifest slug, naming any change. */
function handleName(
  value: unknown,
  specPure: Record<string, unknown>,
  warnings: MapWarning[],
): void {
  if (typeof value !== "string") {
    // Let the strict schema report the type error with a clear path.
    specPure["name"] = value;
    return;
  }
  if (NAME_SLUG_RE.test(value) && value.length <= 64) {
    specPure["name"] = value;
    return;
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  specPure["name"] = slug.length > 0 ? slug : value;
  warn(
    warnings,
    "name",
    `Skill name '${value}' was normalized to the manifest slug '${String(specPure["name"])}'.`,
    `The 'name' field is the authoritative manifest name (a lowercase-hyphen slug), independent of the install directory.`,
  );
}

/**
 * Map foreign / legacy SKILL.md frontmatter onto the spec-pure carrier.
 *
 * Pure: no I/O, no mutation of the input. Follows the lift's discipline —
 * assign only fixed known keys, never spread untrusted input. Every field
 * without an internal home drops with a warning naming the exact key; executable
 * entrypoints are never mapped. Hand the returned `specPure` to
 * `parseSkillManifest`, which runs the shipped lift + strict validation.
 *
 * @param rawFrontmatter The parsed YAML frontmatter (own-enumerable keys read).
 * @returns The spec-pure frontmatter object + the drop/normalize warnings.
 */
export function mapForeignFrontmatter(rawFrontmatter: Record<string, unknown>): ForeignMapResult {
  const warnings: MapWarning[] = [];
  const specPure: Record<string, unknown> = {};
  const comisBag: Record<string, unknown> = {};
  const metaMap: Record<string, unknown> = {};

  for (const key of Object.keys(rawFrontmatter)) {
    if (isDangerousKey(key)) {
      warn(
        warnings,
        key,
        `A '${key}' key was present in the frontmatter and was refused.`,
        `Remove the '${key}' key; it is a prototype-pollution vector and is never carried onto the manifest.`,
      );
      continue;
    }
    const value = rawFrontmatter[key];
    switch (key) {
      case "name":
        handleName(value, specPure, warnings);
        break;
      case "description":
      case "license":
        specPure[key] = value;
        break;
      case "compatibility":
        specPure["compatibility"] = value;
        if (typeof value === "string" && value.length > MAX_COMPATIBILITY_LENGTH) {
          warn(
            warnings,
            "compatibility",
            `The compatibility note exceeds ${MAX_COMPATIBILITY_LENGTH} characters.`,
            `Shorten 'compatibility' to ${MAX_COMPATIBILITY_LENGTH} characters or fewer; it is prose for readers and carries no platform behavior.`,
          );
        }
        break;
      case "allowed-tools": {
        if (typeof value === "string") {
          specPure["allowed-tools"] = value;
        } else if (Array.isArray(value)) {
          const tools = value.filter((v): v is string => typeof v === "string");
          if (tools.length === 0) {
            // A list with NO string members would join to "" — and an empty
            // internal allowedTools means "no restriction", so emitting "" would
            // fail OPEN on the tool-restriction boundary and defeat the manifest
            // lift's fail-closed guard. Preserve the original value so the lift
            // rejects a non-string allowed-tools instead of silently unrestricting.
            specPure["allowed-tools"] = value;
            warn(
              warnings,
              "allowed-tools",
              `'allowed-tools' was a list with no string entries and was left unnormalized for the manifest to reject.`,
              `Author 'allowed-tools' as a space-separated string (or a list of tool-name strings); an empty tool restriction is refused, never treated as 'no restriction'.`,
            );
          } else {
            specPure["allowed-tools"] = tools.join(" ");
            if (tools.length !== value.length) {
              const dropped = value.length - tools.length;
              warn(
                warnings,
                "allowed-tools",
                `'allowed-tools' had ${dropped} non-string entr${dropped === 1 ? "y" : "ies"} dropped during normalization.`,
                `Author every 'allowed-tools' entry as a tool-name string; non-string entries are not carried onto the manifest.`,
              );
            }
          }
        } else {
          warn(
            warnings,
            "allowed-tools",
            `'allowed-tools' was neither a space-separated string nor a list and was dropped.`,
            `Author 'allowed-tools' as a space-separated string naming the exact tools the skill may use.`,
          );
        }
        break;
      }
      case "metadata":
        processMetadataMap(value, comisBag, metaMap, warnings);
        break;
      case "platforms": {
        const os = coerceOsList(value);
        if (os) comisBag["os"] = os;
        else {
          warn(
            warnings,
            "platforms",
            `'platforms' was neither a string nor a list of strings and was dropped.`,
            `Author 'platforms' as a string or a list of OS strings; it maps to the internal comis os field.`,
          );
        }
        break;
      }
      case "version": {
        const s = coerceScalarString(value);
        if (s !== undefined) metaMap["version"] = s;
        else {
          warn(
            warnings,
            "version",
            `'version' was not a scalar and was dropped.`,
            `Author 'version' as a string; it maps to metadata.version.`,
          );
        }
        break;
      }
      case "author": {
        const s = coerceScalarString(value);
        if (s !== undefined) metaMap["author"] = s;
        else {
          warn(
            warnings,
            "author",
            `'author' was not a scalar and was dropped.`,
            `Author 'author' as a string; it maps to metadata.author.`,
          );
        }
        break;
      }
      case "prerequisites":
        mapPrerequisites(value, comisBag, warnings);
        break;
      case "type":
        // 'type' is no longer an authored field (skills are always prompt-typed).
        // A non-prompt declaration signals a script/exec skill imported prompt-only.
        if (value !== "prompt") {
          warn(
            warnings,
            "type",
            `A non-prompt 'type' declaration ('${String(value)}') was dropped; import is prompt-only.`,
            `Skills import as prompt-only; the 'type' field is not carried onto the manifest.`,
          );
        }
        break;
      default:
        if (EXECUTABLE_ENTRYPOINT_KEYS.has(key)) {
          warn(
            warnings,
            key,
            `The executable entrypoint '${key}' was dropped; skills import prompt-only.`,
            `Import never maps an executable entrypoint ('${key}'); only the prompt body and metadata are imported.`,
          );
        } else if (LEGACY_PASSTHROUGH_KEYS.has(key)) {
          // Pre-migration Comis field: pass through so the shipped lift converts it.
          specPure[key] = value;
          if (INERT_IMPORTED_AUTHOR_FIELDS.has(key)) {
            warn(
              warnings,
              key,
              `'${key}' is accepted but not authoritative for an imported skill and grants nothing at runtime.`,
              `An imported prompt skill's '${key}' is validated but never acted on — it is not projected into the runtime skill and no runtime path reads it (only 'allowed-tools' restricts an imported skill's tools). Remove it to avoid implying a runtime effect.`,
            );
          }
        } else {
          warn(
            warnings,
            key,
            `The field '${key}' has no internal manifest home and was dropped.`,
            `'${key}' is not a spec-pure field and has no mapping; it was dropped rather than reinterpreted.`,
          );
        }
    }
  }

  if (Object.keys(comisBag).length > 0) {
    // The platform extension bag rides as a JSON string under metadata.comis;
    // the shipped lift parses it and merges the comis namespace block.
    metaMap["comis"] = JSON.stringify({ comis: comisBag });
  }
  if (Object.keys(metaMap).length > 0) {
    specPure["metadata"] = metaMap;
  }

  return { specPure, warnings };
}
