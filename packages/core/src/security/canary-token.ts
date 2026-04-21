// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";

/**
 * Generate a deterministic canary token for a session.
 *
 * Uses HMAC-SHA256 so the same session always produces the same canary.
 * This survives prompt reassembly and compaction (system prompt is
 * rebuilt each invocation via assembleRichSystemPrompt).
 *
 * @param sessionKey - The session key (tenantId:userId:channelId)
 * @param secret - A stable secret (e.g., from config security.canarySecret)
 * @returns A canary token string like "CTKN_<16 hex chars>"
 */
export function generateCanaryToken(sessionKey: string, secret: string): string {
  const hmac = createHmac("sha256", secret)
    .update(`canary:${sessionKey}`)
    .digest("hex")
    .slice(0, 16);
  return `CTKN_${hmac}`;
}

/**
 * Check if an LLM response contains the canary token (leakage detection).
 *
 * @returns true if the canary was found in the response (BAD -- leakage detected)
 */
export function detectCanaryLeakage(response: string, canaryToken: string): boolean {
  return response.includes(canaryToken);
}
