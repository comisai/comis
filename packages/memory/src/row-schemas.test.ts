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
 *    SessionData/SessionListEntry/SessionDetailedEntry). Uses
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
  LcdMessageRow,
  LcdMessagePartRow,
  LcdSummaryRow,
  LcdSummaryMessageRow,
  LcdSummaryParentRow,
  LcdContextItemRow,
} from "./types.js";
import type { SessionData, SessionListEntry, SessionDetailedEntry } from "@comis/core";
import {
  MemoryRowSchema,
  SessionRowSchema,
  VecSearchRowSchema,
  FtsSearchRowSchema,
  NamedGraphRowSchema,
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
  EntityListRowSchema,
  MemoryUsefulnessRowSchema,
  CausalLaneRowSchema,
  MemoryTripleRowSchema,
  SpreadNodeRowSchema,
  LcdMessageRowSchema,
  LcdMessagePartRowSchema,
  LcdSummaryRowSchema,
  LcdSummaryMessageRowSchema,
  LcdSummaryParentRowSchema,
  LcdContextItemRowSchema,
} from "./row-schemas.js";
// AuditEventDbRowSchema is co-located with its createRowMapper consumer
// (audit-mutations.ts), NOT in row-schemas.ts (the 800-line cap) — the
// SessionSummaryRollupDbRowSchema precedent.
import { AuditEventDbRowSchema } from "./observability-store/audit-mutations.js";

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

  it("LcdMessageRowSchema z.infer matches LcdMessageRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof LcdMessageRowSchema>>().toEqualTypeOf<LcdMessageRow>();
  });

  it("LcdMessagePartRowSchema z.infer matches LcdMessagePartRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof LcdMessagePartRowSchema>>().toEqualTypeOf<LcdMessagePartRow>();
  });

  it("LcdSummaryRowSchema z.infer matches LcdSummaryRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof LcdSummaryRowSchema>>().toEqualTypeOf<LcdSummaryRow>();
  });

  it("LcdSummaryMessageRowSchema z.infer matches LcdSummaryMessageRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof LcdSummaryMessageRowSchema>>().toEqualTypeOf<LcdSummaryMessageRow>();
  });

  it("LcdSummaryParentRowSchema z.infer matches LcdSummaryParentRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof LcdSummaryParentRowSchema>>().toEqualTypeOf<LcdSummaryParentRow>();
  });

  it("LcdContextItemRowSchema z.infer matches LcdContextItemRow interface from types.ts", () => {
    expectTypeOf<z.infer<typeof LcdContextItemRowSchema>>().toEqualTypeOf<LcdContextItemRow>();
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

describe("row-schemas — MemoryRowSchema occurred_at column", () => {
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
      proof_count: null,
      source_ids: null,
      consolidated_at: null,
      confidence: null,
      history: null,
      observation_kind: null,
      pattern_type: null,
      lifecycle_demoted_at: null,
      evicted_at: null,
      strength: null,
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
      // Cost-correctness columns (cache_retention DROPPED).
      warmup_turn: 1,
      cache_eligible: 0,
      cost_correction: 0.0005,
      pending_cache_investment_usd: 0.001,
      pricing_state: "priced",
      // The JSON distinct-tool array column (nullable).
      tool_tag: JSON.stringify(["bash", "read"]),
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

  it("DeliveryDbRowSchema accepts unknown call counts as null", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      trace_id: "trace-1",
      agent_id: "agent-1",
      channel_type: "telegram",
      channel_id: "tg-1",
      session_key: "sess-1",
      status: "timeout",
      latency_ms: 200,
      error_message: "",
      message_preview: "",
      tool_calls: null,
      llm_calls: null,
      tokens_total: 0,
      cost_total: 0,
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

  it("AuditEventDbRowSchema parses a complete obs_audit_events row", () => {
    const sample = {
      id: "evt-1",
      tenant_id: "tenant-1",
      agent_id: "agent-1",
      ts: 1_700_000_000_000,
      kind: "secret_access",
      classification: null,
      action: "OPENAI_API_KEY",
      actor: "agent-1",
      outcome: "denied",
      severity: "warning",
      trace_id: "trace-1",
      refs: '{"secretName":"OPENAI_API_KEY"}',
    };
    expect(AuditEventDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("AuditEventDbRowSchema accepts null for the nullable columns (tenant-less, system-scoped)", () => {
    const sample = {
      id: "evt-2",
      tenant_id: "", // the system-scope sentinel (NOT NULL → empty string)
      agent_id: null,
      ts: 1,
      kind: "command_blocked",
      classification: null,
      action: null,
      actor: null,
      outcome: null,
      severity: null,
      trace_id: null,
      refs: null,
    };
    expect(AuditEventDbRowSchema.safeParse(sample).success).toBe(true);
  });

  it("AuditEventDbRowSchema rejects an extra column (strictObject invariant)", () => {
    const sample = {
      id: "evt-3",
      tenant_id: "t",
      agent_id: null,
      ts: 1,
      kind: "audit",
      classification: null,
      action: null,
      actor: null,
      outcome: null,
      severity: null,
      trace_id: null,
      refs: null,
      extra_column_not_in_schema: "x",
    };
    expect(AuditEventDbRowSchema.safeParse(sample).success).toBe(false);
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

  it("TokenUsageDbRowSchema rejects rows missing required fields", () => {
    const sample = {
      id: 1,
      timestamp: 1700000000000,
      // ... missing all other required columns
    };
    expect(TokenUsageDbRowSchema.safeParse(sample).success).toBe(false);
  });

  // --- Entity-association row schemas ---

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

  it("EntityListRowSchema parses the listEntities projection (no canonical_key)", () => {
    const sample = {
      id: "e1",
      canonical_name: "Acme Corp",
      mention_count: 4,
      first_seen: 1700000000000,
      last_seen: 1700000009000,
    };
    expect(EntityListRowSchema.safeParse(sample).success).toBe(true);
  });

  it("EntityListRowSchema rejects the DB-internal canonical_key column (strictObject keeps it out of the diagnostic projection)", () => {
    const sample = {
      id: "e1",
      canonical_name: "Acme Corp",
      canonical_key: "acme corp",
      mention_count: 4,
      first_seen: 1700000000000,
      last_seen: 1700000009000,
    };
    expect(EntityListRowSchema.safeParse(sample).success).toBe(false);
  });

  // --- MemoryUsefulnessRowSchema — the read projection
  // gains `intent`. A strictObject WITHOUT `intent` would REJECT a row carrying
  // it, so the schema + the SELECT projection move together. ---

  it("MemoryUsefulnessRowSchema parses a per-intent row (intent survives the strict projection)", () => {
    const parsed = MemoryUsefulnessRowSchema.safeParse({
      memory_id: "m1",
      intent: "temporal",
      used_count: 3,
      ignored_count: 1,
      last_useful_at: 1700000000000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.intent).toBe("temporal");
  });

  it("MemoryUsefulnessRowSchema parses the global-bucket row (intent: '')", () => {
    const parsed = MemoryUsefulnessRowSchema.safeParse({
      memory_id: "m2",
      intent: "",
      used_count: 0,
      ignored_count: 2,
      last_useful_at: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.intent).toBe("");
      expect(parsed.data.last_useful_at).toBeNull();
    }
  });

  it("MemoryUsefulnessRowSchema rejects a row MISSING the intent column (strict requires every projected column → the read must SELECT intent)", () => {
    expect(
      MemoryUsefulnessRowSchema.safeParse({
        memory_id: "m3",
        // intent omitted
        used_count: 1,
        ignored_count: 0,
        last_useful_at: 100,
      }).success,
    ).toBe(false);
  });

  it("CausalLaneRowSchema parses the one-hop edge-lookup projection (linked + confidence)", () => {
    expect(CausalLaneRowSchema.safeParse({ linked: "m2", confidence: 0.9 }).success).toBe(true);
  });

  it("CausalLaneRowSchema rejects a non-numeric confidence", () => {
    expect(CausalLaneRowSchema.safeParse({ linked: "m2", confidence: "high" }).success).toBe(false);
  });

  it("CausalLaneRowSchema rejects an unexpected column (strictObject keeps the projection minimal)", () => {
    expect(
      CausalLaneRowSchema.safeParse({ linked: "m2", confidence: 0.9, tenant_id: "t" }).success,
    ).toBe(false);
  });

  // --- MemoryTripleRowSchema ---

  const fullTripleRow = {
    id: "tr1",
    tenant_id: "t1",
    agent_id: "a1",
    subject: "alice",
    predicate: "lives_in",
    object: "berlin",
    trust: "learned" as const,
    t_valid_start: 1700000000000,
    t_valid_end: 1700000009000,
    t_ingested: 1700000000500,
    expired_at: 1700000009000,
    t_occurred: 1699999990000,
    t_occurred_end: 1699999999000,
    source_memory_id: "mem-1",
    confidence: 0.8,
  };

  it("MemoryTripleRowSchema parses a fully-populated memory_triples row", () => {
    expect(MemoryTripleRowSchema.safeParse(fullTripleRow).success).toBe(true);
  });

  it("MemoryTripleRowSchema parses a current-truth row with NULL end-stamps/occurred/provenance/confidence", () => {
    const currentTruthRow = {
      id: "tr2",
      tenant_id: "t1",
      agent_id: "a1",
      subject: "alice",
      predicate: "lives_in",
      object: "berlin",
      trust: "system" as const,
      t_valid_start: 1700000000000,
      t_valid_end: null,
      t_ingested: 1700000000500,
      expired_at: null,
      t_occurred: null,
      t_occurred_end: null,
      source_memory_id: null,
      confidence: null,
    };
    const parsed = MemoryTripleRowSchema.safeParse(currentTruthRow);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.t_valid_end).toBeNull();
      expect(parsed.data.expired_at).toBeNull();
      expect(parsed.data.source_memory_id).toBeNull();
      expect(parsed.data.confidence).toBeNull();
    }
  });

  it("MemoryTripleRowSchema accepts each trust on the ladder and rejects an out-of-ladder trust", () => {
    for (const trust of ["system", "learned", "external"] as const) {
      expect(MemoryTripleRowSchema.safeParse({ ...fullTripleRow, trust }).success).toBe(true);
    }
    expect(MemoryTripleRowSchema.safeParse({ ...fullTripleRow, trust: "nope" }).success).toBe(false);
  });

  it("MemoryTripleRowSchema rejects an unexpected extra column (z.strictObject)", () => {
    expect(
      MemoryTripleRowSchema.safeParse({ ...fullTripleRow, rogue_column: "x" }).success,
    ).toBe(false);
  });

  it("MemoryTripleRowSchema rejects a row missing a required column (subject)", () => {
    const { subject: _omit, ...withoutSubject } = fullTripleRow;
    expect(MemoryTripleRowSchema.safeParse(withoutSubject).success).toBe(false);
  });

  // --- SpreadNodeRowSchema — the recursive-CTE node projection ---
  // The graph-spread walk's `SELECT DISTINCT node, depth FROM walk WHERE depth > 0`
  // returns ONLY (node, depth) per reached subject — a minimal projection (the full
  // hydrate happens via a second scoped SELECT on the source memory). Parsed via
  // createRowMapper in spreadLane — never `as Row[]`.

  it("SpreadNodeRowSchema parses the recursive-CTE node projection (node + depth)", () => {
    expect(SpreadNodeRowSchema.safeParse({ node: "berlin", depth: 1 }).success).toBe(true);
  });

  it("SpreadNodeRowSchema rejects a non-numeric depth", () => {
    expect(SpreadNodeRowSchema.safeParse({ node: "berlin", depth: "one" }).success).toBe(false);
  });

  it("SpreadNodeRowSchema rejects an unexpected extra column (z.strictObject keeps the projection minimal)", () => {
    expect(
      SpreadNodeRowSchema.safeParse({ node: "berlin", depth: 1, rogue: "x" }).success,
    ).toBe(false);
  });

  // --- LCD store row schemas ---
  // lcd_messages carries the tenant/agent/session isolation columns; the strict
  // schema rejects an extra column (drift catch) and accepts NULL on the
  // nullable tool columns (SQLite NULL ≠ undefined for non-tool_result parts).

  const fullLcdMessageRow = {
    id: "msg-1",
    conversation_id: "conv-1",
    tenant_id: "tenant-1",
    agent_id: "agent-1",
    session_key: "sess-1",
    seq: 0,
    role: "assistant",
    token_count: 12,
    created_at: 1700000000000,
  };

  it("LcdMessageRowSchema parses a fully-populated lcd_messages row", () => {
    expect(LcdMessageRowSchema.safeParse(fullLcdMessageRow).success).toBe(true);
  });

  it("LcdMessageRowSchema rejects an unexpected extra column (z.strictObject drift catch)", () => {
    expect(
      LcdMessageRowSchema.safeParse({ ...fullLcdMessageRow, rogue_column: "x" }).success,
    ).toBe(false);
  });

  it("LcdMessageRowSchema rejects a row missing the session_key isolation column", () => {
    const { session_key: _omit, ...withoutSessionKey } = fullLcdMessageRow;
    expect(LcdMessageRowSchema.safeParse(withoutSessionKey).success).toBe(false);
  });

  const fullLcdPartRow = {
    id: "part-1",
    message_id: "msg-1",
    ordinal: 0,
    kind: "tool_use",
    tool_call_id: "call-1",
    tool_name: "search",
    tool_input: '{"q":"berlin"}',
    tool_output: null,
    is_error: null,
    metadata: '{"raw":{"type":"toolCall"}}',
  };

  it("LcdMessagePartRowSchema parses a fully-populated tool_use part row", () => {
    expect(LcdMessagePartRowSchema.safeParse(fullLcdPartRow).success).toBe(true);
  });

  it("LcdMessagePartRowSchema accepts a NULL is_error (nullable for non-tool_result parts)", () => {
    const textPart = {
      id: "part-2",
      message_id: "msg-1",
      ordinal: 1,
      kind: "text",
      tool_call_id: null,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      is_error: null,
      metadata: '{"raw":{"type":"text","text":"hi"}}',
    };
    const parsed = LcdMessagePartRowSchema.safeParse(textPart);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.is_error).toBeNull();
  });

  it("LcdMessagePartRowSchema accepts a 0/1 is_error on a tool_result part", () => {
    const errPart = { ...fullLcdPartRow, kind: "tool_result", tool_output: "[]", is_error: 1 };
    const parsed = LcdMessagePartRowSchema.safeParse(errPart);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.is_error).toBe(1);
  });

  it("LcdMessagePartRowSchema rejects an unexpected extra column (z.strictObject drift catch)", () => {
    expect(
      LcdMessagePartRowSchema.safeParse({ ...fullLcdPartRow, rogue_column: "x" }).success,
    ).toBe(false);
  });

  // --- LCD compaction row schemas ---
  // lcd_summaries / lcd_summary_messages / lcd_context_items carry the
  // tenant/agent scoping columns; the strict schema rejects an extra column
  // (drift catch) and a missing scoping column (a dropped scope column would be
  // a cross-tenant hole).

  const fullLcdSummaryRow = {
    summary_id: "sum-1",
    conversation_id: "conv-1",
    tenant_id: "tenant-1",
    agent_id: "agent-1",
    session_key: "sess-1",
    kind: "leaf",
    depth: 0,
    earliest_at: 1700000000000,
    latest_at: 1700000005000,
    descendant_count: 3,
    token_count: 120,
    content: "a leaf summary",
    file_ids: "[]",
    taint: 0,
    fallback: 0,
    created_at: 1700000006000,
  };

  it("LcdSummaryRowSchema parses a fully-populated lcd_summaries row", () => {
    expect(LcdSummaryRowSchema.safeParse(fullLcdSummaryRow).success).toBe(true);
  });

  it("LcdSummaryRowSchema accepts taint/fallback as the 0/1 integer bool", () => {
    const parsed = LcdSummaryRowSchema.safeParse({ ...fullLcdSummaryRow, taint: 1, fallback: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.taint).toBe(1);
      expect(parsed.data.fallback).toBe(1);
    }
  });

  it("LcdSummaryRowSchema rejects an unexpected extra column (z.strictObject drift catch)", () => {
    expect(
      LcdSummaryRowSchema.safeParse({ ...fullLcdSummaryRow, rogue_column: "x" }).success,
    ).toBe(false);
  });

  it("LcdSummaryRowSchema rejects a row missing the agent_id scoping column (cross-tenant guard)", () => {
    const { agent_id: _omit, ...withoutAgentId } = fullLcdSummaryRow;
    expect(LcdSummaryRowSchema.safeParse(withoutAgentId).success).toBe(false);
  });

  it("LcdSummaryMessageRowSchema parses the leaf→message link row", () => {
    expect(
      LcdSummaryMessageRowSchema.safeParse({ summary_id: "sum-1", message_id: "msg-1" }).success,
    ).toBe(true);
  });

  it("LcdSummaryMessageRowSchema rejects an unexpected extra column (z.strictObject keeps the link minimal)", () => {
    expect(
      LcdSummaryMessageRowSchema.safeParse({
        summary_id: "sum-1",
        message_id: "msg-1",
        rogue: "x",
      }).success,
    ).toBe(false);
  });

  it("LcdSummaryParentRowSchema parses the condensed→child link row", () => {
    expect(
      LcdSummaryParentRowSchema.safeParse({
        parent_summary_id: "cond-1",
        child_summary_id: "leaf-1",
      }).success,
    ).toBe(true);
  });

  it("LcdSummaryParentRowSchema rejects an unexpected extra column (z.strictObject keeps the edge minimal)", () => {
    expect(
      LcdSummaryParentRowSchema.safeParse({
        parent_summary_id: "cond-1",
        child_summary_id: "leaf-1",
        rogue: "x",
      }).success,
    ).toBe(false);
  });

  const fullLcdContextItemRow = {
    id: "ci-1",
    conversation_id: "conv-1",
    tenant_id: "tenant-1",
    agent_id: "agent-1",
    session_key: "sess-1",
    ordinal: 0,
    ref_kind: "message",
    ref_id: "msg-1",
  };

  it("LcdContextItemRowSchema parses a fully-populated lcd_context_items row", () => {
    expect(LcdContextItemRowSchema.safeParse(fullLcdContextItemRow).success).toBe(true);
  });

  it("LcdContextItemRowSchema parses a summary-ref row (ref_kind 'summary')", () => {
    const parsed = LcdContextItemRowSchema.safeParse({
      ...fullLcdContextItemRow,
      ref_kind: "summary",
      ref_id: "sum-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ref_kind).toBe("summary");
  });

  it("LcdContextItemRowSchema rejects an unexpected extra column (z.strictObject drift catch)", () => {
    expect(
      LcdContextItemRowSchema.safeParse({ ...fullLcdContextItemRow, rogue_column: "x" }).success,
    ).toBe(false);
  });

  it("LcdContextItemRowSchema rejects a row missing the session_key scoping column (cross-tenant guard)", () => {
    const { session_key: _omit, ...withoutSessionKey } = fullLcdContextItemRow;
    expect(LcdContextItemRowSchema.safeParse(withoutSessionKey).success).toBe(false);
  });
});
