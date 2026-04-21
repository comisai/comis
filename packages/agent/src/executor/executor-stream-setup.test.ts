// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for skipCacheWrite derivation in executor-stream-setup.
 *
 * The skipCacheWrite flag at line 267 of executor-stream-setup.ts is derived as:
 *   skipCacheWrite: !!executionOverrides?.spawnPacket
 *
 * This means:
 * - When spawnPacket is defined (normal sub-agent spawn): skipCacheWrite = true
 * - When spawnPacket is undefined (persistent session reuse): skipCacheWrite = false
 *
 * These tests verify the derivation logic in isolation since setupStreamWrappers
 * has deeply nested dependencies that make full integration testing impractical.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Extracted derivation under test
// ---------------------------------------------------------------------------

/**
 * Reproduce the exact skipCacheWrite derivation from executor-stream-setup.ts line 267:
 *   skipCacheWrite: !!executionOverrides?.spawnPacket
 *
 * This is a pure expression test -- validates the boolean logic matches expectations.
 */
function deriveSkipCacheWrite(executionOverrides?: { spawnPacket?: unknown }): boolean {
  return !!executionOverrides?.spawnPacket;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skipCacheWrite derivation", () => {
  it("skipCacheWrite is false when executionOverrides.spawnPacket is undefined (reuse session path)", () => {
    // Persistent session reuse spawns have no spawnPacket
    // because setup-cross-session skips SpawnPacket construction for isReuseSession.
    // This means the sub-agent WILL write its own cache entries -- correct behavior
    // for persistent sessions that need cache prefix continuity.
    const result = deriveSkipCacheWrite({ spawnPacket: undefined });
    expect(result).toBe(false);
  });

  it("skipCacheWrite is true when executionOverrides.spawnPacket is defined (normal sub-agent)", () => {
    // Normal sub-agent spawns get a SpawnPacket with parent cache info.
    // skipCacheWrite = true because the parent already wrote the cache prefix.
    const mockSpawnPacket = { task: "test", parentSummary: "summary" };
    const result = deriveSkipCacheWrite({ spawnPacket: mockSpawnPacket });
    expect(result).toBe(true);
  });

  it("skipCacheWrite is false when executionOverrides is undefined entirely", () => {
    // No execution overrides at all (e.g., direct user session)
    const result = deriveSkipCacheWrite(undefined);
    expect(result).toBe(false);
  });

  it("skipCacheWrite is false when executionOverrides is empty object", () => {
    // Execution overrides present but no spawnPacket field
    const result = deriveSkipCacheWrite({});
    expect(result).toBe(false);
  });

  it("skipCacheWrite is true for any truthy spawnPacket value", () => {
    // Even a minimal object is truthy
    expect(deriveSkipCacheWrite({ spawnPacket: {} })).toBe(true);
    expect(deriveSkipCacheWrite({ spawnPacket: { task: "" } })).toBe(true);
  });

  it("skipCacheWrite is false for null spawnPacket", () => {
    // null is falsy
    expect(deriveSkipCacheWrite({ spawnPacket: null })).toBe(false);
  });
});
