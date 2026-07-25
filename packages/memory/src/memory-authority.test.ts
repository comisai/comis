// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  requireMemoryAuthorityPartition,
  requireMemoryAuthorityPartitionForMemory,
} from "./memory-authority.js";

describe("memory authority partition invariants", () => {
  it("rejects an authority partition insertion that cannot be read back", () => {
    const statement = { run: vi.fn(), get: vi.fn(() => undefined) };
    const db = { prepare: vi.fn(() => statement) } as unknown as Database.Database;

    expect(() => requireMemoryAuthorityPartition(db, {
      tenantId: "tenant_a",
      agentId: "agent_a",
      visibilityKey: "agent-shared",
    })).toThrow(/could not be resolved/i);
  });

  it("rejects authority lookup for an unknown memory row", () => {
    const statement = { get: vi.fn(() => undefined) };
    const db = { prepare: vi.fn(() => statement) } as unknown as Database.Database;

    expect(() => requireMemoryAuthorityPartitionForMemory(db, "missing_memory"))
      .toThrow(/unknown memory row/i);
  });
});
