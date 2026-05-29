// SPDX-License-Identifier: Apache-2.0
/**
 * Memory review job handler: periodic extraction of user preferences from session histories.
 *
 * Runs as a background job (wired to CronScheduler in daemon). Reviews sessions updated
 * since the last watermark, batches them into a single cheap-model LLM call via completeSimple,
 * deduplicates against existing memories via MemoryPort.search, and persists new findings.
 *
 * Key design decisions:
 * - Uses completeSimple (not executor/agentic loop) for cost efficiency
 * - Batches multiple sessions into one LLM call
 * - Atomic watermark persistence via temp+rename pattern
 * - Dedup via semantic similarity search before storing
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import { safePath, systemDateFrom, systemSetTimeout, systemClearTimeout, validateMemoryWrite } from "@comis/core";
import type { MemoryReviewConfig } from "@comis/core";
import type { MemoryPort, MemorySearchOptions } from "@comis/core";
import type { MemoryEntry, MemorySource, TrustLevel, ClockPort } from "@comis/core";
import type { SessionData, SessionKey } from "@comis/core";
import { STRUCTURED_PROMPT, parseExtractionResult, resolveOccurredAt } from "./memory-extraction.js";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Session detail entry shape (matches SessionStorePort.listDetailed output). */
export interface SessionDetailedEntry {
  sessionKey: string;
  tenantId: string;
  userId: string;
  channelId: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Dependencies injected into the memory review handler. */
export interface MemoryReviewDeps {
  agentId: string;
  tenantId: string;
  agentName: string;
  config: MemoryReviewConfig;
  memoryPort: MemoryPort;
  sessionStore: {
    listDetailed(tenantId?: string): SessionDetailedEntry[];
    loadByFormattedKey(sessionKey: string): SessionData | undefined;
  };
  eventBus: { emit(event: string, payload: unknown): void };
  workspacePath: string;
  provider: string;
  modelId: string;
  apiKey: string;
  /**
   * Wall-clock reads — the relative-date RESOLUTION reference + each stored
   * entry's `createdAt`/event timestamps. Never `Date.now()` (globals rule);
   * Plan 04 wires the daemon's `createSystemClock()` adapter here.
   */
  clock: ClockPort;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReviewWatermark {
  /** Map of sessionKey -> last reviewed updatedAt timestamp */
  sessions: Record<string, number>;
}

/**
 * An extracted memory paired with its emitted entity mentions (Phase 82, EXTR-04 / Q4b).
 *
 * Entities are EMITTED on this in-memory result carrying the stored memory's
 * inherited trust + provenance — they are NOT persisted (no entity table exists
 * until Phase 83). `memoryId` is the link target Phase 83's resolver consumes.
 */
interface ExtractedMemoryWithEntities {
  memoryId: string;
  entities: { name: string; trustLevel: TrustLevel; source: MemorySource }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Watermark helpers
// ---------------------------------------------------------------------------

async function loadWatermark(watermarkPath: string): Promise<ReviewWatermark> {
  try {
    const raw = await readFile(watermarkPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions) {
      return parsed as ReviewWatermark;
    }
  } catch {
    // File not found or invalid JSON -- start fresh
  }
  return { sessions: {} };
}

async function saveWatermark(watermarkPath: string, watermark: ReviewWatermark): Promise<Result<void, Error>> {
  const tmpPath = `${watermarkPath}.tmp`;
  // fs-safe-allowed: watermarkPath is caller-supplied (per-agent memory state); not under ~/.comis/ directly
  const writeResult = await fromPromise(writeFile(tmpPath, JSON.stringify(watermark, null, 2), "utf-8"));
  if (!writeResult.ok) return err(writeResult.error);
  const renameResult = await fromPromise(rename(tmpPath, watermarkPath));
  if (!renameResult.ok) return err(renameResult.error);
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Session filtering
// ---------------------------------------------------------------------------

function filterSessions(
  sessions: SessionDetailedEntry[],
  config: MemoryReviewConfig,
  watermark: ReviewWatermark,
): SessionDetailedEntry[] {
  // Session keys do not carry an `agent:<agentId>:` prefix, so there is no
  // per-agent prefix filter. Memory review iterates every session in the
  // agent's tenant (the caller passes `tenantId` to
  // `sessionStore.listDetailed`); per-agent isolation is handled by the
  // per-agent workspace-scoped watermark file
  // (`safePath(workspacePath, ".memory-review-watermark")`).
  return sessions
    .filter((s) => {
      // Skip sessions below minMessages threshold
      if (s.messageCount < config.minMessages) return false;

      // Skip sessions not updated since last watermark
      const lastReviewed = watermark.sessions[s.sessionKey] ?? 0;
      if (s.updatedAt <= lastReviewed) return false;

      return true;
    })
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, config.maxSessionsPerRun);
}

// ---------------------------------------------------------------------------
// Message extraction helpers
// ---------------------------------------------------------------------------

function extractMessageContent(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  const role = m.role as string ?? "unknown";
  const content = typeof m.content === "string" ? m.content : "";
  return `[${role}]: ${content}`;
}

function buildSessionSummary(
  sessionKey: string,
  messageCount: number,
  updatedAt: number,
  messages: unknown[],
): string {
  const isoDate = systemDateFrom(updatedAt).toISOString();
  let lines = `=== Session: ${sessionKey} (messages: ${messageCount}, updated: ${isoDate}) ===\n`;

  if (messages.length <= 20) {
    for (const msg of messages) {
      lines += extractMessageContent(msg) + "\n";
    }
  } else {
    // First 10 and last 10
    for (let i = 0; i < 10; i++) {
      lines += extractMessageContent(messages[i]) + "\n";
    }
    lines += `... (${messages.length - 20} messages omitted) ...\n`;
    for (let i = messages.length - 10; i < messages.length; i++) {
      lines += extractMessageContent(messages[i]) + "\n";
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

function extractResponseText(response: { content?: unknown[] }): string {
  let text = "";
  if (response.content && Array.isArray(response.content)) {
    for (const part of response.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as Record<string, unknown>).type === "text" &&
        "text" in part
      ) {
        text += (part as Record<string, unknown>).text;
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run periodic memory review for a single agent.
 *
 * Scans sessions updated since last watermark, batches them into a single
 * cheap-model LLM call, then parses the LLM output into zod-validated STRUCTURED
 * memories (`{ content, occurredAt?, entities[] }`, Phase 82 / EXTR-01..05),
 * resolves each `occurredAt` via the injected clock, deduplicates, and stores
 * new findings (content + occurredAt only) via MemoryPort. Entity mentions are
 * EMITTED (not persisted — Q4b). Malformed output is non-fatal: the watermark
 * advances and the run returns ok (EXTR-05).
 *
 * @param deps - Injected dependencies (memoryPort, sessionStore, eventBus, clock, LLM config, etc.)
 * @returns Result<void, Error> -- ok on success (even if 0 memories extracted), err on fatal failure
 */
export async function runMemoryReview(deps: MemoryReviewDeps): Promise<Result<void, Error>> {
  const { config, agentId, tenantId, memoryPort, sessionStore, eventBus, logger, clock } = deps;
  const startTime = clock.now();

  // Load watermark
  const watermarkPath = safePath(deps.workspacePath, ".memory-review-watermark");
  const watermark = await loadWatermark(watermarkPath);

  // List and filter sessions
  const allSessions = sessionStore.listDetailed(tenantId);
  const qualifyingSessions = filterSessions(allSessions, config, watermark);

  logger.debug({ agentId, totalSessions: allSessions.length, qualifying: qualifyingSessions.length }, "Memory review session filtering complete");

  // Early exit if nothing to review
  if (qualifyingSessions.length === 0) {
    eventBus.emit("memory:review_completed", {
      agentId,
      sessionsReviewed: 0,
      memoriesExtracted: 0,
      duplicatesSkipped: 0,
      durationMs: clock.now() - startTime,
      timestamp: clock.now(),
    });
    return ok(undefined);
  }

  // Build batch prompt
  const maxChars = config.maxReviewTokens * 4; // ~4 chars per token
  let batchContent = "Sessions to review:\n\n";
  const reviewedSessions: SessionDetailedEntry[] = [];

  for (const session of qualifyingSessions) {
    const data = sessionStore.loadByFormattedKey(session.sessionKey);
    const messages = data?.messages ?? [];
    const summary = buildSessionSummary(
      session.sessionKey,
      session.messageCount,
      session.updatedAt,
      messages,
    );

    if (batchContent.length + summary.length > maxChars) {
      logger.debug({ agentId, sessionKey: session.sessionKey }, "Skipping session -- batch token budget exceeded");
      break;
    }

    batchContent += summary + "\n";
    reviewedSessions.push(session);
  }

  if (reviewedSessions.length === 0) {
    eventBus.emit("memory:review_completed", {
      agentId,
      sessionsReviewed: 0,
      memoriesExtracted: 0,
      duplicatesSkipped: 0,
      durationMs: clock.now() - startTime,
      timestamp: clock.now(),
    });
    return ok(undefined);
  }

  // Call LLM via completeSimple
  let model;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider/modelId are dynamic strings
    model = getModel(deps.provider as any, deps.modelId as any);
  } catch (modelErr) {
    return err(new Error(`Failed to resolve model ${deps.provider}/${deps.modelId}: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`));
  }

  if (!model) {
    return err(new Error(`Model not found: ${deps.provider}/${deps.modelId}`));
  }

  const controller = new AbortController();
  const timer = systemSetTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let responseText: string;
  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: STRUCTURED_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: batchContent,
            timestamp: clock.now(),
          },
        ],
      },
      {
        apiKey: deps.apiKey,
        temperature: 0.3,
        maxTokens: config.maxReviewTokens,
        signal: controller.signal,
      },
    );

    responseText = extractResponseText(response);
  } catch (llmErr) {
    systemClearTimeout(timer);
    return err(new Error(`Memory review LLM call failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`));
  } finally {
    systemClearTimeout(timer);
  }

  // Parse LLM response into the zod-validated structured envelope. A total
  // parser (Plan 02): undefined on ANY whole-payload failure (bad JSON, schema
  // mismatch, or the DELETED flat `[{content, session}]` shape — there is NO
  // fallback to the old path, design principle 8).
  const extraction = parseExtractionResult(responseText);
  if (!extraction) {
    // EXTR-05 (whole-batch non-fatal): warn + advance the watermark for EVERY
    // reviewed session BEFORE returning ok, so a malformed batch never stalls
    // (Pitfall 4). errorKind + hint are the canonical structured fields.
    logger.warn(
      {
        agentId,
        responseLength: responseText.length,
        errorKind: "validation" as const,
        hint: "LLM extraction output failed schema validation — skipping batch, advancing watermark",
      },
      "Structured extraction returned invalid output, skipping",
    );
    for (const session of reviewedSessions) {
      watermark.sessions[session.sessionKey] = session.updatedAt;
    }
    await saveWatermark(watermarkPath, watermark);
    eventBus.emit("memory:review_completed", {
      agentId,
      sessionsReviewed: reviewedSessions.length,
      memoriesExtracted: 0,
      duplicatesSkipped: 0,
      durationMs: clock.now() - startTime,
      timestamp: clock.now(),
    });
    return ok(undefined);
  }

  // The fixed review session key — structured memories carry no per-message
  // `session` field, so dedup search/store scope to one review-owned key.
  const reviewSessionKey: SessionKey = {
    tenantId,
    userId: "system",
    channelId: "memory-review",
  };
  const searchOpts: MemorySearchOptions = {
    limit: 1,
    minScore: config.dedupThreshold,
    trustLevel: "system",
    tags: ["auto-review"],
    agentId,
  };

  // Dedup, validate, and store each structured memory.
  let memoriesExtracted = 0;
  let duplicatesSkipped = 0;
  const extractedEntities: ExtractedMemoryWithEntities[] = [];

  for (const m of extraction.memories) {
    // Per-item resilience (EXTR-05): a single bad memory must `continue`, never
    // abort the batch. The lenient schema already guarantees content.min(1),
    // but guard defensively.
    if (!m.content) continue;

    // SECURITY (AGENTS.md §2.2, ASVS V5): the extracted `content` is derived
    // from untrusted conversation text. Scan it BEFORE store. `critical`
    // (dangerous-command / secret-egress patterns) → skip the item; `warn`
    // (jailbreak/role patterns) → store with trust downgraded to "external";
    // `clean` → the inherited `system` trust (EXTR-04). T-82-07 mitigation.
    const verdict = validateMemoryWrite(m.content);
    if (verdict.severity === "critical") {
      // WR-02: the audit record for a security-blocking event must carry the
      // COMPLETE matched-pattern set, not just the critical subset. The previous
      // code logged the value `verdict.criticalPatterns` under the misleading
      // field name `patterns`, silently dropping the broader `verdict.patterns`
      // (for a dangerous-command match that set includes every matched pattern).
      // Log both, each under its accurate name. Never log the offending content.
      logger.warn(
        {
          agentId,
          errorKind: "security" as const,
          patterns: verdict.patterns,
          criticalPatterns: verdict.criticalPatterns,
          hint: "extracted memory matched a dangerous/secret pattern — blocked from store",
        },
        "Skipping extracted memory that failed the memory-write security scan",
      );
      continue;
    }
    const trustLevel: TrustLevel = verdict.severity === "warn" ? "external" : "system";

    // Dedup check (reused — scoped to the review session key + system trust).
    // WR-01: MemoryPort returns Promise<Result<…>> (non-throwing), but a real
    // adapter can VIOLATE the contract and REJECT (SQLITE_BUSY on a locked DB,
    // disk-full, a better-sqlite3 throw surfaced async). Route through
    // `fromPromise` so a rejection becomes an `err` Result instead of an
    // exception escaping `runMemoryReview` before the watermark saves — which
    // would reprocess the same sessions every cron tick (the EXTR-05 stall).
    const searchOutcome = await fromPromise(memoryPort.search(reviewSessionKey, m.content, searchOpts));
    if (!searchOutcome.ok) {
      // Dedup unavailable (adapter rejected) — skip this item rather than store
      // blind (we can't confirm it isn't a duplicate). Non-fatal: the loop and
      // the watermark advance continue. errorKind + hint are the canonical fields.
      logger.warn(
        {
          agentId,
          err: searchOutcome.error,
          errorKind: "io" as const,
          hint: "memory dedup search rejected (adapter contract violation) — skipping item, advancing watermark",
        },
        "Skipping extracted memory — dedup search failed",
      );
      continue;
    }
    const searchResult = searchOutcome.value;
    if (searchResult.ok && searchResult.value.length > 0) {
      duplicatesSkipped++;
      logger.debug({ agentId, content: m.content.slice(0, 50) }, "Skipping duplicate memory");
      continue;
    }

    // Resolve the LLM's ISO event time → epoch ms against the injected clock
    // (EXTR-02); undefined → omit the key (falls back to createdAt per TEMP-01).
    const occurredAt = resolveOccurredAt(m.occurredAt, clock.now());

    // Store ONLY content + occurredAt. Trust + provenance inherit one consistent
    // value (EXTR-04); NO `entities` field is persisted (Q4b — the strict
    // MemoryRowSchema has no entity column; entities are emit-only below).
    const memorySource: MemorySource = { who: "system", channel: "memory-review" };
    const entry: MemoryEntry = {
      id: randomUUID(),
      tenantId,
      agentId,
      userId: "system",
      content: m.content,
      trustLevel,
      source: memorySource,
      tags: ["auto-review", ...config.autoTags],
      sourceType: "conversation",
      createdAt: clock.now(),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    };

    // WR-01: same contract-violation guard as the dedup search above — a
    // rejecting `store` (locked DB, disk-full) must NOT escape before the
    // watermark saves. `fromPromise` collapses a rejection into an `err` that
    // the existing non-fatal branch logs; the loop and watermark advance survive.
    const storeOutcome = await fromPromise(memoryPort.store(entry));
    const storeResult = storeOutcome.ok ? storeOutcome.value : storeOutcome;
    if (storeResult.ok) {
      memoriesExtracted++;
      // EXTR-04 / Q4b: emit the entity mentions on the in-memory result with the
      // SAME inherited trust + provenance. NOT persisted — for the Phase-83 handoff.
      extractedEntities.push({
        memoryId: entry.id,
        entities: m.entities.map((e) => ({ name: e.name, trustLevel, source: memorySource })),
      });
    } else {
      logger.warn(
        {
          agentId,
          err: storeResult.error,
          errorKind: "io" as const,
          hint: "memory store failed/rejected — skipping item, advancing watermark",
        },
        "Failed to store extracted memory",
      );
    }
  }

  const entitiesExtracted = extractedEntities.reduce((n, e) => n + e.entities.length, 0);

  // Update watermark per-session (success path — runs on every terminating path).
  for (const session of reviewedSessions) {
    watermark.sessions[session.sessionKey] = session.updatedAt;
  }
  await saveWatermark(watermarkPath, watermark);

  // Emit completion event (entitiesExtracted is additive/harmless — Open Q Q3).
  eventBus.emit("memory:review_completed", {
    agentId,
    sessionsReviewed: reviewedSessions.length,
    memoriesExtracted,
    duplicatesSkipped,
    entitiesExtracted,
    durationMs: clock.now() - startTime,
    timestamp: clock.now(),
  });

  logger.info({
    agentId,
    sessionsReviewed: reviewedSessions.length,
    memoriesExtracted,
    duplicatesSkipped,
    entitiesExtracted,
    durationMs: clock.now() - startTime,
  }, "Memory review completed");

  return ok(undefined);
}
