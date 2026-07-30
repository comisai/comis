// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER = resolve("test/live/self-driving/scripts/credentialed-mcp-server.mjs");

type ToolResult = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
};

async function callAccountSummary(credential: string | undefined): Promise<Record<string, unknown>> {
  const env = { ...process.env };
  if (credential === undefined) {
    delete env["MCP_TEST_TOKEN"];
  } else {
    env["MCP_TEST_TOKEN"] = credential;
  }

  const child = spawn(process.execPath, [SERVER, "first"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = new Promise<string>((resolveOutput, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolveOutput(stdout.slice(0, newline));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (stdout.length === 0) reject(new Error(`fixture exited before responding (${code})`));
    });
  });

  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "account_summary",
      arguments: { detail_level: 1 },
    },
  })}\n`);

  const response = JSON.parse(await output) as ToolResult;
  const text = response.result?.content?.[0]?.text;
  expect(response.result?.isError).toBe(true);
  expect(typeof text).toBe("string");
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

describe("credentialed MCP live fixture diagnostics", () => {
  it("distinguishes a missing credential from a present value rejected by the fixture contract", async () => {
    await expect(callAccountSummary(undefined)).resolves.toMatchObject({
      code: "credential_unresolved",
      requiredEnv: "MCP_TEST_TOKEN",
    });
    await expect(callAccountSummary("opaque-but-invalid-fixture-value")).resolves.toMatchObject({
      code: "credential_invalid",
      requiredEnv: "MCP_TEST_TOKEN",
    });
  });
});
