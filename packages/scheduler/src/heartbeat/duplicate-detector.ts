// SPDX-License-Identifier: Apache-2.0
/** Process-lifetime duplicate evidence recorded only after possible user visibility. */
import { createHash } from "node:crypto";
import {
  ChannelEndpointSchema,
  type ChannelEndpoint,
  type ClockPort,
} from "@comis/core";

const DUPLICATE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_DUPLICATE_ENTRIES = 500;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 64 * 1024;

export interface HeartbeatDuplicateCandidate {
  readonly agentId: string;
  readonly destinationEndpoint: ChannelEndpoint;
  readonly text: string;
}

export interface DuplicateDetector {
  /** Pure check: never records rejected or merely attempted delivery. */
  check(candidate: HeartbeatDuplicateCandidate): boolean;
  /** Record only accepted, partial, unknown, or otherwise possibly visible text. */
  recordPossiblyVisible(candidate: HeartbeatDuplicateCandidate): void;
  clear(): void;
}

export function createDuplicateDetector(deps: { clock: ClockPort }): DuplicateDetector {
  const seen = new Map<string, number>();

  function check(candidate: HeartbeatDuplicateCandidate): boolean {
    const key = candidateKey(candidate);
    if (key === undefined) return false;
    const nowMs = deps.clock.now();
    pruneExpired(nowMs);
    const recordedAtMs = seen.get(key);
    return recordedAtMs !== undefined && nowMs - recordedAtMs < DUPLICATE_TTL_MS;
  }

  function recordPossiblyVisible(candidate: HeartbeatDuplicateCandidate): void {
    const key = candidateKey(candidate);
    if (key === undefined) return;
    const nowMs = deps.clock.now();
    pruneExpired(nowMs);
    seen.delete(key);
    while (seen.size >= MAX_DUPLICATE_ENTRIES) {
      const oldest = seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    seen.set(key, nowMs);
  }

  function pruneExpired(nowMs: number): void {
    for (const [key, recordedAtMs] of seen) {
      if (nowMs - recordedAtMs >= DUPLICATE_TTL_MS) seen.delete(key);
    }
  }

  return { check, recordPossiblyVisible, clear: () => seen.clear() };
}

function candidateKey(candidate: HeartbeatDuplicateCandidate): string | undefined {
  const endpoint = ChannelEndpointSchema.safeParse(candidate.destinationEndpoint);
  if (
    !endpoint.success
    || !byteBounded(candidate.agentId, MAX_IDENTIFIER_BYTES)
    || !byteBounded(candidate.text, MAX_TEXT_BYTES)
  ) return undefined;
  const value = endpoint.data;
  const textDigest = createHash("sha256").update(candidate.text, "utf8").digest("hex");
  return [
    "heartbeat-duplicate-v1",
    candidate.agentId,
    value.channelType,
    value.channelInstanceId,
    value.conversationId,
    value.threadId === undefined ? "thread:absent" : `thread:present:${value.threadId}`,
    value.conversationKind,
    textDigest,
  ].map(lengthDelimited).join("");
}

function byteBounded(value: string, maxBytes: number): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes > 0 && bytes <= maxBytes;
}

function lengthDelimited(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
