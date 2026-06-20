// SPDX-License-Identifier: Apache-2.0
/**
 * `schemaToExample` — extracted from `graph-helpers.ts` to keep that file under
 * the graph-handlers/ 500-line sub-cap (#217 file-split debt; behavior
 * byte-identical). Re-exported from `./graph-helpers.js` so the canonical
 * import surface is unchanged (mirrors the `graph-repair.ts` extraction). Pure
 * — depends only on `zod`, so no import cycle with graph-helpers.
 *
 * @module
 */
import { z } from "zod";

/**
 * Generate an example object from a Zod schema's shape for LLM self-correction hints.
 * Uses instanceof checks against Zod v4 class hierarchy (not _def.typeName).
 * For ZodDefault, uses _def.innerType (no public API alternative).
 */
export function schemaToExample(schema: z.ZodObject<z.ZodRawShape>): Record<string, string> {
  const shape = schema.shape;
  const result: Record<string, string> = {};
  for (const [key, type] of Object.entries(shape)) {
    const t = type as z.ZodTypeAny;
    if (t.description) { result[key] = t.description; continue; }
    const inner = t instanceof z.ZodOptional ? t.unwrap()
                : t instanceof z.ZodDefault  ? (t as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType
                : t;
    if (inner instanceof z.ZodString)       result[key] = "string";
    else if (inner instanceof z.ZodNumber)  result[key] = "number";
    else if (inner instanceof z.ZodBoolean) result[key] = "boolean";
    else if (inner instanceof z.ZodArray)   result[key] = "array";
    else if (inner instanceof z.ZodObject)  result[key] = "object";
    else                                    result[key] = "unknown";
    if (t instanceof z.ZodOptional) result[key] += " (optional)";
  }
  return result;
}
