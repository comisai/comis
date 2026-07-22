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
import { createMemoryRecallScope, safePath, systemDateFrom, systemSetTimeout, systemClearTimeout, validateMemoryWrite } from "@comis/core";
import type { MemoryReviewConfig } from "@comis/core";
import { resolveMemoryOpsStrategy } from "./memory-capability-router.js";
import type { CapabilityClass } from "../executor/model-profile.js";
import type { MemoryPort, MemorySearchOptions, MemoryWriteEntry, MemoryWriteScope } from "@comis/core";
// The SEGREGATED entity-store port — imported as a TYPE ONLY.
// The concrete adapter lives in the memory package; the agent↛memory build cut
// forbids importing that package here (architecture-graph.test.ts). The daemon
// injects the adapter through `MemoryReviewDeps.entityStore`.
// The SEGREGATED causal-store port — likewise TYPE ONLY.
// The agent reaches it as a @comis/core port type (NEVER `@comis/memory`); the
// daemon injects the concrete adapter via `MemoryReviewDeps.causalStore`.
import type { MemoryEntityStore, MemoryCausalStore } from "@comis/core";
import type { MemorySource, TrustLevel, ClockPort } from "@comis/core";
import type { ConversationRef, SessionQueryScope, SessionStoreError } from "@comis/core";
import { STRUCTURED_PROMPT, parseExtractionResult, resolveOccurredAt } from "./memory-extraction.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { resolveJudgeModel, temperatureOption, type CustomCompletionsModelSpec } from "./judge-model-resolver.js";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies injected into the memory review handler. */
export interface MemoryReviewDeps {
  agentId: string;
  tenantId: string;
  agentName: string;
  config: MemoryReviewConfig;
  memoryPort: MemoryPort;
  /** Pre-resolved authority for this background service's memory reads and writes. */
  memoryScope: MemoryWriteScope;
  /**
   * OPTIONAL entity-associative store. When injected, each
   * memory's emitted entity mentions are resolved + linked AFTER a successful
   * store, populating `memory_entities` / `memory_entity_links`. When ABSENT,
   * the job behaves as if no entity store were wired (entities are emit-only, not
   * persisted) — so the daemon can light this up independently. A link failure
   * is NON-FATAL (mirrors the store/search guards): the watermark still
   * advances, so a resolver fault never stalls + reprocesses every cron tick.
   */
  entityStore?: MemoryEntityStore;
  /**
   * OPTIONAL causal-edge store. When injected, each
   * memory's emitted `causes` are persisted AFTER a successful store as directed
   * cause→effect edges (`linkCausal(entry.id, effect, scope, confidence)`),
   * populating `memory_causal_edges`. When ABSENT, the job behaves as if no causal
   * store were wired (causes are emit-only, not persisted) — so the daemon can
   * light this up independently. Injected as the @comis/core port TYPE (the
   * agent↛memory cut: the concrete adapter is daemon-built). A link failure is
   * NON-FATAL (mirrors the entity-store guard): the watermark still advances, so
   * an edge-resolver fault never stalls + reprocesses every cron tick.
   */
  causalStore?: MemoryCausalStore;
  sessionStore: {
    listDetailed(scope: SessionQueryScope): Result<MemoryReviewSessionEntry[], SessionStoreError>;
    loadByRef(scope: SessionQueryScope, conversationRef: ConversationRef): Result<MemoryReviewSessionData | undefined, SessionStoreError>;
  };
  eventBus: { emit(event: string, payload: unknown): void };
  workspacePath: string;
  provider: string;
  modelId: string;
  apiKey?: string;
  /** Provider-scoped configuration for native model authentication; never logged. */
  providerEnv?: Record<string, string>;
  /** Scheduler-owned cancellation for the whole review occurrence. */
  signal?: AbortSignal;
  /** Exact usage sink for background-run budget and billing attribution. */
  onUsage?: (usage: MemoryReviewLlmUsage) => void;
  customModel?: CustomCompletionsModelSpec; // keyless/local model spec so a YAML provider resolves (#223)
  /** Wall-clock reads — relative-date RESOLUTION ref + stored-entry timestamps. Never `Date.now()` (globals); daemon wires `createSystemClock()`. */
  clock: ClockPort;
  logger: ReviewLogger;
  /**
   * The capability class of the agent's model (from ModelProfile.capabilityClass).
   * When small/nano without a capable override, extraction is skipped — no LLM call
   * is made and the watermark advances (a weak model fabricates memories rather
   * than extracting them, so abstaining is safer than storing invented facts).
   * Optional: defaults to "frontier" behavior (capable) when absent.
   */
  capabilityClass?: CapabilityClass;
  /**
   * Operator override — a stronger cheap model is configured for the memory
   * pipeline. When true, small/nano are treated as capable for extraction.
   * Optional; defaults to false.
   */
  hasCapableModelOverride?: boolean;
}

export interface MemoryReviewLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Minimal ref-authorized transcript metadata consumed by the review job. */
export interface MemoryReviewSessionEntry {
  conversationRef: ConversationRef;
  tenantId: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Minimal transcript payload consumed by the review job. */
export interface MemoryReviewSessionData {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * The structural logger contract this job needs (a subset of `ComisLogger`).
 * `child(bindings)` returns the SAME shape so a `submodule`-scoped child logger
 * carries the canonical stage logs (AGENTS.md §2.7 contract vs impl).
 */
interface ReviewLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): ReviewLogger;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReviewWatermark {
  /** Map of sessionKey -> last reviewed updatedAt timestamp */
  sessions: Record<string, number>;
}

/**
 * An extracted memory paired with its emitted entity mentions.
 *
 * Entities are EMITTED on this in-memory result carrying the stored memory's
 * inherited trust + provenance — persistence happens separately via the optional
 * injected `entityStore`. `memoryId` is the link target the entity resolver consumes.
 */
interface ExtractedMemoryWithEntities {
  memoryId: string;
  entities: { name: string; trustLevel: TrustLevel; source: MemorySource }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 120_000;

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

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
  sessions: MemoryReviewSessionEntry[],
  config: MemoryReviewConfig,
  watermark: ReviewWatermark,
): MemoryReviewSessionEntry[] {
  // The store query is already constrained by the explicit tenant-agent
  // authority. The workspace-scoped watermark only records progress; it does
  // not participate in authorization.
  return sessions
    .filter((s) => {
      // Skip sessions below minMessages threshold
      if (s.messageCount < config.minMessages) return false;

      // Skip sessions not updated since last watermark
      const lastReviewed = watermark.sessions[s.conversationRef] ?? 0;
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
  // Modern message content is frequently an array of blocks
  // ([{type:"text",text:"..."}, {type:"tool_use",...}]). Concatenate the text
  // blocks (and skip non-text blocks) instead of collapsing the whole turn to
  // "[role]: " — otherwise the extraction LLM silently sees a biased subset
  // (string-only turns), so memories are extracted from an incomplete picture.
  // Mirrors the extractResponseText helper below.
  let content = "";
  if (typeof m.content === "string") {
    content = m.content;
  } else if (Array.isArray(m.content)) {
    content = m.content
      .filter((b) => (b as { type?: string } | null)?.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join(" ");
  }
  return `[${role}]: ${content}`;
}

/** Per-message char cap in a session summary. Without it, one multi-thousand-char
 *  essay message can push a whole conversation past the batch budget → the session
 *  is skipped entirely AND, unwatermarked, re-skipped every run. Facts live in turn
 *  heads; an essay tail adds tokens, not extractable facts. */
const PER_MESSAGE_SUMMARY_MAX_CHARS = 500;

function capMessageLine(msg: unknown): string {
  const line = extractMessageContent(msg);
  return line.length > PER_MESSAGE_SUMMARY_MAX_CHARS
    ? line.slice(0, PER_MESSAGE_SUMMARY_MAX_CHARS - 1) + "…"
    : line;
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
      lines += capMessageLine(msg) + "\n";
    }
  } else {
    // First 10 and last 10
    for (let i = 0; i < 10; i++) {
      lines += capMessageLine(messages[i]) + "\n";
    }
    lines += `... (${messages.length - 20} messages omitted) ...\n`;
    for (let i = messages.length - 10; i < messages.length; i++) {
      lines += capMessageLine(messages[i]) + "\n";
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
 * memories (`{ content, occurredAt?, entities[] }`),
 * resolves each `occurredAt` via the injected clock, deduplicates, and stores
 * new findings (content + occurredAt only) via MemoryPort. Entity mentions are
 * EMITTED (not persisted). Malformed output is non-fatal: the watermark
 * advances and the run returns ok.
 *
 * @param deps - Injected dependencies (memoryPort, sessionStore, eventBus, clock, LLM config, etc.)
 * @returns Result<void, Error> -- ok on success (even if 0 memories extracted), err on fatal failure
 */
export async function runMemoryReview(deps: MemoryReviewDeps): Promise<Result<void, Error>> {
  const { config, agentId, tenantId, memoryPort, sessionStore, eventBus, logger, clock } = deps;
  if (isAbortRequested(deps.signal)) return err(new Error("Memory review aborted"));
  const startTime = clock.now();
  // Scope the per-stage step logs to a `submodule` child logger so an
  // operator can answer "what did extraction do?" from logs alone (AGENTS.md
  // §2.6/§2.7). The `logger.*` WARN/DEBUG calls keep their byte-identical
  // strings (guarded by the degradation/forensic
  // tests); only the stage INFO lines route through `log`.
  const log = logger.child({ submodule: "memory-review" });

  // Load watermark
  const watermarkPath = safePath(deps.workspacePath, ".memory-review-watermark");
  const watermark = await loadWatermark(watermarkPath);

  // List and filter sessions
  const queryScope = { tenantId, agentId };
  const recallScopeResult = createMemoryRecallScope(deps.memoryScope.turnScope, true);
  if (!recallScopeResult.ok) return recallScopeResult;
  const recallScope = recallScopeResult.value;
  const listed = sessionStore.listDetailed(queryScope);
  if (!listed.ok) {
    logger.error({
      agentId,
      hint: "Inspect session database integrity and retry the memory review after storage recovers",
      errorKind: listed.error.errorKind,
    }, "Memory review session listing failed");
    return err(listed.error);
  }
  const allSessions = listed.value;
  const qualifyingSessions = filterSessions(allSessions, config, watermark);

  // Early-exit counts ride an INFO line so a no-op nightly run is visible at the default log level.
  if (qualifyingSessions.length === 0) {
    log.info(
      { agentId, totalSessions: allSessions.length, qualifying: 0, watermark, step: "early-exit" },
      "Memory review: nothing to review this run",
    );
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
  const reviewedSessions: MemoryReviewSessionEntry[] = [];

  for (const session of qualifyingSessions) {
    const loaded = sessionStore.loadByRef(queryScope, session.conversationRef);
    if (!loaded.ok) {
      logger.error({
        agentId,
        conversationRef: session.conversationRef,
        hint: "Inspect session database integrity and retry the memory review after storage recovers",
        errorKind: loaded.error.errorKind,
      }, "Memory review session load failed");
      return err(loaded.error);
    }
    const messages = loaded.value?.messages ?? [];
    let summary = buildSessionSummary(
      session.conversationRef,
      session.messageCount,
      session.updatedAt,
      messages,
    );

    if (batchContent.length + summary.length > maxChars) {
      // Livelock backstop: a skipped FIRST session stays
      // unwatermarked → re-skipped every run. Truncate-to-fit when a useful
      // budget remains; only a pathological budget skips, and loudly.
      const remaining = maxChars - batchContent.length;
      const MIN_USEFUL_SUMMARY_CHARS = 500;
      if (reviewedSessions.length === 0 && remaining >= MIN_USEFUL_SUMMARY_CHARS) {
        logger.warn(
          { agentId, conversationRef: session.conversationRef, summaryChars: summary.length, budgetChars: remaining, errorKind: "validation" as const, hint: "session summary truncated to the review batch budget — raise memoryReview.maxReviewTokens to review more of it per run" },
          "Session summary exceeds review budget — truncated to fit",
        );
        summary = summary.slice(0, remaining);
      } else {
        if (reviewedSessions.length === 0) {
          logger.warn(
            { agentId, conversationRef: session.conversationRef, summaryChars: summary.length, budgetChars: remaining, errorKind: "config" as const, hint: "memoryReview.maxReviewTokens is too small to review ANY session — this session will be skipped on every run until the budget is raised" },
            "Review budget cannot fit any session summary — skipping",
          );
        } else {
          logger.debug({ agentId, conversationRef: session.conversationRef }, "Skipping session -- batch token budget exceeded");
        }
        break;
      }
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

  // Capability routing: skip the LLM extraction call for small/nano without a
  // capable-model override (a weak model fabricates memories rather than extracting
  // them). Advance the watermark first
  // so this run is not re-processed on the next cron tick (non-stalling abstain).
  const capabilityClass = deps.capabilityClass ?? "frontier";
  const hasCapableModelOverride = deps.hasCapableModelOverride ?? false;
  const memStrategy = resolveMemoryOpsStrategy(capabilityClass, hasCapableModelOverride);
  if (memStrategy === "abstain") {
    logger.warn(
      {
        agentId,
        submodule: "memory-review-job",
        errorKind: "precondition" as const,
        hint: "extraction skipped: capabilityClass requires a capableModel override",
      },
      "memory extraction skipped",
    );
    // Advance watermark for reviewed sessions so we don't reprocess on the next run.
    for (const session of reviewedSessions) {
      watermark.sessions[session.conversationRef] = session.updatedAt;
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

  // Call LLM via completeSimple
  let model;
  try {
    model = resolveJudgeModel(deps.provider, deps.modelId, deps.customModel);
  } catch (modelErr) {
    return err(new Error(`Failed to resolve model ${deps.provider}/${deps.modelId}: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`));
  }

  if (!model) {
    return err(new Error(`Model not found: ${deps.provider}/${deps.modelId}`));
  }

  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(deps.signal?.reason);
  if (isAbortRequested(deps.signal)) controller.abort(deps.signal?.reason);
  else deps.signal?.addEventListener("abort", abortFromCaller, { once: true });
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
        ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }),
        ...(deps.providerEnv === undefined ? {} : { env: deps.providerEnv }),
        ...temperatureOption(model, 0.3),
        maxTokens: config.maxReviewTokens,
        signal: controller.signal,
      },
    );

    if (deps.onUsage !== undefined) {
      try {
        const usage = (response as {
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
          };
        }).usage;
        if (usage !== undefined) {
          deps.onUsage({
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            cacheReadTokens: usage.cacheRead ?? 0,
            cacheWriteTokens: usage.cacheWrite ?? 0,
            cost: {
              input: usage.cost?.input ?? 0,
              output: usage.cost?.output ?? 0,
              cacheRead: usage.cost?.cacheRead ?? 0,
              cacheWrite: usage.cost?.cacheWrite ?? 0,
              total: usage.cost?.total ?? 0,
            },
          });
        }
      } catch {
        // Usage attribution is observational and must not fail the review result.
      }
    }

    responseText = extractResponseText(response);
  } catch (llmErr) {
    systemClearTimeout(timer);
    return err(new Error(`Memory review LLM call failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`));
  } finally {
    systemClearTimeout(timer);
    deps.signal?.removeEventListener("abort", abortFromCaller);
  }
  if (isAbortRequested(deps.signal)) return err(new Error("Memory review aborted"));

  // Parse LLM response into the zod-validated structured envelope. A total
  // parser: undefined on ANY whole-payload failure (bad JSON, schema
  // mismatch, or a flat `[{content, session}]` array — there is NO lenient
  // fallback shape).
  const extraction = parseExtractionResult(responseText);
  if (!extraction) {
    // Whole-batch non-fatal: warn + advance the watermark for EVERY
    // reviewed session BEFORE returning ok, so a malformed batch never stalls.
    // errorKind + hint are the canonical structured fields.
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
      watermark.sessions[session.conversationRef] = session.updatedAt;
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

  // EXTRACT stage: the parse succeeded — report the parsed memory count.
  // O(1)/run boundary line → INFO (per-item store/link detail stays DEBUG).
  log.info(
    { agentId, step: "extract" as const, parsed: extraction.memories.length, durationMs: clock.now() - startTime },
    "extraction parsed",
  );

  // The fixed review session key — structured memories carry no per-message
  // `session` field, so dedup search/store scope to one review-owned key.
  const searchOpts: MemorySearchOptions = {
    limit: 1,
    minScore: config.dedupThreshold,
    trustLevel: "system",
    tags: ["auto-review"],
  };

  // Dedup, validate, and store each structured memory.
  let memoriesExtracted = 0;
  let duplicatesSkipped = 0;
  const extractedEntities: ExtractedMemoryWithEntities[] = [];

  // memory:entities_linked: `entitiesLinked` counts SUCCESSFUL
  // resolveAndLink calls this run; `seenEntityNames` derives `newEntities`.
  // `resolveAndLink` returns only the resolved id — it does NOT signal
  // create-vs-reuse, and adding a port method just to surface that is out of
  // scope. We therefore derive `newEntities` CONSERVATIVELY as the
  // count of DISTINCT entity names first-seen in THIS run (a lower-bound proxy
  // for "minted a fresh row"): the run's first mention of a name is treated as
  // new, recurrences as reuse. Counts only ever leave this function — never a name.
  let entitiesLinked = 0;
  const seenEntityNames = new Set<string>();

  for (const m of extraction.memories) {
    // Per-item resilience: a single bad memory must `continue`, never
    // abort the batch. The lenient schema already guarantees content.min(1),
    // but guard defensively.
    if (!m.content) continue;

    // SECURITY (AGENTS.md §2.2, ASVS V5): the extracted `content` is derived
    // from untrusted conversation text. Scan it BEFORE store. `critical`
    // (dangerous-command / secret-egress patterns) → skip the item; `warn`
    // (jailbreak/role patterns) → store with trust downgraded to "external";
    // `clean` → the inherited `system` trust.
    const verdict = validateMemoryWrite(m.content);
    if (verdict.severity === "critical") {
      // The audit record for a security-blocking event must carry the
      // COMPLETE matched-pattern set, not just the critical subset — for a
      // dangerous-command match `verdict.patterns` includes every matched
      // pattern, and collapsing it to `verdict.criticalPatterns` under one
      // field name would silently drop the broader set.
      // Log both, each under its accurate name. Never log the offending content.
      logger.warn(
        {
          agentId,
          errorKind: "validation" as const,
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
    // MemoryPort returns Promise<Result<…>> (non-throwing), but a real
    // adapter can VIOLATE the contract and REJECT (SQLITE_BUSY on a locked DB,
    // disk-full, a better-sqlite3 throw surfaced async). Route through
    // `fromPromise` so a rejection becomes an `err` Result instead of an
    // exception escaping `runMemoryReview` before the watermark saves — which
    // would reprocess the same sessions every cron tick (the watermark stall).
    const searchOutcome = await fromPromise(memoryPort.search(recallScope, m.content, searchOpts));
    if (!searchOutcome.ok) {
      // Dedup unavailable (adapter rejected) — skip this item rather than store
      // blind (we can't confirm it isn't a duplicate). Non-fatal: the loop and
      // the watermark advance continue. errorKind + hint are the canonical fields.
      logger.warn(
        {
          agentId,
          err: searchOutcome.error,
          errorKind: "dependency" as const,
          hint: "memory dedup search rejected (adapter contract violation) — skipping item, advancing watermark",
        },
        "Skipping extracted memory — dedup search failed",
      );
      continue;
    }
    const searchResult = searchOutcome.value;
    if (searchResult.ok && searchResult.value.length > 0) {
      duplicatesSkipped++;
      logger.debug({ agentId, contentLength: m.content.length }, "Skipping duplicate memory");
      continue;
    }

    // Resolve the LLM's ISO event time → epoch ms against the injected clock;
    // undefined → omit the key (falls back to createdAt).
    const occurredAt = resolveOccurredAt(m.occurredAt, clock.now());

    // Store ONLY content + occurredAt. Trust + provenance inherit one consistent
    // value; NO `entities` field is persisted (the strict
    // MemoryRowSchema has no entity column; entities are emit-only below).
    const memorySource: MemorySource = { who: "system", channel: "memory-review" };
    const entry: MemoryWriteEntry = {
      id: randomUUID(),
      content: m.content,
      trustLevel,
      source: memorySource,
      tags: ["auto-review", ...config.autoTags],
      sourceType: "conversation",
      // Persist the LLM-classified memory class instead of dropping it
      // to the adapter's 'semantic' fallback. `m.memoryType` is ALWAYS present post-parse
      // (StructuredMemorySchema.memoryType has `.default("semantic")`), so the persisted
      // value is the real classification.
      memoryType: m.memoryType,
      createdAt: clock.now(),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    };

    // Same contract-violation guard as the dedup search above — a
    // rejecting `store` (locked DB, disk-full) must NOT escape before the
    // watermark saves. `fromPromise` collapses a rejection into an `err` that
    // the existing non-fatal branch logs; the loop and watermark advance survive.
    const storeOutcome = await fromPromise(memoryPort.store(entry, deps.memoryScope));
    const storeResult = storeOutcome.ok ? storeOutcome.value : storeOutcome;
    if (storeResult.ok) {
      memoriesExtracted++;
      // Emit the entity mentions on the in-memory result with the
      // SAME inherited trust + provenance. NOT persisted — for the entity-link handoff.
      extractedEntities.push({
        memoryId: storeResult.value.id,
        entities: m.entities.map((e) => ({ name: e.name, trustLevel, source: memorySource })),
      });

      // Persist the entity associations — resolve each emitted
      // entity to a (tenant, agent)-scoped entity row and link it to THIS stored
      // memory. The scope (tenantId, agentId) is the stored entry's own partition
      // (isolation enforced at the write side); `now` comes from the
      // injected clock (NEVER the wall-clock global — globals rule). Guarded by
      // `deps.entityStore` so an un-injected port reproduces the no-entity-store behaviour exactly.
      //
      // NON-FATAL (mirrors the store/search guards above): `resolveAndLink`
      // returns Promise<Result<string, Error>>, but a real adapter can REJECT
      // (SQLITE_BUSY on a locked DB, disk-full). `fromPromise` collapses a
      // rejection into an `err` Result; `!linked.ok` then covers the rejection and
      // `!linked.value.ok` an inner-err Result. Either way we log a WARN
      // (errorKind + hint only — NEVER the entity name body, AGENTS.md §2.7) and
      // CONTINUE. No `return err`, no `throw`: the watermark advance below runs
      // unchanged, so a resolver fault can never stall + reprocess every tick.
      if (deps.entityStore) {
        for (const e of m.entities) {
          const linked = await fromPromise(
            deps.entityStore.resolveAndLink(storeResult.value.id, e.name, { tenantId, agentId, now: clock.now() }),
          );
          if (!linked.ok || !linked.value.ok) {
            logger.warn(
              {
                agentId,
                errorKind: "dependency" as const,
                hint: "entity link failed — memory stored, association skipped",
              },
              "Entity resolve/link failed (non-fatal)",
            );
          } else {
            // Counters: a successful resolve+link. `entitiesLinked` is the
            // total (the event's `entityCount`); a name's FIRST appearance this
            // run counts toward `newEntities` (conservative create proxy above).
            entitiesLinked++;
            seenEntityNames.add(e.name);
          }
        }
      }

      // Persist the causal edges. Guarded by
      // `deps.causalStore` so an un-injected port reproduces the no-causal-store behaviour
      // EXACTLY (no write). The cause is THIS stored memory (`entry.id`); each
      // emitted `effect` is resolved to a counterpart memory id by the injected
      // adapter (scoped FTS top-1 — the agent never sees the SQL). NON-FATAL
      // (mirrors the entity guard above): a failing linkCausal — an `err` Result
      // OR a rejecting adapter collapsed by `fromPromise` — WARNs (errorKind +
      // hint only; NEVER the untrusted effect-text body, AGENTS.md §2.7) and the
      // loop continues; the watermark below advances regardless, so an edge fault
      // never stalls + reprocesses every cron tick. The edge SQL lives in
      // @comis/memory behind the injected MemoryCausalStore port — this file
      // imports the TYPE only (the agent↛memory build cut).
      if (deps.causalStore && m.causes.length > 0) {
        for (const c of m.causes) {
          const linked = await fromPromise(
            deps.causalStore.linkCausal(storeResult.value.id, c.effect, { ...recallScope, now: clock.now() }, 1),
          );
          if (!linked.ok || !linked.value.ok) {
            logger.warn(
              {
                agentId,
                errorKind: "dependency" as const,
                hint: "causal link failed — memory stored, edge skipped",
              },
              "Causal link failed (non-fatal)",
            );
          }
        }
      }
    } else {
      logger.warn(
        {
          agentId,
          err: storeResult.error,
          errorKind: "dependency" as const,
          hint: "memory store failed/rejected — skipping item, advancing watermark",
        },
        "Failed to store extracted memory",
      );
    }
  }

  const entitiesExtracted = extractedEntities.reduce((n, e) => n + e.entities.length, 0);

  // STORE stage: report what the per-memory store loop persisted.
  log.info(
    { agentId, step: "store" as const, memoriesExtracted, duplicatesSkipped, durationMs: clock.now() - startTime },
    "memories stored",
  );

  // LINK stage + entities-linked emit — only meaningful when the entity-store port
  // is injected (un-injected ⇒ no link work, no event). The
  // `entitiesLinked > 0` guard keeps a no-entity run silent (no zero-count noise).
  if (deps.entityStore && entitiesLinked > 0) {
    const newEntities = seenEntityNames.size;
    log.info(
      { agentId, step: "link" as const, entitiesLinked, newEntities, durationMs: clock.now() - startTime },
      "entities linked",
    );
    // Counts ONLY — entityCount (total resolved) + newEntities (distinct
    // first-seen) + durationMs. NEVER an entity name (AGENTS.md §2.7).
    eventBus.emit("memory:entities_linked", {
      agentId,
      entityCount: entitiesLinked,
      newEntities,
      durationMs: clock.now() - startTime,
      timestamp: clock.now(),
    });
  }

  // Update watermark per-session (success path — runs on every terminating path).
  for (const session of reviewedSessions) {
    watermark.sessions[session.conversationRef] = session.updatedAt;
  }
  await saveWatermark(watermarkPath, watermark);

  // Emit completion event (entitiesExtracted is additive — consumers that do not know the field ignore it).
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
