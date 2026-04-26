// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sanitizeSessionSecrets, looksLikeApiKey } from "./sanitize-session-secrets.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sanitize-session-"));
}

function writeJsonl(dir: string, lines: unknown[]): string {
  const p = join(dir, "session.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return p;
}

function readJsonlEntries(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("sanitizeSessionSecrets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 for non-existent file", () => {
    expect(sanitizeSessionSecrets("/tmp/no-such-file-abc123.jsonl")).toBe(0);
  });

  it("returns 0 when no sensitive data present", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", id: "tc1", arguments: { path: "/etc/hosts" } },
          ],
        },
      },
    ]);
    expect(sanitizeSessionSecrets(path)).toBe(0);
  });

  it("redacts env_value in gateway env_set toolCall", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "gateway",
              id: "tc1",
              arguments: {
                action: "env_set",
                env_key: "MY_SECRET",
                env_value: "super-secret-value-123",
              },
            },
          ],
        },
      },
    ]);

    const changed = sanitizeSessionSecrets(path);
    expect(changed).toBe(1);

    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.env_value).toBe("[REDACTED]");
    expect(msg.message.content[0].arguments.env_key).toBe("MY_SECRET");
    expect(msg.message.content[0].arguments.action).toBe("env_set");
  });

  it("handles tool_use type (Anthropic format) in addition to toolCall", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "gateway",
              id: "tc1",
              input: {
                action: "env_set",
                env_key: "API_TOKEN",
                env_value: "tok_abc123",
              },
            },
          ],
        },
      },
    ]);

    // tool_use with input (Anthropic format) — should also be handled
    const changed = sanitizeSessionSecrets(path);
    // The rule checks `arguments ?? input`, so if input is used, it reads that
    expect(changed).toBe(1);

    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    const args = msg.message.content[0].input;
    expect(args.env_value).toBe("[REDACTED]");
  });

  it("does not modify non-env_set gateway actions", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "gateway",
              id: "tc1",
              arguments: { action: "read", section: "agents" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(0);
  });

  it("handles multiple tool calls in one message, redacting only env_set", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "read",
              id: "tc1",
              arguments: { path: "/tmp/test" },
            },
            {
              type: "toolCall",
              name: "gateway",
              id: "tc2",
              arguments: {
                action: "env_set",
                env_key: "DB_PASS",
                env_value: "hunter2",
              },
            },
            {
              type: "toolCall",
              name: "exec",
              id: "tc3",
              arguments: { command: "ls -la" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1);

    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.path).toBe("/tmp/test");
    expect(msg.message.content[1].arguments.env_value).toBe("[REDACTED]");
    expect(msg.message.content[2].arguments.command).toBe("ls -la");
  });

  it("handles multiple messages with env_set across different lines", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "gateway",
              id: "tc1",
              arguments: { action: "env_set", env_key: "KEY1", env_value: "val1" },
            },
          ],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "gateway",
              id: "tc2",
              arguments: { action: "env_set", env_key: "KEY2", env_value: "val2" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(2);

    const entries = readJsonlEntries(path);
    expect((entries[1] as any).message.content[0].arguments.env_value).toBe("[REDACTED]");
    expect((entries[3] as any).message.content[0].arguments.env_value).toBe("[REDACTED]");
  });

  it("is idempotent -- running twice produces same result", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "gateway",
              id: "tc1",
              arguments: { action: "env_set", env_key: "K", env_value: "secret" },
            },
          ],
        },
      },
    ]);

    sanitizeSessionSecrets(path);
    const contentAfterFirst = readFileSync(path, "utf-8");

    const changed2 = sanitizeSessionSecrets(path);
    const contentAfterSecond = readFileSync(path, "utf-8");

    expect(changed2).toBe(0); // Already redacted
    expect(contentAfterSecond).toBe(contentAfterFirst);
  });

  it("preserves non-message entries (session, model_change, etc.)", () => {
    const sessionHeader = { type: "session", version: 1, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
    const modelChange = { type: "model_change", model: "claude-opus-4-6" };
    const path = writeJsonl(tmpDir, [
      sessionHeader,
      modelChange,
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "gateway",
              id: "tc1",
              arguments: { action: "env_set", env_key: "K", env_value: "secret" },
            },
          ],
        },
      },
    ]);

    sanitizeSessionSecrets(path);
    const entries = readJsonlEntries(path);

    expect(entries[0]).toEqual(sessionHeader);
    expect(entries[1]).toEqual(modelChange);
  });

  it("preserves user messages unchanged", () => {
    const userMsg = {
      type: "message",
      message: {
        role: "user",
        content: "set my API key to secret123",
      },
    };
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      userMsg,
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(0);
    const entries = readJsonlEntries(path);
    expect(entries[1]).toEqual(userMsg);
  });

  it("handles empty file gracefully", () => {
    const path = join(tmpDir, "empty.jsonl");
    writeFileSync(path, "", "utf-8");
    expect(sanitizeSessionSecrets(path)).toBe(0);
  });

  it("handles malformed JSON lines gracefully", () => {
    const path = join(tmpDir, "bad.jsonl");
    writeFileSync(
      path,
      `{"type":"session","version":1}\n{bad json}\n{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"gateway","id":"tc1","arguments":{"action":"env_set","env_key":"K","env_value":"val"}}]}}\n`,
      "utf-8",
    );

    expect(sanitizeSessionSecrets(path)).toBe(1);

    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
    expect(lines[1]).toBe("{bad json}"); // Preserved as-is
    const entry = JSON.parse(lines[2]);
    expect(entry.message.content[0].arguments.env_value).toBe("[REDACTED]");
  });

  // ---- New: API key pattern detection tests ----

  it("redacts Google API key in MCP tool call arguments", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "mcp__nano-banana--configure_gemini_token",
              id: "tc1",
              arguments: { apiKey: "AIzaFAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_X" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1);
    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.apiKey).toBe("[REDACTED]");
  });

  it("redacts OpenAI-style key in arbitrary tool args", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "some_tool",
              id: "tc1",
              arguments: { config: "normal", key: "sk-proj-abc123def456ghi789jkl012mno345" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1);
    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.key).toBe("[REDACTED]");
    expect(msg.message.content[0].arguments.config).toBe("normal");
  });

  it("redacts API key embedded in exec command string", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "exec",
              id: "tc1",
              arguments: {
                command: 'curl -s "https://api.example.com?key=AIzaFAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_X"',
              },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1);
    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.command).toContain("[REDACTED]");
    expect(msg.message.content[0].arguments.command).not.toContain("AIza");
  });

  it("redacts sensitive-named args (token, secret, password) in any tool", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "configure_service",
              id: "tc1",
              arguments: { name: "myservice", token: "some-bearer-value", port: 8080 },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1);
    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.token).toBe("[REDACTED]");
    expect(msg.message.content[0].arguments.name).toBe("myservice");
    expect(msg.message.content[0].arguments.port).toBe(8080);
  });

  it("does not redact normal string values that are not keys", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "exec",
              id: "tc1",
              arguments: { command: "echo hello world && ls -la" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(0);
  });

  it("redacts multiple different key types in same message", () => {
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "mcp__tool1",
              id: "tc1",
              arguments: { apiKey: "AIzaFAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_X" },
            },
            {
              type: "toolCall",
              name: "exec",
              id: "tc2",
              arguments: { command: "OPENAI_API_KEY=sk-abcdefghij1234567890abcdefghij ./run.sh" },
            },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1); // 1 line changed (both tool calls in same message)
    const entries = readJsonlEntries(path);
    const msg = entries[1] as any;
    expect(msg.message.content[0].arguments.apiKey).toBe("[REDACTED]");
    expect(msg.message.content[1].arguments.command).not.toContain("sk-");
  });
});

describe("looksLikeApiKey", () => {
  it("detects Google API keys", () => {
    expect(looksLikeApiKey("AIzaFAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_X")).toBe(true);
  });

  it("detects OpenAI keys", () => {
    expect(looksLikeApiKey("sk-abcdefghij1234567890abcdefghij")).toBe(true);
  });

  it("detects Groq keys", () => {
    expect(looksLikeApiKey("gsk_abcdefghij1234567890abcde")).toBe(true);
  });

  it("rejects normal strings", () => {
    expect(looksLikeApiKey("hello world")).toBe(false);
    expect(looksLikeApiKey("/tmp/test.txt")).toBe(false);
    expect(looksLikeApiKey("short")).toBe(false);
  });

  it("rejects already-redacted values", () => {
    expect(looksLikeApiKey("[REDACTED]")).toBe(false);
  });
});
