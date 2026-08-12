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
    // `exit` can precede the final stdout data event. `close` means every stdio
    // stream has drained, so only then can an absent newline be called a failure.
    child.once("close", (code) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timeout);
      rejectResponse(new Error(`fixture closed before responding with code ${String(code)}`));
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

  // The reader above proves the ORDERING half — a complete line is not lost to an
  // `exit` that precedes it. This proves the fixture's own half: it may not leave on
  // EOF while written answers are still in the pipe. The batch has to out-size what
  // the pipe plus this lagging reader can absorb or every write completes before EOF
  // and nothing about the exit is under test: 256 answers are ~365KB against the
  // ~150KB a reader that consumes nothing swallows on Linux.
  it("answers a whole batch that a lagging reader has not drained", async () => {
    const child = spawn(process.execPath, [fixturePath, "first"], {
      env: { PATH: process.env["PATH"], MCP_TEST_TOKEN: "test-key" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(child);
    child.stdout.setEncoding("utf8");

    const answered = new Promise<{ lines: string[]; code: number | null }>((resolveRun, rejectRun) => {
      let stdout = "";
      const timeout = setTimeout(() => rejectRun(new Error("the fixture never finished answering")), 20_000);
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectRun(error);
      });
      // `close`, not `exit`: only a drained stdio stream can tell a complete answer
      // set from a truncated one.
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolveRun({ lines: stdout.split("\n").filter(Boolean), code });
      });
    });
    // Attaching the `data` handler resumes the stream, so the pause that makes this
    // client a lagging reader has to come after it.
    child.stdout.pause();

    const batch = Array.from({ length: 256 }, (_, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/list" }));
    child.stdin.end(`${batch.join("\n")}\n`);
    // Nothing is consumed while the fixture decides whether it may leave. The delayed
    // resume is the backstop for a fixture that stays: without it a client that never
    // reads would wait out the whole budget behind a full pipe.
    setTimeout(() => child.stdout.resume(), 250);

    const { lines, code } = await answered;
    expect(code).toBe(0);
    expect(lines).toHaveLength(batch.length);
    for (const [index, line] of lines.entries()) {
      const message = JSON.parse(line) as ToolListResponse & { id?: number };
      expect(message.id, line).toBe(index + 1);
      expect(message.result?.tools?.map((tool) => tool.name)).toContain("account_summary");
    }
  });
});
