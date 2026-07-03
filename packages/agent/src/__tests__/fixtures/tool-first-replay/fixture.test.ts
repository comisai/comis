// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-first replay fixture invariants.
 *
 * Validates the 5 contract invariants of the fixture surface. Downstream
 * consumers rely on the invariants asserted here. The smoke test is the
 * executable verification surface for the replay round.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Message } from "@earendil-works/pi-ai";

import { createStubMcpServer } from "./stub-mcp-server.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("Replay fixture invariants", () => {
  it("messages.json parses as a non-empty pi-ai Message[] with user as first turn", () => {
    const raw = readFileSync(resolve(here, "messages.json"), "utf8");
    const messages = JSON.parse(raw) as Message[];
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("toolResult");
  });

  it("encodes the tool-first failure mode (assistant runs `pip install market-data-lib` via exec)", () => {
    const raw = readFileSync(resolve(here, "messages.json"), "utf8");
    const messages = JSON.parse(raw) as Message[];
    const installCalls = messages.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content.filter(
            (c): c is { type: "toolCall"; id: string; name: string; arguments: { command: string } } =>
              typeof c === "object" && c !== null && (c as { type: string }).type === "toolCall" && (c as { name: string }).name === "exec",
          )
        : [],
    );
    expect(installCalls.length).toBe(1);
    expect(installCalls[0].arguments.command).toContain("pip install market-data-lib");
    const toolResult = messages[2] as { role: "toolResult"; toolCallId: string };
    expect(toolResult.toolCallId).toBe(installCalls[0].id);
  });

  it("tooling-config.yaml parses and declares `finance-data` with `replacesPackages: [market-data-lib, ...]`", () => {
    const raw = readFileSync(resolve(here, "tooling-config.yaml"), "utf8");
    const config = parseYaml(raw) as {
      tooling: {
        mcp: { capabilityHints: Record<string, { cluster: string; description: string; replacesPackages: string[] }> };
        capabilityClusters: { clusters: Record<string, { label: string; priority: number; preferOverInstalls: boolean }> };
      };
    };
    expect(config.tooling.capabilityClusters.clusters["data-fetching-financial"]).toBeDefined();
    expect(config.tooling.mcp.capabilityHints["finance-data"]).toBeDefined();
    expect(config.tooling.mcp.capabilityHints["finance-data"].replacesPackages).toContain("market-data-lib");
    expect(config.tooling.mcp.capabilityHints["finance-data"].cluster).toBe("data-fetching-financial");
  });

  it("stub MCP server exposes >=10 tools and supports setConnected(bool) toggle", () => {
    const server = createStubMcpServer(true);
    expect(server.name).toBe("finance-data");
    expect(server.tools.length).toBeGreaterThanOrEqual(10);
    expect(server.getStatus()).toBe("connected");
    server.setConnected(false);
    expect(server.getStatus()).toBe("disconnected");
    server.setConnected(true);
    expect(server.getStatus()).toBe("connected");
    for (const tool of server.tools) {
      expect(tool.qualifiedName).toMatch(/^mcp:finance-data\/[a-z_]+$/);
    }
    const defaultServer = createStubMcpServer();
    expect(defaultServer.getStatus()).toBe("connected");
  });

  it("contains no forbidden tokens in fixture content files", () => {
    const files = ["messages.json", "tooling-config.yaml", "stub-mcp-server.ts", "README.md"];
    for (const file of files) {
      const raw = readFileSync(resolve(here, file), "utf8");
      expect(raw, file).not.toMatch(/discover_tools|tool_search_tool_regex|yfinance/i);
    }
  });
});
