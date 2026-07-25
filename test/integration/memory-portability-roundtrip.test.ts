// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test: memory portability export → import round-trip.
 *
 * Tests the full CLI→daemon→adapter path:
 * 1. Seed a clean entry via memory.store, in-process within a resolved request context
 * 2. Export that agent's memory via memory.portability.export RPC (gateway)
 * 3. Import to a specific target agentId via memory.portability.import RPC (gateway)
 * 4. Verify the imported entry preserves trust_level, memory_type, tags, provenance
 *
 * Note: under the explicit-authority contracts, memory.store binds each write to the
 * ambient resolved turnScope (as the production agent tool path does) plus explicit
 * tenant/agent and an explicit visibility — the admin gateway leg establishes no such
 * scope, so the seed store runs in-process. The export re-emits the visibility as a
 * string the import reconstructs. Portability export/import both require explicit
 * agent_id + tenant_id (export is per-agent — there is no "all agents" mode).
 *
 * Requires: pnpm build (imports @comis/* from dist/)
 * Pool: forks (maxConcurrency: 1)
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// @comis/* imports resolve to dist/ via Vitest alias (pnpm build required first)
import {
  callTyped,
  withClient,
} from "@comis/cli";
import {
  MemoryPortabilityExportContract,
  MemoryPortabilityImportContract,
  parseMemoryExportEnvelope,
  runWithContext,
} from "@comis/core";
import { resolveInternalTurnIdentity } from "@comis/orchestrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-memory-portability.yaml");

// memory.store binds each write to the resolved request authority: the handler reads
// the ambient turnScope (tryGetContext) and requires it to match the explicit
// tenant/agent, exactly as the production agent tool path does (that tool runs inside
// the agent turn's resolved scope). The admin gateway leg establishes no such scope, so
// the seed store is driven in-process through a resolved request context. Export/import
// are operator RPC and derive their own authority from explicit params, so they stay on
// the gateway leg. Mirrors packages/daemon/src/api/memory-handlers.test.ts.
function withResolvedRequestContext<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const identity = resolveInternalTurnIdentity({
    tenantId: "test",
    agentId,
    originKind: "control-plane",
    instanceId: "memory-portability-roundtrip",
    conversationId: "memory-portability-roundtrip-store",
    principalId: "test-operator",
  });
  if (!identity.ok) throw identity.error;
  return runWithContext(
    {
      tenantId: "test",
      userId: "test-operator",
      sessionKey: identity.value.displaySessionKey,
      agentId,
      turnScope: identity.value.turnScope,
      traceId: "00000000-0000-4000-8000-000000000001",
      startedAt: 1,
      trustLevel: "admin",
    },
    fn,
  );
}

describe("memory portability round-trip (export → import, CLI→daemon→adapter)", () => {
  let handle: TestDaemonHandle;
  let rpcCall: TestDaemonHandle["daemon"]["rpcCall"];

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    rpcCall = handle.daemon.rpcCall;
    process.env["COMIS_GATEWAY_URL"] = `ws://127.0.0.1:${handle.daemon.container.config.gateway.port}/ws`;
    process.env["COMIS_GATEWAY_TOKEN"] = handle.authToken;
    process.env["COMIS_CLI_E2E"] = "true";
  }, 60_000);

  afterAll(async () => {
    delete process.env["COMIS_GATEWAY_URL"];
    delete process.env["COMIS_GATEWAY_TOKEN"];
    delete process.env["COMIS_CLI_E2E"];
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) throw err;
      }
    }
  }, 30_000);

  it("exports a stored entry and import preserves trust_level, memory_type, tags, and provenance", async () => {
    const TENANT_ID = "test";
    const SOURCE_AGENT = "default";
    const TARGET_AGENT = "portability-target-agent";
    const TEST_CONTENT = "The capital of France is Paris — a test memory for portability round-trip";
    const TEST_TAGS = ["geography", "europe", "portability-test"];

    // Step 1: Seed a test entry under the source agent scope, in-process within a
    // resolved request context (the store binds to the ambient turnScope). Explicit
    // visibility is required and the export re-emits it for the import path.
    await withResolvedRequestContext(SOURCE_AGENT, () =>
      rpcCall("memory.store", {
        content: TEST_CONTENT,
        tags: TEST_TAGS,
        visibility: "agent-shared",
        tenantId: TENANT_ID,
        agentId: SOURCE_AGENT,
      }),
    );

    // Step 2: Export the source agent's memory (export is per-agent — the contract
    // requires explicit agent_id + tenant_id).
    const exportResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: SOURCE_AGENT,
        tenant_id: TENANT_ID,
      }),
    );

    expect(exportResult.schemaVersion).toBe("comis-memory-export-v1");
    expect(exportResult.entryCount).toBeGreaterThanOrEqual(1);
    const exportedEntry = exportResult.entries.find((e) =>
      typeof e["content"] === "string" && (e["content"] as string).includes("Paris"),
    );
    expect(exportedEntry).toBeDefined();
    expect(exportedEntry!["content"]).not.toContain("sk-ant"); // no secret leak

    // Step 3: Import to the target agent scope
    const importResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityImportContract, {
        entries: exportResult.entries as Record<string, unknown>[],
        agent_id: TARGET_AGENT,
        tenant_id: TENANT_ID,
        dry_run: false,
      }),
    );

    expect(importResult.imported).toBeGreaterThanOrEqual(1);
    expect(importResult.blocked).toBe(0);
    expect(importResult.dryRun).toBe(false);

    // Step 4: Export target agent memory and verify field preservation
    const verifyResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: TARGET_AGENT,
        tenant_id: TENANT_ID,
      }),
    );

    const imported = verifyResult.entries.find((e) =>
      typeof e["content"] === "string" && (e["content"] as string).includes("Paris"),
    );
    expect(imported).toBeDefined();
    // trust_level, memory_type, tags, and source provenance must survive the round-trip
    expect(imported!["trust_level"]).toBe("learned");
    expect(imported!["memory_type"]).toBe("semantic");
    expect(imported!["tags"]).toEqual(expect.arrayContaining(TEST_TAGS));
    expect(imported!["source_who"]).toBeDefined();
    // agentId is re-stamped to TARGET_AGENT (verified indirectly: entry appears in TARGET_AGENT scope)
  });

  it("dry-run import reports counts without persisting any entries", async () => {
    const TENANT_ID = "test";
    const SOURCE_AGENT = "default";
    const DRY_AGENT = "portability-dry-run-agent";

    // Export the source agent's entries (includes the previously stored test entry).
    const exportResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: SOURCE_AGENT,
        tenant_id: TENANT_ID,
      }),
    );
    expect(exportResult.entryCount).toBeGreaterThanOrEqual(1);

    const dryResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityImportContract, {
        entries: exportResult.entries as Record<string, unknown>[],
        agent_id: DRY_AGENT,
        tenant_id: TENANT_ID,
        dry_run: true,
      }),
    );

    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.total).toBe(exportResult.entryCount);

    // Verify nothing was persisted in the dry-run target scope
    const check = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: DRY_AGENT,
        tenant_id: TENANT_ID,
      }),
    );
    expect(check.entryCount).toBe(0);
  });

  it("import fails closed when envelope schemaVersion is not comis-memory-export-v1", async () => {
    // The CLI validates the envelope before sending to daemon.
    // This test verifies parseMemoryExportEnvelope rejects mismatched schemaVersion.
    const result = parseMemoryExportEnvelope({
      schemaVersion: "comis-memory-export-v2",
      exportedAt: 0,
      scope: { tenantId: "t", agentId: null },
      entryCount: 0,
      entries: [],
    });
    expect(result.ok).toBe(false);
  });
});
