// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { z } from "zod";

function isCanonicalLocale(value: string): boolean {
  const canonical = tryCatch(() => Intl.getCanonicalLocales(value));
  return canonical.ok && canonical.value.length === 1 && canonical.value[0] === value;
}

export const CanonicalLocaleSchema = z.string().trim().min(2).max(128).refine(
  isCanonicalLocale,
  "locale must be a canonical BCP-47 language tag",
);

/**
 * Operator-supplied strings for the deterministic platform replies (the canned
 * lines the runtime sends when a turn degrades — timeout, context exhausted,
 * output truncated, loop halted). Keyed locale tag → message id → string.
 *
 * The runtime ships ONE pack, English, as its fallback. It does not know any
 * other human language and must not: a deployment that answers its users in
 * another language supplies that language's strings here. Message ids are
 * validated by the consuming runtime, not here — core deliberately does not
 * own that list.
 */
export const LocalePacksSchema = z.record(
  CanonicalLocaleSchema,
  z.record(z.string().min(1).max(64), z.string().min(1).max(2000)),
);

export const ResponseLocaleSourceSchema = z.enum([
  "request",
  "explicit",
  "unset",
]);

export const ResponseLocalePolicySchema = z.strictObject({
  locale: CanonicalLocaleSchema.optional(),
  source: ResponseLocaleSourceSchema,
  translationTarget: CanonicalLocaleSchema.optional(),
  enforceLocale: z.boolean(),
}).superRefine((policy, context) => {
  if (policy.source === "unset" && policy.locale !== undefined) {
    context.addIssue({ code: "custom", message: "an unset locale policy cannot carry a locale" });
  }
  if (policy.source !== "unset" && policy.locale === undefined) {
    context.addIssue({ code: "custom", message: "a resolved locale policy requires a locale" });
  }
  if (policy.enforceLocale && policy.locale === undefined) {
    context.addIssue({ code: "custom", message: "locale enforcement requires a resolved locale" });
  }
});

export const ResponseLocaleRepairSkippedSchema = z.strictObject({
  reason: z.literal("unrecovered_tool_failure"),
  expectedScript: z.string().regex(/^[A-Z][a-z]{3}$/u),
  actualScript: z.string().regex(/^[A-Z][a-z]{3}$/u),
  unrecoveredToolFailureCount: z.number().int().positive(),
});

export type ResponseLocaleSource = z.infer<typeof ResponseLocaleSourceSchema>;
export type ResponseLocalePolicy = z.infer<typeof ResponseLocalePolicySchema>;
export type ResponseLocaleRepairSkipped = z.infer<
  typeof ResponseLocaleRepairSkippedSchema
>;

export function parseResponseLocalePolicy(
  raw: unknown,
): Result<ResponseLocalePolicy, z.ZodError> {
  const parsed = ResponseLocalePolicySchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
