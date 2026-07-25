// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { PrincipalMappingSchema } from "../domain/principal-resolver.js";

export const IdentityConfigSchema = z.strictObject({
  principalMappings: z.array(PrincipalMappingSchema).default([]),
});

export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
