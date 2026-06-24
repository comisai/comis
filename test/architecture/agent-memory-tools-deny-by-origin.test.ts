// SPDX-License-Identifier: Apache-2.0
/**
 * MD-02 — the basic agent memory tools must have AGENT-REACHABLE backing RPC
 * methods (`scopes:["rpc"]`, i.e. NOT in the deny-by-origin admin set), or the
 * agent's `memory_*` tool call is denied at the `assertNotAgentOrigin`
 * chokepoint before the tool ever runs.
 *
 * Live regression this guards (2026-06-24, verified-learning VPS run): the
 * `memory_store` agent tool failed with
 *   "Control-plane method memory.store is not reachable from an agent origin"
 * — the agent could not store a memory at all — because `MemoryStoreContract`
 * was `scopes:["admin"]` while its siblings `memory.ask` / `memory.search_files`
 * / `memory.get_file` were `["rpc"]`. `["admin"]` puts the method in
 * `ADMIN_METHODS` (`rpc-dispatch.ts`, derived via `scopes.includes("admin")`),
 * and the deny-by-origin chokepoint throws for any `_agentId`-bearing call — yet
 * `memory.store`'s own handler has a first-class agent path (defaults to
 * `learned` trust). Same CR-01/MD-01 regression class as the earlier
 * `message.send` / `skills.*` / `session.list` admin→rpc fixes.
 *
 * Why a NEW test (the blind spot): `admin-handlers-deny-by-origin.test.ts`
 * (210-GAP) keys off `HANDLER_CAPABILITY_MAP`, but the memory surface is
 * deliberately NOT enumerated there ("deferred to Phase 212"), so `memory.store`
 * was invisible to it (that test's own residual note, lines 27-29). This test
 * derives the agent-tool → backing-RPC mapping straight from the tool source,
 * closing the blind spot for the agent memory primitives.
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { API_CONTRACTS_ORDERED } from "@comis/core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const TOOLS_DIR = resolve(REPO_ROOT, "packages/skills/src/platform-tools/tools");

/**
 * The basic agent memory primitives — every agent gets these in the default
 * (non-admin) tool set; they are read+write memory access, NOT the admin
 * `memory_manage` management surface (delete/flush/export, which is correctly
 * admin-scoped and offered only to admin-trust contexts).
 */
const AGENT_MEMORY_TOOL_FILES = [
  "memory-store-tool.ts",
  "memory-ask-tool.ts",
  "memory-get-tool.ts",
  "memory-search-tool.ts",
] as const;

/** The admin deny set, derived the SAME way the rpc-dispatch chokepoint derives it. */
const ADMIN_METHODS: ReadonlySet<string> = new Set(
  API_CONTRACTS_ORDERED.filter((c) => c.scopes.includes("admin")).map((c) => c.method),
);

describe("MD-02 — agent memory tools have agent-reachable backing RPCs (not deny-by-origin)", () => {
  it("every basic agent memory tool's rpcCall() backing method is NOT in the admin deny set", () => {
    const violations: string[] = [];
    for (const file of AGENT_MEMORY_TOOL_FILES) {
      const src = readFileSync(resolve(TOOLS_DIR, file), "utf8");
      const m = src.match(/rpcCall\(\s*"(memory\.[a-z_]+)"/);
      expect(m, `${file}: no rpcCall("memory.*") literal found — tool refactored? update this guard.`).not.toBeNull();
      const method = m![1];
      if (ADMIN_METHODS.has(method)) {
        violations.push(
          `${file} → rpcCall("${method}") but "${method}" is scopes:["admin"] → in the deny-by-origin set → ` +
            `an agent-origin call is denied at assertNotAgentOrigin BEFORE the tool runs ` +
            `("Control-plane method ${method} is not reachable from an agent origin"). Re-scope its contract to ["rpc"].`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("non-vacuity: the admin set is populated and each memory tool has a backing rpcCall", () => {
    expect(ADMIN_METHODS.size, "the admin deny set must be non-trivial").toBeGreaterThan(20);
    for (const file of AGENT_MEMORY_TOOL_FILES) {
      expect(readFileSync(resolve(TOOLS_DIR, file), "utf8")).toContain("rpcCall(");
    }
  });
});
