// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";

/** Allows horizontal tab and line breaks while rejecting other ASCII controls. */
export function isMcpInstructionTextSafe(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return false;
    }
  }
  return true;
}

/** Attributed server-authored prose that is always lower-trust than operator policy. */
export const McpInstructionBlockSchema = z.strictObject({
  serverId: z.string().trim().min(1).max(128),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine(isMcpInstructionTextSafe, {
      message: "instructions contain disallowed control characters",
    }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  trust: z.literal("external"),
});

export type McpInstructionBlock = z.infer<typeof McpInstructionBlockSchema>;

export function parseMcpInstructionBlock(
  raw: unknown,
): Result<McpInstructionBlock, z.ZodError> {
  const parsed = McpInstructionBlockSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}
