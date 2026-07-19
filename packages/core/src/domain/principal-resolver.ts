// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import { PlatformPrincipalAssertionSchema } from "./conversation-scope.js";
import type { PrincipalResolverPort } from "../ports/principal-resolver.js";
import { PrincipalResolutionError } from "./principal-resolution-error.js";
export { PrincipalResolutionError } from "./principal-resolution-error.js";

export const PrincipalMappingSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  assertion: PlatformPrincipalAssertionSchema,
  principalId: z.string().min(1),
});
export type PrincipalMapping = z.infer<typeof PrincipalMappingSchema>;

function key(fields: readonly string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`).join("");
}

export function createPrincipalResolver(
  rawMappings: readonly unknown[],
): Result<PrincipalResolverPort, PrincipalResolutionError> {
  const mappings = z.array(PrincipalMappingSchema).safeParse(rawMappings);
  if (!mappings.success) return err(new PrincipalResolutionError("Invalid principal mapping configuration"));
  const configured = new Map<string, string>();
  for (const mapping of mappings.data) {
    const mappingKey = key([
      mapping.tenantId,
      mapping.agentId,
      mapping.assertion.channelType,
      mapping.assertion.channelInstanceId,
      mapping.assertion.platformSubjectId,
    ]);
    const incumbent = configured.get(mappingKey);
    if (incumbent !== undefined && incumbent !== mapping.principalId) {
      return err(new PrincipalResolutionError("Conflicting principal mappings for one platform assertion"));
    }
    configured.set(mappingKey, mapping.principalId);
  }

  return ok({
    resolve(tenantId, agentId, assertion) {
      const parsed = PlatformPrincipalAssertionSchema.safeParse(assertion);
      if (!tenantId || !agentId || !parsed.success) {
        return err(new PrincipalResolutionError("Principal resolution requires validated tenant, agent, and assertion"));
      }
      const assertionKey = key([
        tenantId,
        agentId,
        parsed.data.channelType,
        parsed.data.channelInstanceId,
        parsed.data.platformSubjectId,
      ]);
      const mapped = configured.get(assertionKey);
      if (mapped !== undefined) return ok({ principalId: mapped });
      const digest = createHash("sha256").update(assertionKey, "utf8").digest("base64url");
      return ok({ principalId: `platform_${digest}` });
    },
  });
}
