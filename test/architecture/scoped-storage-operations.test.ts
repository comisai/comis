// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

describe("scoped conversation storage authority", () => {
  it("all session point and listing operations require typed tenant agent conversation scope", () => {
    const port = source("packages/core/src/ports/session-store.ts");

    expect(port).toContain("load(scope: ConversationScope)");
    expect(port).toContain("loadByRef(scope: SessionQueryScope, conversationRef: ConversationRef)");
    expect(port).toContain("list(scope: SessionQueryScope)");
    expect(port).toContain("delete(scope: ConversationScope)");
    expect(port).toContain("deleteByRef(scope: SessionQueryScope, conversationRef: ConversationRef)");
    expect(port).not.toContain("loadByFormattedKey");
  });

  it("cross session messages require authority triples for target and caller conversations", () => {
    const sender = source("packages/orchestrator/src/cross-session/cross-session-sender.ts");

    expect(sender).toContain("target: SessionQueryScope & { conversationRef: ConversationRef }");
    expect(sender).toContain("caller?: SessionQueryScope & { conversationRef: ConversationRef }");
    expect(sender).not.toContain("targetSessionKey:");
  });

  it("session control plane contracts require explicit tenant agent and conversation references", () => {
    const contracts = source("packages/core/src/api-contracts/sessions.ts");
    for (const method of ["session.history", "session.send", "session.reset", "session.export", "session.compact", "session.delete"]) {
      const start = contracts.indexOf(`method: \"${method}\"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const requestBlock = contracts.slice(start, start + 500);
      expect(requestBlock).toContain("tenant_id: z.string()" );
      expect(requestBlock).toContain("agent_id: z.string()" );
      expect(requestBlock).toContain("conversation_ref: z.string()" );
    }
  });

  it("memory mutation ports require explicit tenant and agent authority", () => {
    const memoryPort = source("packages/core/src/ports/memory.ts");
    const pinnedPort = source("packages/core/src/ports/memory-pinned-store.ts");

    expect(memoryPort).toMatch(/delete\(\s*id: string,\s*scope: \{ tenantId: string; agentId: string \},\s*\)/);
    expect(pinnedPort).toContain("pin(id: string, tenantId: string, agentId: string)");
    expect(pinnedPort).toContain("unpin(id: string, tenantId: string, agentId: string)");
    expect(pinnedPort).not.toMatch(/tenantId\?:|agentId\?:/);
  });

  it("memory handlers do not select storage authority from the configured default agent", () => {
    const handlers = source("packages/daemon/src/api/memory-handlers.ts");
    const pinning = source("packages/daemon/src/api/memory-pinning-handlers.ts");

    expect(handlers).not.toMatch(/memory(?:Api|Adapter)\.(?:search|store|delete|pin|unpin)[\s\S]{0,180}defaultAgentId/);
    expect(pinning).not.toContain("defaultAgentId");
  });

  it("learning write backs use configured or resolved tenant authority instead of display keys", () => {
    const usefulness = source("packages/daemon/src/wiring/setup-memory-usefulness-wiring.ts");
    const learning = source("packages/daemon/src/wiring/setup-learning.ts");

    expect(usefulness).toContain("tenantId: deps.tenantId");
    expect(learning).toContain("ctx?.tenantId ?? configuredTenantId");
    expect(usefulness).not.toContain("deriveTenantFromSessionKey");
    expect(learning).not.toContain("deriveTenantFromSessionKey");
  });

  it("gateway and graph storage identities never synthesize tenant or agent defaults", () => {
    const sources = [
      source("packages/gateway/src/openai/openai-completions.ts"),
      source("packages/gateway/src/responses/responses-endpoint.ts"),
      source("packages/daemon/src/api/graph-handlers/graph-mutate.ts"),
      source("packages/daemon/src/api/graph-handlers/graph-query.ts"),
      source("packages/daemon/src/api/graph-handlers/graph-export.ts"),
    ];

    for (const runtimeSource of sources) {
      expect(runtimeSource).not.toMatch(/(?:tenantId|agentId)[^\n]{0,80}\?\? "default"/);
    }
  });

  it("production context assembly has no implementation selector branch", () => {
    const packagesRoot = fileURLToPath(new URL("packages/", root));
    const productionFiles = readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = resolve(packagesRoot, entry.name, "src");
        return existsSync(src) ? productionTypeScriptFiles(src) : [];
      });

    const selector = /contextEngine(?:\?|)\.version|contextEngineVersion|z\.enum\(\["pipeline", "dag"\]\)/;
    const offenders = productionFiles.filter((file) => selector.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
