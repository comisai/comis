// SPDX-License-Identifier: Apache-2.0
/**
 * Schema-driven config-value validation helpers.
 *
 * Pure helpers for navigating + coercing values against `AppConfigSchema`.
 * These three exports are part of the public API (re-exported through the
 * `config-handlers/` barrel) because they are consumed directly by tests
 * (`config-handlers.test.ts` imports `coerceConfigValue` via the barrel).
 *
 *   - unwrapSchema: peel Optional / Nullable / Default / Pipe wrappers
 *   - resolveSchemaForPath: walk root → section → key path → leaf schema
 *   - coerceConfigValue: coerce string scalars to typed JS values per leaf
 *
 * Note: this module has NO `@allow-throw` header because none of its
 * exports throw. The wrapping handlers in config-write.ts call into these
 * helpers and surface failures through `safeParse`.
 *
 * @module
 */

import { z } from "zod";

/**
 * Unwrap Zod schema wrappers (Optional / Nullable / Default / Pipe) to get
 * the core schema type. Uses Zod 4.x API exclusively:
 *   - ZodOptional / ZodNullable / ZodDefault → _def.innerType
 *   - ZodPipe → _def.in (Zod 4 replaced Zod 3's ZodEffects + ZodPipeline with
 *     a unified ZodPipe class, returned from both .transform() and .pipe()).
 *     Unwrap the input side so coercion targets the schema BEFORE any
 *     transform.
 *   - .refine() in Zod 4 is a no-op wrapper (returns the same class) — no
 *     handler needed.
 *
 * DO NOT reference z.ZodEffects or z.ZodPipeline: those classes do not exist
 * in Zod 4.3.6 and `instanceof` against `undefined` throws TypeError at
 * runtime.
 *
 * Capped at 10 iterations to prevent pathological nesting.
 *
 * @internal — exported only for test-only direct invocation.
 */
export function unwrapSchema(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
  if (!schema) return schema;
  let cur: z.ZodTypeAny = schema;
  for (let i = 0; i < 10; i++) {
    if (cur instanceof z.ZodOptional) {
      const inner = (cur as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
      if (!inner) break;
      cur = inner;
      continue;
    }
    if (cur instanceof z.ZodNullable) {
      const inner = (cur as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
      if (!inner) break;
      cur = inner;
      continue;
    }
    if (cur instanceof z.ZodDefault) {
      const inner = (cur as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
      if (!inner) break;
      cur = inner;
      continue;
    }
    if (cur instanceof z.ZodPipe) {
      const input = (cur as unknown as { _def?: { in?: z.ZodTypeAny } })._def?.in;
      if (!input) break;
      cur = input;
      continue;
    }
    break;
  }
  return cur;
}

/**
 * Resolve the sub-schema at (section + dot-notation key) from an
 * AppConfigSchema-shaped root. Returns undefined when the path cannot be
 * resolved (unknown section, array-index with non-numeric segment, or a walk
 * that hits a non-navigable schema type). Callers treat undefined as
 * "no coercion target known" and fall back to the legacy heuristic.
 *
 * Supports:
 *   - ZodObject → shape[key]
 *   - ZodArray → element (accepts numeric "N" or bracket-form "[N]" segments)
 *   - ZodRecord → valueType
 *
 * @internal — exported only for test-only direct invocation.
 */
export function resolveSchemaForPath(
  root: z.ZodTypeAny,
  section: string,
  key: string | undefined,
): z.ZodTypeAny | undefined {
  let cur = unwrapSchema(root);
  if (!(cur instanceof z.ZodObject)) return undefined;
  const sectionSchema = (cur.shape as Record<string, z.ZodTypeAny>)[section];
  if (!sectionSchema) return undefined;
  cur = unwrapSchema(sectionSchema);
  if (!key) return cur;
  const parts = key.split(".");
  for (const part of parts) {
    if (!cur) return undefined;
    if (cur instanceof z.ZodObject) {
      cur = unwrapSchema((cur.shape as Record<string, z.ZodTypeAny>)[part]);
    } else if (cur instanceof z.ZodArray) {
      if (/^\d+$/.test(part) || /^\[\d+\]$/.test(part)) {
        // ZodArray.element is typed as $ZodType (Zod 4 base); cast to ZodTypeAny.
        cur = unwrapSchema(cur.element as z.ZodTypeAny);
      } else {
        return undefined;
      }
    } else if (cur instanceof z.ZodRecord) {
      const rec = cur as unknown as { valueType?: z.ZodTypeAny; _def?: { valueType?: z.ZodTypeAny } };
      cur = unwrapSchema(rec.valueType ?? rec._def?.valueType);
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Coerce string representations of booleans and numbers to their native types,
 * guided by the target Zod sub-schema. LLMs often send "true"/"false"/"42" as
 * strings in tool-call parameters, causing Zod validation failures when the
 * schema expects boolean/number. When the target schema is ZodString (e.g.,
 * the value type of z.record(string, string)), strings pass through verbatim
 * — this prevents spurious coercion of env values like MAX_REQUESTS_PER_HOUR
 * = "20" on MCP server entries (z.record(z.string(), z.string())).
 *
 * Scalar coercion ONLY fires for ZodBoolean and ZodNumber targets. ZodLiteral,
 * ZodEnum, ZodNativeEnum, ZodDate, ZodAny, ZodUnknown, etc. pass strings
 * through unchanged (bias toward loud failure at Zod validation time rather
 * than silent coercion).
 *
 * Recursion descends via ZodObject.shape[k], ZodArray.element, and
 * ZodRecord.valueType. When schema is undefined (unresolved path), falls back
 * to the legacy type-agnostic heuristic for back-compat (e.g. scheduler.cron
 * JSON-stringified object case, tenantId ZodString pass-through).
 *
 * @param value - The value to coerce (from config.patch / config.apply params).
 * @param schema - The Zod sub-schema at this path in AppConfigSchema, or
 *   undefined when the path cannot be resolved.
 * @internal — exported only for test-only direct invocation.
 */
export function coerceConfigValue(value: unknown, schema: z.ZodTypeAny | undefined): unknown {
  const s = unwrapSchema(schema);

  if (typeof value === "string") {
    // Schema-guided coercion (preferred path)
    if (s instanceof z.ZodString) return value;
    if (s instanceof z.ZodBoolean) {
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    }
    if (s instanceof z.ZodNumber) {
      if (value !== "" && !isNaN(Number(value)) && isFinite(Number(value))) {
        return Number(value);
      }
      return value;
    }
    if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
      const options: z.ZodTypeAny[] =
        (s as unknown as { options?: z.ZodTypeAny[] }).options ??
        (s as unknown as { _def?: { options?: z.ZodTypeAny[] } })._def?.options ??
        [];
      // If any branch accepts strings, keep as string (bias toward loud failure).
      if (options.some((o) => unwrapSchema(o) instanceof z.ZodString)) return value;
      // Otherwise fall through to JSON-parse / legacy heuristic below.
    }

    // JSON-stringified array/object — parse and recurse with the SAME
    // sub-schema (parsed value sits at the same logical path).
    if (value.startsWith("[") || value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        return coerceConfigValue(parsed, schema);
      } catch {
        // Not valid JSON — fall through.
      }
    }

    // No schema target known → legacy heuristic (back-compat for unresolved paths).
    if (schema === undefined) {
      if (value === "true") return true;
      if (value === "false") return false;
      if (value !== "" && !isNaN(Number(value)) && isFinite(Number(value))) {
        return Number(value);
      }
    }

    return value;
  }

  if (Array.isArray(value)) {
    // ZodArray.element is typed as $ZodType (Zod 4 base); cast to ZodTypeAny.
    const element: z.ZodTypeAny | undefined =
      s instanceof z.ZodArray ? (s.element as z.ZodTypeAny) : undefined;
    return value.map((v) => coerceConfigValue(v, element));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      let child: z.ZodTypeAny | undefined;
      if (s instanceof z.ZodObject) {
        child = (s.shape as Record<string, z.ZodTypeAny>)[k];
      } else if (s instanceof z.ZodRecord) {
        const rec = s as unknown as { valueType?: z.ZodTypeAny; _def?: { valueType?: z.ZodTypeAny } };
        child = rec.valueType ?? rec._def?.valueType;
      }
      result[k] = coerceConfigValue(v, child);
    }
    return result;
  }

  return value;
}
