// SPDX-License-Identifier: Apache-2.0
/**
 * Recursive walker over a Zod schema; throws on forbidden shapes.
 *
 * Phase 35 — WEB-CONTRACTS-11 (allowlist) + CONTEXT D-06 + D-07.
 *
 * Shared by:
 *   - scripts/contracts/generate-web-artifact.ts (codegen-time gate, Wave D)
 *   - test/architecture/api-contracts-allowlist.test.ts (pnpm test gate, Wave A)
 *
 * Walker placement per 35-PATTERNS.md OQ-1 option (a): scripts/contracts/ is
 * the codegen home; the architecture test imports it via relative cross-tree
 * path. Single-source-of-truth avoids drift.
 *
 * ZodAny / ZodUnknown are NOT in the top-level allowlist — they only pass as
 * the value-type inside z.record(z.string(), z.unknown()) (the loose-modeling
 * escape hatch for graph.execute / config.patch per CONTEXT D-05).
 *
 * @module
 */
import { z, type ZodTypeAny } from "zod";
import { SUPPORTED_SHAPE_NAMES } from "./supported-zod-shapes.js";

/** Constructors permitted as the value-type inside a ZodRecord (only). */
const RECORD_VALUE_ESCAPE_HATCH: ReadonlySet<string> = new Set(["ZodAny", "ZodUnknown"]);

/**
 * Recursively walk `schema`; throw if any encountered constructor is not in
 * the 12-shape allowlist. ZodAny / ZodUnknown are permitted ONLY when the
 * caller-supplied path ends with `"*"` (i.e., they sit as the value-type of a
 * ZodRecord). Terminal scalar shapes (string, number, boolean, enum, literal)
 * are not recursed.
 *
 * @param method     Contract method name (used in the error message).
 * @param direction  "request" or "response" (used in the error message).
 * @param schema     The Zod schema node currently being inspected.
 * @param path       Position path used for error reporting; defaults to `[]`.
 *                   Special tokens: `"[]"` (array element), `"|N"` (union
 *                   option index), `"*"` (record value-type).
 */
export function assertOnlyAllowlistShapes(
  method: string,
  direction: "request" | "response",
  schema: ZodTypeAny,
  path: readonly string[] = [],
): void {
  const className = schema.constructor.name;
  const insideRecordValue = path.length > 0 && path[path.length - 1] === "*";
  const allowed =
    SUPPORTED_SHAPE_NAMES.has(className) ||
    (insideRecordValue && RECORD_VALUE_ESCAPE_HATCH.has(className));
  if (!allowed) {
    throw new Error(
      `Contract ${method} ${direction} at path [${path.join(".") || "<root>"}] uses ` +
        `forbidden Zod shape "${className}". Allowlist: ${[...SUPPORTED_SHAPE_NAMES].join(", ")}. ` +
        `To extend the allowlist, edit scripts/contracts/supported-zod-shapes.ts and ` +
        `update WEB-CONTRACTS-11 + 35-CONTEXT.md D-07.`,
    );
  }
  // Recurse into composite shapes.
  if (schema instanceof z.ZodObject) {
    for (const [k, sub] of Object.entries(schema.shape)) {
      assertOnlyAllowlistShapes(method, direction, sub as ZodTypeAny, [...path, k]);
    }
  } else if (schema instanceof z.ZodArray) {
    assertOnlyAllowlistShapes(method, direction, schema.element as ZodTypeAny, [...path, "[]"]);
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    const options = (schema as unknown as { options: ZodTypeAny[] }).options ?? [];
    options.forEach((o, i) =>
      assertOnlyAllowlistShapes(method, direction, o, [...path, `|${i}`]),
    );
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    assertOnlyAllowlistShapes(method, direction, schema.unwrap(), path);
  } else if (schema instanceof z.ZodRecord) {
    const valueType = (schema as unknown as { _def?: { valueType?: ZodTypeAny } })._def
      ?.valueType;
    if (valueType) {
      assertOnlyAllowlistShapes(method, direction, valueType, [...path, "*"]);
    }
  }
  // ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodLiteral are terminal.
}
