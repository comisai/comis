// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLastKnownModelTracker } from "./last-known-model.js";

describe("createLastKnownModelTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recordSuccess stores entry retrievable by getLastKnown", () => {
    const tracker = createLastKnownModelTracker();
    tracker.recordSuccess("agent-1", "anthropic", "claude-3-opus");

    const entry = tracker.getLastKnown("agent-1");
    expect(entry).toEqual({
      provider: "anthropic",
      model: "claude-3-opus",
      timestamp: Date.now(),
    });
  });

  it("getLastKnown returns undefined for unknown agent", () => {
    const tracker = createLastKnownModelTracker();
    expect(tracker.getLastKnown("nonexistent")).toBeUndefined();
  });

  it("recordSuccess overwrites previous entry for same agent", () => {
    const tracker = createLastKnownModelTracker();
    tracker.recordSuccess("agent-1", "anthropic", "claude-3-opus");

    vi.advanceTimersByTime(1000);
    tracker.recordSuccess("agent-1", "openai", "gpt-4");

    const entry = tracker.getLastKnown("agent-1");
    expect(entry).toEqual({
      provider: "openai",
      model: "gpt-4",
      timestamp: Date.now(),
    });
  });

  it("getAnyKnown returns most recent entry across agents", () => {
    const tracker = createLastKnownModelTracker();

    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    tracker.recordSuccess("agent-1", "anthropic", "claude-3-opus");

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    tracker.recordSuccess("agent-2", "openai", "gpt-4");

    vi.setSystemTime(new Date("2026-01-01T00:00:03Z"));
    tracker.recordSuccess("agent-3", "google", "gemini-pro");

    const entry = tracker.getAnyKnown();
    expect(entry).toEqual({
      provider: "openai",
      model: "gpt-4",
      timestamp: new Date("2026-01-01T00:00:05Z").getTime(),
    });
  });

  it("getAnyKnown skips excluded provider", () => {
    const tracker = createLastKnownModelTracker();

    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    tracker.recordSuccess("agent-1", "anthropic", "claude-3-opus");

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    tracker.recordSuccess("agent-2", "anthropic", "claude-3-sonnet");

    vi.setSystemTime(new Date("2026-01-01T00:00:03Z"));
    tracker.recordSuccess("agent-3", "openai", "gpt-4");

    // Exclude anthropic -- should return the openai entry
    const entry = tracker.getAnyKnown("anthropic");
    expect(entry).toEqual({
      provider: "openai",
      model: "gpt-4",
      timestamp: new Date("2026-01-01T00:00:03Z").getTime(),
    });
  });

  it("getAnyKnown returns undefined when all entries match excluded provider", () => {
    const tracker = createLastKnownModelTracker();
    tracker.recordSuccess("agent-1", "anthropic", "claude-3-opus");
    tracker.recordSuccess("agent-2", "anthropic", "claude-3-sonnet");

    expect(tracker.getAnyKnown("anthropic")).toBeUndefined();
  });

  it("getAnyKnown returns undefined when no entries exist", () => {
    const tracker = createLastKnownModelTracker();
    expect(tracker.getAnyKnown()).toBeUndefined();
  });
});
