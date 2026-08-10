// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "credentialed-mcp-server.mjs",
);

const children = new Set<ReturnType<typeof spawn>>();

interface ToolListResponse {
  result?: { tools?: Array<{ name?: string }> };
  error?: { message?: string };
}

async function listTools(
  credential: string,
  options: { pauseOutputUntilExit?: boolean } = {},
): Promise<ToolListResponse> {
  const child = spawn(process.execPath, [fixturePath, "first"], {
    env: {
      PATH: process.env["PATH"],
      MCP_TEST_TOKEN: credential,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  if (options.pauseOutputUntilExit) {
    child.stdout.pause();
    child.once("exit", () => child.stdout.resume());
  }

  const response = await new Promise<ToolListResponse>((resolveResponse, rejectResponse) => {
    let stdout = "";
    const timeout = setTimeout(() => rejectResponse(new Error("fixture response timed out")), 3_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveResponse(JSON.parse(stdout.slice(0, newline)) as ToolListResponse);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectResponse(error);
    });
    child.once("exit", (code) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timeout);
      rejectResponse(new Error(`fixture exited before responding with code ${String(code)}`));
    });

    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  });

  child.kill("SIGTERM");
  children.delete(child);
  return response;
}

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
});

describe("credentialed MCP live fixture", () => {
  it("accepts both frozen neutral credential rotation values", async () => {
    const first = await listTools("test-key");
    const rotated = await listTools("test-key-two");

    expect(first.error).toBeUndefined();
    expect(first.result?.tools?.map((tool) => tool.name)).toContain("account_summary");
    expect(rotated.error).toBeUndefined();
    expect(rotated.result?.tools?.map((tool) => tool.name)).toContain("account_summary");
  });

  it("rejects an arbitrary credential before advertising tools", async () => {
    const response = await listTools("not-a-campaign-test-key");

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("credential_invalid");
  });

  it("drains a complete response after the child exit event", async () => {
    const response = await listTools("not-a-campaign-test-key", {
      pauseOutputUntilExit: true,
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("credential_invalid");
  });
});
