// SPDX-License-Identifier: Apache-2.0
/**
 * The 12-shape allowlist for contract Zod schemas.
 *
 * Forbidden shapes — every other Zod 4 class — would cause
 * z.toJSONSchema(schema, { unrepresentable: "throw" }) to throw, OR
 * silently lose semantics (e.g., .refine() projects to a no-op).
 *
 * Shared by:
 *   - scripts/contracts/generate-web-artifact.ts (codegen-time gate)
 *   - test/architecture/api-contracts-allowlist.test.ts (pnpm test gate)
 *
 * @module
 */
import { z } from "zod";

/** The 12 Zod constructors permitted in contract request/response schemas. */
export const SUPPORTED_ZOD_SHAPES = [
  z.ZodObject,
  z.ZodArray,
  z.ZodUnion,
  z.ZodDiscriminatedUnion,
  z.ZodString,
  z.ZodNumber,
  z.ZodBoolean,
  z.ZodEnum,
  z.ZodLiteral,
  z.ZodOptional,
  z.ZodNullable,
  z.ZodRecord,
] as const;

/** Pre-computed Set of constructor names — O(1) lookup for the walker. */
export const SUPPORTED_SHAPE_NAMES: ReadonlySet<string> = new Set(
  SUPPORTED_ZOD_SHAPES.map((c) => c.name),
);
