// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createConversationRef } from "@comis/core";
import {
  CronPersistedJobSchema,
  CronPersistedScheduleSchema,
  resolveCronAuthoringSchedule,
  computeNextRunAtMs,
} from "./index.js";

const NOW_MS = 1_800_000_000_000;

function target(agentId = "agent-a") {
  const destinationEndpoint = {
    channelType: "telegram",
    channelInstanceId: "telegram-bot-a",
    conversationId: "chat-a",
    conversationKind: "direct" as const,
  };
  const conversationScope = {
    tenantId: "tenant-a",
    agentId,
    partition: { kind: "endpoint-conversation" as const, endpoint: destinationEndpoint },
  };
  const conversationRef = createConversationRef(conversationScope);
  if (!conversationRef.ok) throw conversationRef.error;
  return {
    conversation: { conversationScope, conversationRef: conversationRef.value },
    destinationEndpoint,
  };
}

function base() {
  return {
    id: "job-a",
    name: "Status update",
    agentId: "agent-a",
    schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: NOW_MS },
    lifecycle: {
      status: "scheduled" as const,
      nextRunAtMs: NOW_MS + 60_000,
      consecutiveDependencyErrors: 0,
    },
  };
}

describe("strict persisted cron contracts", () => {
  it("accepts each legal persisted payload variant with only its applicable fields", () => {
    const heartbeat = CronPersistedJobSchema.parse({
      ...base(),
      source: "authored",
      payload: { kind: "heartbeat_event", text: "inspect queue", wakeMode: "now" },
    });
    const delivery = CronPersistedJobSchema.parse({
      ...base(),
      id: "job-b",
      source: "authored",
      payload: { kind: "delivery", text: "maintenance complete" },
      deliveryTarget: target(),
    });
    const turn = CronPersistedJobSchema.parse({
      ...base(),
      id: "job-c",
      source: "authored",
      payload: { kind: "agent_turn", message: "summarize health" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 4 },
      continuationMode: "origin_history",
      deliveryTarget: target(),
      wakeGate: { script: "return { wake: true };", language: "js", timeoutSeconds: 10 },
    });
    const internal = CronPersistedJobSchema.parse({
      ...base(),
      id: "memory-review-agent-a",
      source: "built_in",
      payload: { kind: "internal_action", action: "memory_review" },
    });

    expect([heartbeat.payload.kind, delivery.payload.kind, turn.payload.kind, internal.payload.kind])
      .toEqual(["heartbeat_event", "delivery", "agent_turn", "internal_action"]);
  });

  it("rejects old overloaded payload, schedule, and lifecycle fields without aliases", () => {
    const oldJob = {
      ...base(),
      source: "authored",
      schedule: { kind: "in", seconds: 10 },
      payload: { kind: "system_event", text: "hello" },
      enabled: true,
      nextRunAtMs: NOW_MS + 10_000,
      sessionTarget: "isolated",
      forwardToMain: false,
    };

    expect(CronPersistedJobSchema.safeParse(oldJob).success).toBe(false);
    expect(CronPersistedScheduleSchema.safeParse({ kind: "cron", expr: "0 * * * *" }).success).toBe(false);
    expect(CronPersistedScheduleSchema.safeParse({ kind: "at", at: "2027-01-01" }).success).toBe(false);
  });

  it("requires exact target authority and matching job ownership", () => {
    const mismatched = {
      ...base(),
      source: "authored",
      payload: { kind: "delivery", text: "hello" },
      deliveryTarget: target("agent-b"),
    };
    const endpointMismatch = {
      ...base(),
      source: "authored",
      payload: { kind: "delivery", text: "hello" },
      deliveryTarget: {
        ...target(),
        destinationEndpoint: {
          channelType: "telegram",
          channelInstanceId: "telegram-bot-a",
          conversationId: "different-chat",
          conversationKind: "direct",
        },
      },
    };

    expect(CronPersistedJobSchema.safeParse(mismatched).success).toBe(false);
    expect(CronPersistedJobSchema.safeParse(endpointMismatch).success).toBe(false);
  });

  it("requires origin history to carry an exact delivery target", () => {
    expect(CronPersistedJobSchema.safeParse({
      ...base(),
      source: "authored",
      payload: { kind: "agent_turn", message: "hello" },
      sessionPolicy: { strategy: "fresh" },
      continuationMode: "origin_history",
    }).success).toBe(false);
  });

  it("enforces UTF-8 byte limits and bounded rolling history", () => {
    expect(CronPersistedJobSchema.safeParse({
      ...base(),
      source: "authored",
      payload: { kind: "agent_turn", message: "é".repeat(32_769) },
      sessionPolicy: { strategy: "fresh" },
      continuationMode: "none",
    }).success).toBe(false);
    expect(CronPersistedJobSchema.safeParse({
      ...base(),
      source: "authored",
      payload: { kind: "agent_turn", message: "hello" },
      sessionPolicy: { strategy: "rolling", maxHistoryTurns: 21 },
      continuationMode: "none",
    }).success).toBe(false);
  });
});

describe("cron authoring schedule resolution", () => {
  it("persists explicit zones, interval anchors, and relative reminders as absolute instants", () => {
    expect(resolveCronAuthoringSchedule({ kind: "cron", expr: "0 * * * *" }, NOW_MS, ""))
      .toEqual({ ok: true, value: { kind: "cron", expr: "0 * * * *", tz: "UTC" } });
    expect(resolveCronAuthoringSchedule({ kind: "every", everyMs: 60_000 }, NOW_MS, "UTC"))
      .toEqual({ ok: true, value: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS } });
    expect(resolveCronAuthoringSchedule({ kind: "in", seconds: 30 }, NOW_MS, "UTC"))
      .toEqual({ ok: true, value: { kind: "at", atMs: NOW_MS + 30_000 } });
  });

  it("rejects past, conflicting-zone, DST-gap, and ambiguous-fold authoring", () => {
    expect(resolveCronAuthoringSchedule({ kind: "at", at: "2026-01-01T00:00:00Z" }, NOW_MS, "UTC").ok).toBe(false);
    expect(resolveCronAuthoringSchedule({ kind: "at", at: "2030-01-01T00:00:00Z", tz: "UTC" }, NOW_MS, "UTC").ok).toBe(false);
    expect(resolveCronAuthoringSchedule({ kind: "at", at: "2027-03-14T02:30:00", tz: "America/New_York" }, NOW_MS, "UTC").ok).toBe(false);
    expect(resolveCronAuthoringSchedule({ kind: "at", at: "2027-11-07T01:30:00", tz: "America/New_York" }, NOW_MS, "UTC").ok).toBe(false);
  });

  it("resolves both DST-fold choices and computes recurrence strictly after the lower bound", () => {
    const earlier = resolveCronAuthoringSchedule({
      kind: "at", at: "2027-11-07T01:30:00", tz: "America/New_York", fold: "earlier",
    }, NOW_MS, "UTC");
    const later = resolveCronAuthoringSchedule({
      kind: "at", at: "2027-11-07T01:30:00", tz: "America/New_York", fold: "later",
    }, NOW_MS, "UTC");
    expect(earlier.ok && later.ok && later.value.kind === "at" && earlier.value.kind === "at"
      ? later.value.atMs - earlier.value.atMs
      : 0).toBe(3_600_000);

    const every = { kind: "every" as const, everyMs: 60_000, anchorMs: NOW_MS };
    expect(computeNextRunAtMs(every, NOW_MS)).toBe(NOW_MS + 60_000);
    expect(computeNextRunAtMs(every, NOW_MS - 1)).toBe(NOW_MS);
  });

  it("rejects unsafe arithmetic instead of wrapping schedule epochs", () => {
    const result = resolveCronAuthoringSchedule(
      { kind: "in", seconds: 10 },
      Number.MAX_SAFE_INTEGER - 1_000,
      "UTC",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects invalid authored epochs timezones and cron expressions", () => {
    expect(resolveCronAuthoringSchedule(
      { kind: "every", everyMs: 60_000 },
      -1,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(resolveCronAuthoringSchedule(
      { kind: "every", everyMs: 60_000 },
      NOW_MS,
      "Not/A_Zone",
    )).toMatchObject({ ok: false, error: { code: "invalid_timezone" } });
    expect(resolveCronAuthoringSchedule(
      { kind: "cron", expr: "0 * * * *", tz: "Not/A_Zone" },
      NOW_MS,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "invalid_timezone" } });
    expect(resolveCronAuthoringSchedule(
      { kind: "cron", expr: "not-a-cron", tz: "UTC" },
      NOW_MS,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "invalid_expression" } });
  });

  it("rejects invalid wall clocks offsets and fold conflicts", () => {
    expect(resolveCronAuthoringSchedule(
      { kind: "at", at: "not-a-date", tz: "UTC" },
      NOW_MS,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(resolveCronAuthoringSchedule(
      { kind: "at", at: "2027-02-30T12:00:00", tz: "UTC" },
      NOW_MS,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(resolveCronAuthoringSchedule(
      { kind: "at", at: "2030-01-01T00:00:00Z", fold: "earlier" },
      NOW_MS,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "conflicting_timezone" } });
    expect(resolveCronAuthoringSchedule(
      { kind: "at", at: "+275761-09-13T00:00:00.000Z" },
      NOW_MS,
      "UTC",
    )).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("preserves explicit interval anchors and offset-bearing instants", () => {
    expect(resolveCronAuthoringSchedule(
      { kind: "every", everyMs: 60_000, anchorMs: NOW_MS + 10_000 },
      NOW_MS,
      "UTC",
    )).toEqual({
      ok: true,
      value: { kind: "every", everyMs: 60_000, anchorMs: NOW_MS + 10_000 },
    });
    expect(resolveCronAuthoringSchedule(
      { kind: "at", at: "2030-01-01T00:00:00+02:00" },
      NOW_MS,
      "UTC",
    )).toEqual({
      ok: true,
      value: { kind: "at", atMs: Date.parse("2030-01-01T00:00:00+02:00") },
    });
  });
});
