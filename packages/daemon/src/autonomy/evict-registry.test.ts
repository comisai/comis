// SPDX-License-Identifier: Apache-2.0
/**
 * Contract for `createEvictRegistry`.
 *
 * The daemon-wide evicted-`rootRunId` set — the shared state between the
 * `autonomy.evict` handler (writes via `mark`) and the chokepoint (reads
 * via `isEvicted` at the NEXT gate decision — mid-run, not next spawn).
 * Evict DEMOTES a run's profile to `default`; it does NOT abort. The registry is
 * the read/write primitive that makes the demotion mid-run-effective.
 *
 * Pins:
 *   - `isEvicted` is false for an unknown root (no demotion until marked),
 *   - `mark` flips a SINGLE root (per-root isolation — a sibling stays live),
 *   - `mark` is idempotent and reports `{ newlyEvicted }` (true first, false
 *     after — so the handler can report whether it changed state),
 *   - `clear` (run-end cleanup) drops the flag so the set cannot grow unbounded
 *     under a storm of completed roots,
 *   - `mark` logs content-free (§2.7 — method/id-shaped fields only, no body).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createEvictRegistry } from "./evict-registry.js";

describe("createEvictRegistry — the daemon-wide evicted-rootRunId set", () => {
  it("isEvicted is false for a root that was never marked", () => {
    const reg = createEvictRegistry({ logger: createMockLogger() });
    expect(reg.isEvicted("root-A")).toBe(false);
  });

  it("mark flips a single root; a sibling root stays un-evicted (per-root isolation)", () => {
    const reg = createEvictRegistry({ logger: createMockLogger() });
    reg.mark("root-A");
    expect(reg.isEvicted("root-A")).toBe(true);
    expect(reg.isEvicted("root-B")).toBe(false);
  });

  it("mark is idempotent and reports newlyEvicted (true on the first, false after)", () => {
    const reg = createEvictRegistry({ logger: createMockLogger() });
    expect(reg.mark("root-A")).toEqual({ newlyEvicted: true });
    // Already evicted — still evicted, but the state did not change.
    expect(reg.mark("root-A")).toEqual({ newlyEvicted: false });
    expect(reg.isEvicted("root-A")).toBe(true);
  });

  it("clear drops the flag (run-end cleanup) so isEvicted returns to false", () => {
    const reg = createEvictRegistry({ logger: createMockLogger() });
    reg.mark("root-A");
    expect(reg.isEvicted("root-A")).toBe(true);
    reg.clear("root-A");
    expect(reg.isEvicted("root-A")).toBe(false);
  });

  it("clear of an unknown root is a no-op (idempotent cleanup)", () => {
    const reg = createEvictRegistry({ logger: createMockLogger() });
    expect(() => reg.clear("never-seen")).not.toThrow();
    expect(reg.isEvicted("never-seen")).toBe(false);
  });

  it("mark logs content-free — method/newlyEvicted-shaped fields only, never a body (§2.7)", () => {
    const logger = createMockLogger();
    const reg = createEvictRegistry({ logger });
    reg.mark("root-A");

    // A log line fired (INFO or DEBUG) and its structured payload carries no body
    // field — only id/enum-shaped keys.
    const calls = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.debug).mock.calls,
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const [payload] of calls) {
      const fields = payload as Record<string, unknown>;
      expect(fields).not.toHaveProperty("body");
      expect(fields).not.toHaveProperty("params");
      expect(fields).not.toHaveProperty("message");
    }
  });
});
