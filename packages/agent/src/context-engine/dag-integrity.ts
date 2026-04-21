// SPDX-License-Identifier: Apache-2.0
/**
 * DAG integrity checker with 5 health checks, auto-repair for safe operations,
 * and ERROR logging for unsafe issues. All check functions are pure -- receive
 * deps, return issues.
 *
 * Health checks:
 * - Orphan summaries (leaf with no source messages, condensed with no parents)
 * - Stale descendant counts (counts_dirty flag still set)
 * - Contiguity gaps in context item ordinals
 * - Dangling refs (context items pointing to deleted entities)
 * - FTS desync between source tables and FTS5 indexes
 * - Cycles in summary parent links (ERROR only, no auto-repair)
 *
 * DAG Integrity & Wiring.
 *
 * @module
 */

import type { ContextStore } from "@comis/memory";
import type {
  IntegrityIssue,
  IntegrityReport,
  IntegrityCheckDeps,
  IntegrityCheckEvent,
} from "./types.js";
import { recomputeDescendantCounts } from "./dag-triggers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum depth for cycle detection DFS traversal. */
const MAX_CYCLE_DEPTH = 10;

// ---------------------------------------------------------------------------
// Internal type for raw DB access
// ---------------------------------------------------------------------------

type RawDb = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): () => T;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all DAG integrity checks on a conversation, auto-repair safe issues,
 * log ERROR for unsafe issues, and emit the context:integrity event.
 *
 * @param deps - Integrity checker dependencies
 * @param conversationId - The conversation to check
 * @returns Integrity report with all issues found and repairs applied
 */
export function checkIntegrity(
  deps: IntegrityCheckDeps,
  conversationId: string,
): IntegrityReport {
  const startTime = Date.now();

  // Collect issues from all checks
  const issues: IntegrityIssue[] = [
    ...checkOrphanSummaries(deps.store, conversationId),
    ...checkStaleCounts(deps.db, conversationId),
    ...checkContiguityGaps(deps.store, conversationId),
    ...checkDanglingRefs(deps.store, conversationId),
    ...checkFtsDesync(deps.db, conversationId),
    ...checkCycles(deps.store, conversationId),
  ];

  // Apply auto-repairs for safe issues
  const repairsApplied = applyRepairs(
    deps.store,
    deps.db,
    issues,
    conversationId,
  );

  // Log ERROR for unsafe issues (cycles)
  const errorIssues = issues.filter((i) => i.severity === "error");
  for (const issue of errorIssues) {
    deps.logger.error(
      {
        conversationId,
        issueType: issue.type,
        entity: issue.entity,
        hint: "DAG integrity issue requires manual intervention",
        errorKind: "data",
      },
      issue.detail,
    );
  }

  const durationMs = Date.now() - startTime;

  const report: IntegrityReport = {
    conversationId,
    issues,
    repairsApplied,
    errorsLogged: errorIssues.length,
    durationMs,
  };

  // Emit context:integrity event
  const issueTypes = [...new Set(issues.map((i) => i.type))];
  deps.eventBus?.emit("context:integrity", {
    conversationId,
    agentId: deps.agentId,
    sessionKey: deps.sessionKey,
    issueCount: issues.length,
    repairsApplied,
    errorsLogged: errorIssues.length,
    issueTypes,
    durationMs,
    timestamp: Date.now(),
  } satisfies IntegrityCheckEvent);

  // Log INFO summary
  deps.logger.info(
    {
      conversationId,
      issueCount: issues.length,
      repairsApplied,
      errorsLogged: errorIssues.length,
      durationMs,
    },
    "DAG integrity check complete",
  );

  return report;
}

// ---------------------------------------------------------------------------
// Orphan summary detection
// ---------------------------------------------------------------------------

function checkOrphanSummaries(
  store: ContextStore,
  conversationId: string,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const summaries = store.getSummariesByConversation(conversationId);

  for (const summary of summaries) {
    if (summary.kind === "leaf") {
      const sourceIds = store.getSourceMessageIds(summary.summary_id);
      if (sourceIds.length === 0) {
        issues.push({
          type: "orphan_summary",
          severity: "auto_repaired",
          detail: `Leaf summary ${summary.summary_id} has no source messages`,
          entity: summary.summary_id,
        });
      }
    } else if (summary.kind === "condensed") {
      const parentIds = store.getParentSummaryIds(summary.summary_id);
      if (parentIds.length === 0) {
        issues.push({
          type: "orphan_summary",
          severity: "auto_repaired",
          detail: `Condensed summary ${summary.summary_id} has no parent summaries`,
          entity: summary.summary_id,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Stale descendant counts
// ---------------------------------------------------------------------------

function checkStaleCounts(
  db: unknown,
  conversationId: string,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const rawDb = db as RawDb;

  const rows = rawDb
    .prepare(
      "SELECT summary_id FROM ctx_summaries WHERE conversation_id = ? AND counts_dirty = 1",
    )
    .all(conversationId) as Array<{ summary_id: string }>;

  for (const row of rows) {
    issues.push({
      type: "stale_counts",
      severity: "auto_repaired",
      detail: `Summary ${row.summary_id} has stale descendant counts (counts_dirty = 1)`,
      entity: row.summary_id,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Contiguity gaps in context item ordinals
// ---------------------------------------------------------------------------

function checkContiguityGaps(
  store: ContextStore,
  conversationId: string,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const items = store.getContextItems(conversationId);

  for (let i = 0; i < items.length; i++) {
    if (items[i].ordinal !== i) { // eslint-disable-line security/detect-object-injection
      issues.push({
        type: "contiguity_gap",
        severity: "auto_repaired",
        detail: `Context item ordinals are non-contiguous (expected ${i}, got ${items[i].ordinal})`, // eslint-disable-line security/detect-object-injection
      });
      break; // One issue covers the whole re-sequence
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Dangling refs (context items pointing to deleted entities)
// ---------------------------------------------------------------------------

function checkDanglingRefs(
  store: ContextStore,
  conversationId: string,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const items = store.getContextItems(conversationId);

  for (const item of items) {
    if (item.item_type === "message" && item.message_id !== null) {
      const msgs = store.getMessagesByIds([item.message_id]);
      if (msgs.length === 0) {
        issues.push({
          type: "dangling_ref",
          severity: "auto_repaired",
          detail: `Context item references deleted message ${item.message_id}`,
          entity: String(item.message_id),
        });
      }
    } else if (item.item_type === "summary" && item.summary_id !== null) {
      const summary = store.getSummary(item.summary_id);
      if (!summary) {
        issues.push({
          type: "dangling_ref",
          severity: "auto_repaired",
          detail: `Context item references deleted summary ${item.summary_id}`,
          entity: item.summary_id,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// FTS desync between source tables and FTS5 indexes
// ---------------------------------------------------------------------------

function checkFtsDesync(
  db: unknown,
  conversationId: string,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const rawDb = db as RawDb;

  // Check messages FTS
  const msgCount = rawDb
    .prepare(
      "SELECT COUNT(*) as cnt FROM ctx_messages WHERE conversation_id = ?",
    )
    .get(conversationId) as { cnt: number };

  const msgFtsCount = rawDb
    .prepare(
      "SELECT COUNT(*) as cnt FROM ctx_messages_fts WHERE rowid IN (SELECT message_id FROM ctx_messages WHERE conversation_id = ?)",
    )
    .get(conversationId) as { cnt: number };

  if (msgCount.cnt !== msgFtsCount.cnt) {
    issues.push({
      type: "fts_desync",
      severity: "auto_repaired",
      detail: `Messages FTS desync: ${msgCount.cnt} messages but ${msgFtsCount.cnt} FTS entries`,
    });
  }

  // Check summaries FTS
  const sumCount = rawDb
    .prepare(
      "SELECT COUNT(*) as cnt FROM ctx_summaries WHERE conversation_id = ?",
    )
    .get(conversationId) as { cnt: number };

  const sumFtsCount = rawDb
    .prepare(
      "SELECT COUNT(*) as cnt FROM ctx_summaries_fts WHERE summary_id IN (SELECT summary_id FROM ctx_summaries WHERE conversation_id = ?)",
    )
    .get(conversationId) as { cnt: number };

  if (sumCount.cnt !== sumFtsCount.cnt) {
    issues.push({
      type: "fts_desync",
      severity: "auto_repaired",
      detail: `Summaries FTS desync: ${sumCount.cnt} summaries but ${sumFtsCount.cnt} FTS entries`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Cycle detection in summary parent links
// ---------------------------------------------------------------------------

function checkCycles(
  store: ContextStore,
  conversationId: string,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const summaries = store.getSummariesByConversation(conversationId);
  const reportedCycles = new Set<string>();

  for (const summary of summaries) {
    const visited = new Set<string>();
    visited.add(summary.summary_id);

    const hasCycle = dfsDetectCycle(
      store,
      summary.summary_id,
      visited,
      0,
    );

    if (hasCycle && !reportedCycles.has(summary.summary_id)) {
      reportedCycles.add(summary.summary_id);
      issues.push({
        type: "cycle",
        severity: "error",
        detail: `Cycle detected in parent links starting from summary ${summary.summary_id}`,
        entity: summary.summary_id,
      });
    }
  }

  return issues;
}

function dfsDetectCycle(
  store: ContextStore,
  summaryId: string,
  visited: Set<string>,
  depth: number,
): boolean {
  if (depth >= MAX_CYCLE_DEPTH) return false;

  const parentIds = store.getParentSummaryIds(summaryId);
  for (const parentId of parentIds) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    if (dfsDetectCycle(store, parentId, visited, depth + 1)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Auto-repair
// ---------------------------------------------------------------------------

function applyRepairs(
  store: ContextStore,
  db: unknown,
  issues: IntegrityIssue[],
  conversationId: string,
): number {
  let repairsApplied = 0;
  const rawDb = db as RawDb;

  // Collect dangling entity IDs for context item rebuild
  const danglingMessageIds = new Set<string>();
  const danglingSummaryIds = new Set<string>();

  for (const issue of issues) {
    if (issue.severity !== "auto_repaired") continue;

    switch (issue.type) {
      case "orphan_summary": {
        if (issue.entity) {
          store.deleteSummary(issue.entity);
          repairsApplied++;
        }
        break;
      }

      case "stale_counts": {
        if (issue.entity) {
          recomputeDescendantCounts(store, issue.entity);
          repairsApplied++;
        }
        break;
      }

      case "contiguity_gap": {
        const items = store.getContextItems(conversationId);
        store.replaceContextItems(
          conversationId,
          items.map((item, i) => ({
            ordinal: i,
            itemType: item.item_type as "message" | "summary",
            messageId: item.message_id ?? undefined,
            summaryId: item.summary_id ?? undefined,
          })),
        );
        repairsApplied++;
        break;
      }

      case "dangling_ref": {
        if (issue.entity) {
          // Check if it's a message or summary reference from the detail string
          if (issue.detail.includes("message")) {
            danglingMessageIds.add(issue.entity);
          } else {
            danglingSummaryIds.add(issue.entity);
          }
        }
        break;
      }

      case "fts_desync": {
        repairFtsDesync(rawDb, conversationId, issue.detail);
        repairsApplied++;
        break;
      }

      // cycle: never auto-repaired
    }
  }

  // Apply dangling ref repairs in bulk -- rebuild context items without dangling entries
  if (danglingMessageIds.size > 0 || danglingSummaryIds.size > 0) {
    const items = store.getContextItems(conversationId);
    const validItems = items.filter((item) => {
      if (
        item.item_type === "message" &&
        item.message_id !== null &&
        danglingMessageIds.has(String(item.message_id))
      ) {
        return false;
      }
      if (
        item.item_type === "summary" &&
        item.summary_id !== null &&
        danglingSummaryIds.has(item.summary_id)
      ) {
        return false;
      }
      return true;
    });

    store.replaceContextItems(
      conversationId,
      validItems.map((item, i) => ({
        ordinal: i,
        itemType: item.item_type as "message" | "summary",
        messageId: item.message_id ?? undefined,
        summaryId: item.summary_id ?? undefined,
      })),
    );
    repairsApplied += danglingMessageIds.size + danglingSummaryIds.size;
  }

  return repairsApplied;
}

function repairFtsDesync(
  rawDb: RawDb,
  conversationId: string,
  detail: string,
): void {
  if (detail.includes("Messages FTS")) {
    const rebuild = rawDb.transaction(() => {
      rawDb
        .prepare(
          "DELETE FROM ctx_messages_fts WHERE rowid IN (SELECT message_id FROM ctx_messages WHERE conversation_id = ?)",
        )
        .run(conversationId);
      rawDb
        .prepare(
          "INSERT INTO ctx_messages_fts(rowid, content) SELECT message_id, content FROM ctx_messages WHERE conversation_id = ?",
        )
        .run(conversationId);
    });
    rebuild();
  } else {
    const rebuild = rawDb.transaction(() => {
      rawDb
        .prepare(
          "DELETE FROM ctx_summaries_fts WHERE summary_id IN (SELECT summary_id FROM ctx_summaries WHERE conversation_id = ?)",
        )
        .run(conversationId);
      rawDb
        .prepare(
          "INSERT INTO ctx_summaries_fts(summary_id, content) SELECT summary_id, content FROM ctx_summaries WHERE conversation_id = ?",
        )
        .run(conversationId);
    });
    rebuild();
  }
}
