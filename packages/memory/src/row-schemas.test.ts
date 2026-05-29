// SPDX-License-Identifier: Apache-2.0
/**
 * Type-equality + runtime-parse assertions for row schemas.
 *
 * Proves each Zod schema in `row-schemas.ts` matches the paired TypeScript
 * interface. Mitigates schema-drift risk: without these tests, a column-type
 * drift between interface and schema would only surface at runtime in
 * production.
 *
 * Two categories:
 *
 * 1. **Type-equality tests** — for schemas paired with EXPORTED interfaces
 *    (MemoryRow, SessionRow, VecSearchRow, FtsSearchRow, NamedGraphRow,
 *    Ctx*Row, SessionData/SessionListEntry/SessionDetailedEntry). Uses
 *    `expectTypeOf<z.infer<typeof XSchema>>().toEqualTypeOf<XInterface>()`
 *    which is a compile-time check — passes only if the inferred type
 *    matches the interface exactly.
 *
 * 2. **Runtime-parse tests** — for schemas whose source interface is
 *    file-internal (TokenUsageDbRow, OAuthProfileRow,
 *    DeliveryMirrorDbRow, DeliveryQueueDbRow, BatchCacheRow,
 *    and observability *DbRow types). The schema IS the single source of
 *    truth (interfaces are `z.infer<typeof XxxRowSchema>`); we prove the
 *    schema parses representative rows + rejects malformed ones.
 *
 * Every `it()` description is ≥20 chars and use-case-named (no
 * "works"/"happy path"/"smoke").
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type { z } from "zod";
import type {
  MemoryRow,
  SessionRow,
  VecSearchRow,
  FtsSearchRow,
  NamedGraphRow,
} from "./types.js";
import type {
  CtxConversationRow,
  CtxMessageRow,
  CtxMessagePartRow,
  CtxSummaryRow,
  CtxSummaryMessageRow,
  CtxSummaryParentRow,
  CtxContextItemRow,
  CtxLargeFileRow,
  CtxExpansionGrantRow,
  SessionData,
  SessionListEntry,
  SessionDetailedEntry,
} from "@comis/core";
import {
  MemoryRowSchema,
  SessionRowSchema,
  VecSearchRowSchema,
  FtsSearchRowSchema,
  NamedGraphRowSchema,
  CtxConversationRowSchema,
  CtxMessageRowSchema,
  CtxMessagePartRowSchema,
  CtxSummaryRowSchema,
  CtxSummaryMessageRowSchema,
  CtxSummaryParentRowSchema,
  CtxContextItemRowSchema,
  CtxLargeFileRowSchema,
  CtxExpansionGrantRowSchema,
  SessionDataSchema,
  SessionListEntrySchema,
  SessionDetailedEntrySchema,
  TokenUsageDbRowSchema,
  DeliveryDbRowSchema,
  DiagnosticDbRowSchema,
  ChannelSnapshotDbRowSchema,
  ProviderAggDbRowSchema,
  AgentAggDbRowSchema,
  SessionAggDbRowSchema,
  HourlyBucketDbRowSchema,
  DeliveryStatsDbRowSchema,
  SystemPromptReportDbRowSchema,
  OAuthProfileRowSchema,
  DeliveryMirrorDbRowSchema,
  DeliveryQueueDbRowSchema,
  BatchCacheRowSchema,
  IdProjectionRowSchema,
  CountProjectionRowSchema,
  MemoryEntityRowSchema,
  EntityLaneRowSchema,
} from "./row-schemas.js";

// =====================================================================
// 1. Type-equality assertions (compile-time — passes only if z.infer
// of the schema matches the source interface exactly)
// =====================================================================

describe("row-schemas — type-equality with paired interfaces", () => {
  it("MemoryRowSchema z.infer matches MemoryRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof MemoryRowSchema>>().toEqualTypeOf<MemoryRow>();
  });

  it("SessionRowSchema z.infer matches SessionRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof SessionRowSchema>>().toEqualTypeOf<SessionRow>();
  });

  it("VecSearchRowSchema z.infer matches VecSearchRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof VecSearchRowSchema>>().toEqualTypeOf<VecSearchRow>();
  });

  it("FtsSearchRowSchema z.infer matches FtsSearchRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof FtsSearchRowSchema>>().toEqualTypeOf<FtsSearchRow>();
  });

  it("NamedGraphRowSchema z.infer matches NamedGraphRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof NamedGraphRowSchema>>().toEqualTypeOf<NamedGraphRow>();
  });

  it("CtxConversationRowSchema z.infer matches CtxConversationRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxConversationRowSchema>>().toEqualTypeOf<CtxConversationRow>();
  });

  it("CtxMessageRowSchema z.infer matches CtxMessageRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxMessageRowSchema>>().toEqualTypeOf<CtxMessageRow>();
  });

  it("CtxMessagePartRowSchema z.infer matches CtxMessagePartRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxMessagePartRowSchema>>().toEqualTypeOf<CtxMessagePartRow>();
  });

  it("CtxSummaryRowSchema z.infer matches CtxSummaryRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxSummaryRowSchema>>().toEqualTypeOf<CtxSummaryRow>();
  });

  it("CtxSummaryMessageRowSchema z.infer matches CtxSummaryMessageRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxSummaryMessageRowSchema>>().toEqualTypeOf<CtxSummaryMessageRow>();
  });

  it("CtxSummaryParentRowSchema z.infer matches CtxSummaryParentRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxSummaryParentRowSchema>>().toEqualTypeOf<CtxSummaryParentRow>();
  });

  it("CtxContextItemRowSchema z.infer matches CtxContextItemRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxContextItemRowSchema>>().toEqualTypeOf<CtxContextItemRow>();
  });

  it("CtxLargeFileRowSchema z.infer matches CtxLargeFileRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxLargeFileRowSchema>>().toEqualTypeOf<CtxLargeFileRow>();
  });

  it("CtxExpansionGrantRowSchema z.infer matches CtxExpansionGrantRow from @comis/core", () => {
    expectTypeOf<z.infer<typeof CtxExpansionGrantRowSchema>>().toEqualTypeOf<CtxExpansionGrantRow>();
  });

  it("SessionDataSchema z.infer matches SessionData DTO from @comis/core", () => {
    expectTypeOf<z.infer<typeof SessionDataSchema>>().toEqualTypeOf<SessionData>();
  });

  it("SessionListEntrySchema z.infer matches SessionListEntry DTO from @comis/core", () => {
    expectTypeOf<z.infer<typeof SessionListEntrySchema>>().toEqualTypeOf<SessionListEntry>();
  });

  it("SessionDetailedEntrySchema z.infer matches SessionDetailedEntry DTO from @comis/core", () => {
    expectTypeOf<z.infer<typeof SessionDetailedEntrySchema>>().toEqualTypeOf<SessionDetailedEntry>();
  });
});

// =====================================================================
// 2. Runtime-parse assertions for schemas whose source interface is
// file-internal (the schema IS the SSOT)
// =====================================================================

describe("row-schemas — MemoryRowSchema occurred_at column (TEMP-01)", () => {
  function baseMemoryRow(): Record<string, unknown> {
    return {
      id: "row-1",
      tenant_id: "default",
      agent_id: "default",
      user_id: "user-1",
      content: "test",
      trust_level: "learned",
      memory_type: "semantic",
      source_who: "agent",
      source_channel: null,
      source_session_key: null,
      tags: "[]",
      created_at: 1700000000000,
      occurred_at: null,
      updated_at: null,
      expires_at: null,
      has_embedding: 0,
    };
  }

  it("accepts a row whose occurred_at is a number (event time, epoch ms)", () => {
    const sample = { ...baseMemoryRow(), occurred_at: 1699000000000 };
    expect(MemoryRowSchema.safeParse(sample).success).toBe(true);
  });

  it("accepts a row whose occurred_at is null (event time unknown)", () => {
    const sample = { ...baseMemoryRow(), occurred_at: null };
    expect(MemoryRowSchema.safeParse(sample).success).toBe(true);
  });

  it("rejects a row whose occurred_at is a string (must be number|null)", () => {
    const sample = { ...baseMemoryRow(), occurred_at: "2026-05-20T10:00:00Z" };
    expect(MemoryRowSchema.safeParse(sample).success).toBe(false);
  });
});

describe("row-schemas — internal DB row runtime parses", () => {
  it("TokenUsageDbRowSchema parses a complete token_usage row", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      trace_id: "trace-1",
      agent_id: "agent-1",
      channel_id: "channel-1",
      session_key: "sess-1",
      provider: "openai",
      model: "gpt-5",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      cost_input: 0.001,
      cost_output: 0.002,
      cost_total: 0.003,
      cost_cache_read: 0.0001,
      cost_cache_write: 0.0002,
      cache_saved: 0.0001,
      latency_ms: 150,
      cache_retention: "auto",
    };
    expect(TokenUsageDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("DeliveryDbRowSchema parses a complete delivery row", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      trace_id: "trace-1",
      agent_id: "agent-1",
      channel_type: "telegram",
      channel_id: "tg-1",
      session_key: "sess-1",
      status: "delivered",
      latency_ms: 200,
      error_message: "",
      message_preview: "hello",
      tool_calls: 0,
      llm_calls: 1,
      tokens_total: 50,
      cost_total: 0.001,
    };
    expect(DeliveryDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("DiagnosticDbRowSchema parses a complete diagnostics row", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      category: "channel",
      severity: "info",
      agent_id: "agent-1",
      session_key: "sess-1",
      message: "test diagnostic",
      details: "{}",
      trace_id: "trace-1",
    };
    expect(DiagnosticDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("ChannelSnapshotDbRowSchema parses a complete channels row", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      channel_type: "telegram",
      channel_id: "tg-1",
      status: "online",
      messages_sent: 10,
      messages_received: 20,
      uptime_ms: 60000,
    };
    expect(ChannelSnapshotDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("ProviderAggDbRowSchema parses a provider-grouped aggregation row", () => {
    const sample = {
      provider: "openai",
      model: "gpt-5",
      total_cost: 0.5,
      total_tokens: 1000,
      call_count: 10,
      total_cache_saved: 0.05,
    };
    expect(ProviderAggDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("AgentAggDbRowSchema parses an agent-grouped aggregation row", () => {
    const sample = {
      agent_id: "agent-1",
      total_cost: 0.5,
      total_tokens: 1000,
      call_count: 10,
      total_cache_saved: 0.05,
    };
    expect(AgentAggDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("SessionAggDbRowSchema parses a session-grouped aggregation row", () => {
    const sample = {
      session_key: "sess-1",
      total_cost: 0.5,
      total_tokens: 1000,
      call_count: 10,
      total_cache_saved: 0.05,
    };
    expect(SessionAggDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("HourlyBucketDbRowSchema parses an hourly aggregation row", () => {
    const sample = {
      hour: 1700000000000,
      total_cost: 0.5,
      total_tokens: 1000,
      call_count: 10,
      total_cache_saved: 0.05,
    };
    expect(HourlyBucketDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("DeliveryStatsDbRowSchema parses a delivery-stats summary row", () => {
    const sample = {
      total: 100,
      success: 90,
      error: 5,
      timeout: 3,
      filtered: 2,
      avg_latency_ms: 150,
    };
    expect(DeliveryStatsDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("SystemPromptReportDbRowSchema parses a complete system_prompt_reports row", () => {
    const sample = {
      agent_id: "agent-1",
      tenant_id: "tenant-x",
      session_id: "session-1",
      run_id: "run-1",
      generated_at: 1_700_000_000_000,
      provider: "anthropic",
      model: "claude-3-opus",
      system_chars: 1024,
      system_sha256: "deadbeefcafebabe",
      report_json: '{"traceSchema":"comis-system-prompt-report","schemaVersion":1}',
    };
    expect(SystemPromptReportDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("SystemPromptReportDbRowSchema accepts null for nullable columns", () => {
    const sample = {
      agent_id: "agent-1",
      tenant_id: null,
      session_id: "session-1",
      run_id: null,
      generated_at: 1_700_000_000_000,
      provider: null,
      model: null,
      system_chars: 100,
      system_sha256: "abc",
      report_json: "{}",
    };
    expect(SystemPromptReportDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("SystemPromptReportDbRowSchema rejects an extra column (strictObject invariant)", () => {
    const sample = {
      agent_id: "agent-1",
      tenant_id: null,
      session_id: "session-1",
      run_id: null,
      generated_at: 1,
      provider: null,
      model: null,
      system_chars: 1,
      system_sha256: "a",
      report_json: "{}",
      extra_column_not_in_schema: "x",
    };
    expect(SystemPromptReportDbRowSchema.safeParse(sample).success).toBe(false);
  });

  it("SystemPromptReportDbRowSchema rejects a row missing the required agent_id field", () => {
    const sample = {
      // agent_id missing
      tenant_id: null,
      session_id: "session-1",
      run_id: null,
      generated_at: 1,
      provider: null,
      model: null,
      system_chars: 1,
      system_sha256: "a",
      report_json: "{}",
    };
    expect(SystemPromptReportDbRowSchema.safeParse(sample).success).toBe(false);
  });

  it("OAuthProfileRowSchema parses an encrypted oauth_profiles row with Buffer columns", () => {
    const sample = {
      profile_id: "profile-1",
      provider: "github",
      identity: "user-1",
      credentials_ciphertext: Buffer.from([1, 2, 3]),
      credentials_iv: Buffer.from([4, 5, 6]),
      credentials_auth_tag: Buffer.from([7, 8, 9]),
      credentials_salt: Buffer.from([10, 11, 12]),
      expires_at: 1700000000000,
      version: 1,
      created_at: 1700000000000,
      updated_at: 1700001000000,
    };
    expect(OAuthProfileRowSchema.safeParse(sample).success).toBe(true);
  });

  it("DeliveryMirrorDbRowSchema parses a delivery_mirror row with acknowledged_at null", () => {
    const sample = {
      id: "del-1",
      session_key: "sess-1",
      text: "hello",
      media_urls: "[]",
      channel_type: "telegram",
      channel_id: "tg-1",
      origin: "agent",
      idempotency_key: "idem-1",
      status: "pending",
      created_at: 1700000000000,
      acknowledged_at: null,
    };
    expect(DeliveryMirrorDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("DeliveryQueueDbRowSchema parses a delivery_queue row with all 17 columns", () => {
    const sample = {
      id: "q-1",
      text: "hello",
      channel_type: "telegram",
      channel_id: "tg-1",
      tenant_id: "tenant-1",
      options_json: "{}",
      origin: "agent",
      status: "pending",
      attempt_count: 0,
      max_attempts: 3,
      created_at: 1700000000000,
      scheduled_at: 1700000000000,
      expire_at: 1700100000000,
      last_attempt_at: null,
      next_retry_at: null,
      last_error: null,
      trace_id: null,
    };
    expect(DeliveryQueueDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("BatchCacheRowSchema parses an embedding_cache batch row with Buffer embedding", () => {
    const sample = {
      text_hash: "abc123",
      embedding: Buffer.from([1, 2, 3, 4]),
    };
    expect(BatchCacheRowSchema.safeParse(sample).success).toBe(true);
  });

  it("IdProjectionRowSchema parses a single-column id projection", () => {
    const sample = { id: "row-1" };
    expect(IdProjectionRowSchema.safeParse(sample).success).toBe(true);
  });

  it("CountProjectionRowSchema parses a COUNT(*) projection", () => {
    const sample = { count: 42 };
    expect(CountProjectionRowSchema.safeParse(sample).success).toBe(true);
  });
});

// =====================================================================
// 3. Negative-path assertions — strictObject rejects extra columns
// (defense-in-depth against schema drift; ties to MapperError contract)
// =====================================================================

describe("row-schemas — strictObject rejects unexpected columns", () => {
  it("MemoryRowSchema rejects rows with an unexpected extra column", () => {
    const sample = {
      id: "row-1",
      tenant_id: "default",
      agent_id: "default",
      user_id: "user-1",
      content: "test",
      trust_level: "learned",
      memory_type: "semantic",
      source_who: "agent",
      source_channel: null,
      source_session_key: null,
      tags: "[]",
      created_at: 1700000000000,
      occurred_at: 1700000000050,
      updated_at: null,
      expires_at: null,
      has_embedding: 0,
      attacker_injected_column: "DROP TABLE memories",
    };
    expect(MemoryRowSchema.safeParse(sample).success).toBe(false);
  });

  it("CtxConversationRowSchema rejects rows with an unexpected extra column", () => {
    const sample = {
      conversation_id: "conv-1",
      tenant_id: "default",
      agent_id: "default",
      session_key: "sess-1",
      title: null,
      created_at: "2026-05-15T00:00:00Z",
      updated_at: "2026-05-15T00:00:00Z",
      attacker_injected: "x",
    };
    expect(CtxConversationRowSchema.safeParse(sample).success).toBe(false);
  });

  it("TokenUsageDbRowSchema rejects rows missing required fields", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      // ... missing all other required columns
    };
    expect(TokenUsageDbRowSchema.safeParse(sample).success).toBe(false);
  });

  // --- Entity-association row schemas (Phase 83) ---

  it("MemoryEntityRowSchema parses a full memory_entities row including canonical_key", () => {
    const sample = {
      id: "e1",
      tenant_id: "default",
      agent_id: "default",
      canonical_name: "Istanbul",
      canonical_key: "istanbul",
      mention_count: 3,
      first_seen: 1700000000000,
      last_seen: 1700000005000,
    };
    expect(MemoryEntityRowSchema.safeParse(sample).success).toBe(true);
  });

  it("MemoryEntityRowSchema rejects a row missing the canonical_key column", () => {
    const sample = {
      id: "e1",
      tenant_id: "default",
      agent_id: "default",
      canonical_name: "Istanbul",
      // canonical_key omitted
      mention_count: 1,
      first_seen: 1700000000000,
      last_seen: 1700000000000,
    };
    expect(MemoryEntityRowSchema.safeParse(sample).success).toBe(false);
  });

  it("MemoryEntityRowSchema rejects unknown extra columns (z.strictObject)", () => {
    const sample = {
      id: "e1",
      tenant_id: "default",
      agent_id: "default",
      canonical_name: "Istanbul",
      canonical_key: "istanbul",
      mention_count: 1,
      first_seen: 1700000000000,
      last_seen: 1700000000000,
      attacker_injected: "x",
    };
    expect(MemoryEntityRowSchema.safeParse(sample).success).toBe(false);
  });

  it("EntityLaneRowSchema parses the self-join projection (memory_id + shared count)", () => {
    expect(EntityLaneRowSchema.safeParse({ memory_id: "m2", shared: 2 }).success).toBe(true);
  });

  it("EntityLaneRowSchema rejects a non-numeric shared count", () => {
    expect(EntityLaneRowSchema.safeParse({ memory_id: "m2", shared: "two" }).success).toBe(false);
  });
});
