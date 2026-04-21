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
import { safePath, parseFormattedSessionKey } from "@comis/core";
import type { MemoryReviewConfig } from "@comis/core";
import type { MemoryPort, MemorySearchOptions } from "@comis/core";
import type { MemoryEntry } from "@comis/core";
import type { SessionKey } from "@comis/core";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Session detail entry shape (matches SessionStore.listDetailed output). */
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

/** Session data loaded by formatted key. */
export interface SessionData {
  messages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
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

interface ExtractedPreference {
  content: string;
  session: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_TIMEOUT_MS = 120_000;
const SYSTEM_PROMPT = `You are analyzing chat session histories to extract user preferences and facts.
For each session, extract any user preferences, facts about the user, or recurring patterns.
Return a JSON array of objects: [{"content": "preference text", "session": "session_key"}]
If no preferences found, return an empty array: []
Return ONLY valid JSON, no markdown fences, no explanation.`;

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
  agentId: string,
  config: MemoryReviewConfig,
  watermark: ReviewWatermark,
): SessionDetailedEntry[] {
  return sessions
    .filter((s) => {
      // Filter by agent prefix in session key
      const agentPrefix = `agent:${agentId}:`;
      if (!s.sessionKey.startsWith(agentPrefix)) {
        // For default agent, accept sessions without agent: prefix
        if (agentId === "default" && !s.sessionKey.startsWith("agent:")) {
          // OK -- default agent owns unprefixed sessions
        } else {
          return false;
        }
      }

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
  const isoDate = new Date(updatedAt).toISOString();
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

function parseExtractedPreferences(text: string): ExtractedPreference[] | undefined {
  // Strip markdown code fences
  const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).content === "string" &&
        typeof (item as Record<string, unknown>).session === "string",
    ) as ExtractedPreference[];
  } catch {
    return undefined;
  }
}

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
 * cheap-model LLM call, deduplicates extracted preferences, and stores new
 * findings via MemoryPort.
 *
 * @param deps - Injected dependencies (memoryPort, sessionStore, eventBus, LLM config, etc.)
 * @returns Result<void, Error> -- ok on success (even if 0 memories extracted), err on fatal failure
 */
export async function runMemoryReview(deps: MemoryReviewDeps): Promise<Result<void, Error>> {
  const startTime = Date.now();
  const { config, agentId, tenantId, memoryPort, sessionStore, eventBus, logger } = deps;

  // Load watermark
  const watermarkPath = safePath(deps.workspacePath, ".memory-review-watermark");
  const watermark = await loadWatermark(watermarkPath);

  // List and filter sessions
  const allSessions = sessionStore.listDetailed(tenantId);
  const qualifyingSessions = filterSessions(allSessions, agentId, config, watermark);

  logger.debug({ agentId, totalSessions: allSessions.length, qualifying: qualifyingSessions.length }, "Memory review session filtering complete");

  // Early exit if nothing to review
  if (qualifyingSessions.length === 0) {
    eventBus.emit("memory:review_completed", {
      agentId,
      sessionsReviewed: 0,
      memoriesExtracted: 0,
      duplicatesSkipped: 0,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
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
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
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
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let responseText: string;
  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: batchContent,
            timestamp: Date.now(),
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
    clearTimeout(timer);
    return err(new Error(`Memory review LLM call failed: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`));
  } finally {
    clearTimeout(timer);
  }

  // Parse LLM response
  const preferences = parseExtractedPreferences(responseText);
  if (!preferences) {
    logger.warn({ agentId, responseLength: responseText.length }, "Memory review LLM returned invalid JSON, skipping extraction");
    // Still update watermarks and emit event
    for (const session of reviewedSessions) {
      watermark.sessions[session.sessionKey] = session.updatedAt;
    }
    await saveWatermark(watermarkPath, watermark);
    eventBus.emit("memory:review_completed", {
      agentId,
      sessionsReviewed: reviewedSessions.length,
      memoriesExtracted: 0,
      duplicatesSkipped: 0,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return ok(undefined);
  }

  // Dedup and store
  let memoriesExtracted = 0;
  let duplicatesSkipped = 0;

  for (const pref of preferences) {
    if (!pref.content || !pref.session) continue;

    // Build a SessionKey for the search
    const parsedKey = parseFormattedSessionKey(pref.session);
    const sessionKey: SessionKey = parsedKey ?? {
      tenantId,
      userId: "system",
      channelId: "memory-review",
    };

    // Dedup check
    const searchOpts: MemorySearchOptions = {
      limit: 1,
      minScore: config.dedupThreshold,
      trustLevel: "system",
      tags: ["auto-review"],
      agentId,
    };

    const searchResult = await memoryPort.search(sessionKey, pref.content, searchOpts);
    if (searchResult.ok && searchResult.value.length > 0) {
      duplicatesSkipped++;
      logger.debug({ agentId, content: pref.content.slice(0, 50) }, "Skipping duplicate memory");
      continue;
    }

    // Store new memory
    const entry: MemoryEntry = {
      id: randomUUID(),
      tenantId,
      agentId,
      userId: "system",
      content: pref.content,
      trustLevel: "system",
      source: { who: "system", channel: "memory-review" },
      tags: ["auto-review", ...config.autoTags],
      sourceType: "conversation",
      createdAt: Date.now(),
    };

    const storeResult = await memoryPort.store(entry);
    if (storeResult.ok) {
      memoriesExtracted++;
    } else {
      logger.warn({ agentId, err: storeResult.error }, "Failed to store extracted memory");
    }
  }

  // Update watermark per-session
  for (const session of reviewedSessions) {
    watermark.sessions[session.sessionKey] = session.updatedAt;
  }
  await saveWatermark(watermarkPath, watermark);

  // Emit completion event
  eventBus.emit("memory:review_completed", {
    agentId,
    sessionsReviewed: reviewedSessions.length,
    memoriesExtracted,
    duplicatesSkipped,
    durationMs: Date.now() - startTime,
    timestamp: Date.now(),
  });

  logger.info({
    agentId,
    sessionsReviewed: reviewedSessions.length,
    memoriesExtracted,
    duplicatesSkipped,
    durationMs: Date.now() - startTime,
  }, "Memory review completed");

  return ok(undefined);
}
