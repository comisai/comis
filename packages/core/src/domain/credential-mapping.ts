// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * InjectionType: How a credential is injected into an outbound HTTP request.
 *
 * - `bearer_header` — Authorization: Bearer <secret>
 * - `custom_header` — Arbitrary header (injectionKey = header name)
 * - `query_param` — URL query parameter (injectionKey = param name)
 * - `basic_auth` — Authorization: Basic base64(<secret>)
 */
export const InjectionTypeSchema = z.enum([
  "bearer_header",
  "custom_header",
  "query_param",
  "basic_auth",
]);

export type InjectionType = z.infer<typeof InjectionTypeSchema>;

/**
 * CredentialMapping: Binds an encrypted secret to an injection strategy
 * for a specific URL pattern and optional tool name.
 *
 * The CredentialInjector reads these mappings at request time to decide
 * which secret to inject, how to inject it, and which URLs it applies to.
 */
export const CredentialMappingSchema = z
  .object({
    /** Unique identifier for this mapping */
    id: z.string().min(1),
    /** References secrets(name) — the encrypted secret to inject */
    secretName: z.string().min(1),
    /** How the credential is injected into the request */
    injectionType: InjectionTypeSchema,
    /** Header name or query param name (required for custom_header and query_param) */
    injectionKey: z.string().optional(),
    /** URL pattern this mapping applies to (glob or prefix match) */
    urlPattern: z.string().min(1),
    /** Optional tool name to restrict this mapping to a specific tool */
    toolName: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.injectionType === "custom_header" || data.injectionType === "query_param") {
        return typeof data.injectionKey === "string" && data.injectionKey.length > 0;
      }
      return true;
    },
    {
      message: "injectionKey is required for custom_header and query_param injection types",
      path: ["injectionKey"],
    },
  );

export type CredentialMapping = z.infer<typeof CredentialMappingSchema>;

/**
 * Parse unknown input into a CredentialMapping, returning Result<T, Error>.
 *
 * Uses Zod .safeParse() and wraps the result in the shared Result type.
 * Refinement errors (missing injectionKey for custom_header/query_param)
 * are included in the ZodError issues array.
 */
export function parseCredentialMapping(input: unknown): Result<CredentialMapping, z.ZodError> {
  const result = CredentialMappingSchema.safeParse(input);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}
