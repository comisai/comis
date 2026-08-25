// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ManagedRunContentDbRowSchema = z.strictObject({
  tenant_id: z.string(),
  agent_id: z.string(),
  managed_run_id: z.string(),
  content_ref: z.string(),
  kind: z.enum(["activation", "report", "evidence", "attention"]),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  byte_length: z.number().int().nonnegative(),
  relative_path: z.string().regex(/^[a-f0-9]{64}\/[a-f0-9]{64}\.body$/),
  expires_at_ms: z.number().int().nonnegative().nullable(),
  created_at_ms: z.number().int().nonnegative(),
});

export type ManagedRunContentDbRow = z.infer<typeof ManagedRunContentDbRowSchema>;
