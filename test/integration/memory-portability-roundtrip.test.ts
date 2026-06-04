// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test: memory portability export → import round-trip.
 *
 * Tests the full CLI→daemon→adapter path:
 * 1. Store a clean entry via memory.store RPC
 * 2. Export via memory.portability.export RPC (secret-scrubbed envelope)
 * 3. Import to a different agentId via memory.portability.import RPC
 * 4. Verify the imported entry preserves trust_level, memory_type, tags, provenance
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
  MemoryStoreContract,
  parseMemoryExportEnvelope,
} from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-memory-portability.yaml");

describe("memory portability round-trip (export → import, CLI→daemon→adapter)", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
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
    const SOURCE_AGENT = "portability-source-agent";
    const TARGET_AGENT = "portability-target-agent";
    const TEST_CONTENT = "The capital of France is Paris — a test memory for portability round-trip";
    const TEST_TAGS = ["geography", "europe", "portability-test"];
    const TEST_OCCURRED_AT = 1748000000000;

    // Step 1: Store a test entry in the source agent scope
    await withClient(async (client) =>
      callTyped(client, MemoryStoreContract, {
        content: TEST_CONTENT,
        agent_id: SOURCE_AGENT,
        trust_level: "learned",
        memory_type: "semantic",
        tags: TEST_TAGS,
        occurred_at: TEST_OCCURRED_AT,
      }),
    );

    // Step 2: Export source agent memory
    const exportResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: SOURCE_AGENT,
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
        dry_run: false,
      }),
    );

    expect(importResult.imported).toBeGreaterThanOrEqual(1);
    expect(importResult.blocked).toBe(0);
    expect(importResult.dryRun).toBe(false);

    // Step 4: Browse target agent memory and verify field preservation
    const verifyResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: TARGET_AGENT,
      }),
    );

    const imported = verifyResult.entries.find((e) =>
      typeof e["content"] === "string" && (e["content"] as string).includes("Paris"),
    );
    expect(imported).toBeDefined();
    expect(imported!["trust_level"]).toBe("learned");
    expect(imported!["memory_type"]).toBe("semantic");
    expect(imported!["tags"]).toEqual(expect.arrayContaining(TEST_TAGS));
    expect(imported!["source_who"]).toBeDefined();
    // agentId must be TARGET_AGENT (re-stamped, not SOURCE_AGENT)
    // (Verified indirectly: the entry appears in TARGET_AGENT's export scope)
  });

  it("dry-run import reports counts without persisting any entries", async () => {
    const DRY_AGENT = "portability-dry-run-agent";

    const exportResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: "portability-source-agent",
      }),
    );
    expect(exportResult.entryCount).toBeGreaterThanOrEqual(1);

    const dryResult = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityImportContract, {
        entries: exportResult.entries as Record<string, unknown>[],
        agent_id: DRY_AGENT,
        dry_run: true,
      }),
    );

    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.total).toBe(exportResult.entryCount);

    // Verify nothing was persisted in the dry-run target scope
    const check = await withClient(async (client) =>
      callTyped(client, MemoryPortabilityExportContract, {
        agent_id: DRY_AGENT,
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
