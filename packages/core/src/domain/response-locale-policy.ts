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

export const ResponseLocaleSourceSchema = z.enum([
  "request",
  "explicit",
  "workspace",
  "conversation",
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

export type ResponseLocaleSource = z.infer<typeof ResponseLocaleSourceSchema>;
export type ResponseLocalePolicy = z.infer<typeof ResponseLocalePolicySchema>;

export function parseResponseLocalePolicy(
  raw: unknown,
): Result<ResponseLocalePolicy, z.ZodError> {
  const parsed = ResponseLocalePolicySchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
