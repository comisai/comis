// SPDX-License-Identifier: Apache-2.0
/**
 * The offline DIRECTIONAL relationship builder job (Phase 108 — SOCIAL-01, Track E2).
 *
 * PLACEHOLDER STUB (Task 1 GREEN scaffolding): the type surface exists so the
 * prompt/parser parser-block tests can compile + pass in isolation. The real
 * {@link runRelationshipBuild} behavior (gate → external-exclude → bound → injected
 * build() → validateMemoryWrite → upsert → counts-only event → idempotent) lands in
 * Task 2.
 *
 * @module
 */

import { ok, type Result } from "@comis/shared";
import type {
  RelationshipStore,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import { type RelationshipBuildOutput } from "./memory-relationship-prompt.js";

/**
 * One high-trust source memory the builder distills directional edges from. Carries
 * `userId` (WHO said it = the SUBJECT candidate, RQ3). `trustLevel` is the FULL
 * ladder so the job can EXCLUDE `external` before the build (anti-poisoning).
 */
export interface RelationshipSourceMemory {
  /** The source memory id (provenance + the idempotency key set). */
  id: string;
  /** The speaker who produced the memory (the subject candidate; sender-prefixed into sourceText). */
  userId?: string;
  /** The source text the build seam distills (conversation-derived). */
  content: string;
  /** The source's trust — `external` is filtered out BEFORE the build. */
  trustLevel: "system" | "learned" | "external";
}

/** Configuration for one offline relationship-build run. */
export interface MemoryRelationshipConfig {
  enabled: boolean;
  maxEntriesPerRun: number;
  maxSourceMemories?: number;
  maxSourceChars?: number;
}

/** Dependencies injected into the offline relationship-build handler. */
export interface MemoryRelationshipDeps {
  agentId: string;
  tenantId: string;
  channelId: string;
  config: MemoryRelationshipConfig;
  relationshipStore: RelationshipStore;
  readSources: () => Promise<Result<RelationshipSourceMemory[], Error>>;
  clock: ClockPort;
  logger: ComisLogger;
  eventBus?: { emit(event: string, payload: unknown): void };
  build: (sourceText: string) => Promise<RelationshipBuildOutput>;
}

/** Counts-only outcome of one build run (never carries the relationship content). */
export interface MemoryRelationshipStats {
  built: number;
  written: number;
  blocked: number;
  skippedOverCap: number;
  sourcesConsidered: number;
  sourcesUsed: number;
  sourcesTruncated: boolean;
}

export type MemoryRelationshipResult = Result<MemoryRelationshipStats, Error>;

/** PLACEHOLDER — Task 2 implements the real builder. */
export async function runRelationshipBuild(
  _deps: MemoryRelationshipDeps,
): Promise<MemoryRelationshipResult> {
  return ok({
    built: 0,
    written: 0,
    blocked: 0,
    skippedOverCap: 0,
    sourcesConsidered: 0,
    sourcesUsed: 0,
    sourcesTruncated: false,
  });
}
