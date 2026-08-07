// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sanitizeSessionSecrets,
  looksLikeApiKey,
  projectSessionValueForPersistence,
} from "./sanitize-session-secrets.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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

  it("repairs opaque token disclosures in user messages and provenance records", () => {
    const credential = "AZ9mQ2-v7Kp3_X8nL4tR6sB1";
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "custom",
        customType: "comis.inbound-message-provenance",
        data: {
          messages: [{ text: `heres the token ${credential}` }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `heres the token ${credential}` }],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(2);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(credential);
    expect(persisted.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("repairs replacement-request credentials in messages and provenance records", () => {
    const credential = "synthetic-service-token-7f3a9c2b8d4e6f10";
    const text = `replace the service token with ${credential}`;
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "custom",
        customType: "comis.inbound-message-provenance",
        data: { messages: [{ text }] },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(2);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(credential);
    expect(persisted.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("repairs short credentials placed into a named secret store", () => {
    const credential = "test-key";
    const text = `put this neutral test credential in the supported secret store: ${credential}`;
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "custom",
        customType: "comis.inbound-message-provenance",
        data: { messages: [{ text }] },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(2);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(credential);
    expect(persisted.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("removes private assistant reasoning payloads from existing session files", () => {
    const privateValue = "test-key";
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: `Compare ${privateValue} before continuing.`,
              thinkingSignature: `signed-container-${privateValue}`,
            },
            { type: "text", text: "Continuing safely." },
          ],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(1);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(privateValue);
    expect(persisted).not.toContain('"type":"thinking"');
    expect(persisted).toContain("Continuing safely.");
  });

  it("repairs unlabeled credential-shaped values in user messages and provenance records", () => {
    const credential = "aZ9mQ2v7Kp3X8nL4tR6sB1cD5eF0gH7jK9mN2pQ4wX6yT8u0";
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "custom",
        customType: "comis.inbound-message-provenance",
        data: {
          messages: [{ text: `ok try this one ${credential}` }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `ok try this one ${credential}` }],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(2);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(credential);
    expect(persisted.match(/\[REDACTED\]/g)).toHaveLength(2);
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

  it("preserves provider-valid high-entropy tool identities for durable replay", () => {
    const toolName = "mcp__background-report--read_assistant_report";
    const toolCallId =
      "call_OktL6czNeX1zvUGUSxFWc2AA_fc_0ba45e2560717fc5016a6be59679688191b559987d1f1d7c67";
    const path = writeJsonl(tmpDir, [
      { type: "session", version: 1, id: "s1" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: toolName,
              id: toolCallId,
              arguments: { subject: "synthetic report" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text: "synthetic result" }],
        },
      },
    ]);

    expect(sanitizeSessionSecrets(path)).toBe(0);
    const entries = readJsonlEntries(path) as Array<{
      message?: {
        toolCallId?: string;
        toolName?: string;
        content?: Array<{ id?: string; name?: string }>;
      };
    }>;
    expect(entries[1]?.message?.content?.[0]?.name).toBe(toolName);
    expect(entries[1]?.message?.content?.[0]?.id).toBe(toolCallId);
    expect(entries[2]?.message?.toolName).toBe(toolName);
    expect(entries[2]?.message?.toolCallId).toBe(toolCallId);
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

  describe("sanitize-session-secrets honors file-mode invariant (0o600)", () => {
    it("rewrites the session JSONL with mode 0o600 when secrets are redacted", () => {
      const sessionPath = writeJsonl(tmpDir, [
        { type: "session", version: 1, id: "s1" },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "gateway",
                id: "tc-mode",
                arguments: {
                  action: "env_set",
                  env_key: "MODE_TEST_SECRET",
                  env_value: "a-genuinely-sensitive-value-1234567890",
                },
              },
            ],
          },
        },
      ]);

      const changed = sanitizeSessionSecrets(sessionPath);
      expect(changed).toBe(1);
      // The fs-safe substrate writes regular files at mode 0o600 — the
      // file-mode confidentiality invariant for artifacts under ~/.comis.
      expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
    });
  });
});

describe("looksLikeApiKey", () => {
  it("detects Google API keys", () => {
    expect(looksLikeApiKey("AIzaFAKE_FAKE_FAKE_FAKE_FAKE_FAKE_FAKE_X")).toBe(true);
  });

  it("detects OpenAI keys via the sk- prefix and length heuristic", () => {
    expect(looksLikeApiKey("sk-abcdefghij1234567890abcdefghij")).toBe(true);
  });

  it("detects Groq keys via the gsk_ prefix and length heuristic", () => {
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

// ---------------------------------------------------------------------------
// Bare-`token` name collision
// ---------------------------------------------------------------------------

/**
 * The sensitive-argument matcher is name-based and value-blind, so the bare
 * `token` keyword captures any parameter ending in `_token` — including opaque
 * cursors and plain enums that never carry a credential.
 *
 * Redacting one of those is not merely over-cautious, it is corrupting: the
 * placeholder is persisted into the session, replayed back into the model's
 * context on the next turn, and copied forward as a literal argument. That is
 * the same replay hazard scrub-redacted-tool-calls.ts already documents for
 * `env_value`. Observed live: an MCP tool whose `range_token` parameter is a
 * fixed date-range enum failed schema validation three times in a row as the
 * model paginated, each call re-sending "[REDACTED]".
 *
 * Values that could plausibly be a credential must still be redacted on these
 * names — the exemption is for values that cannot be one.
 */
describe("projectSessionValueForPersistence — bare-token name collision", () => {
  it("keeps a short lowercase enum on a *_token parameter", () => {
    const out = projectSessionValueForPersistence({ range_token: "last_7_days" });
    expect(out.value).toEqual({ range_token: "last_7_days" });
    expect(out.redactions).toBe(0);
  });

  it("keeps an opaque pagination cursor that cannot be a credential", () => {
    const out = projectSessionValueForPersistence({ page_token: "next_page" });
    expect(out.value).toEqual({ page_token: "next_page" });
  });

  it("still redacts a credential-shaped value on a *_token parameter", () => {
    const out = projectSessionValueForPersistence({
      range_token: "sk-AbC123XyZ456DeF789GhI012JkL345MnO",
    });
    expect((out.value as Record<string, string>).range_token).toBe("[REDACTED]");
    expect(out.redactions).toBe(1);
  });

  it("still redacts qualified credential token names regardless of value shape", () => {
    for (const name of ["access_token", "auth_token", "refresh_token", "id_token"]) {
      const out = projectSessionValueForPersistence({ [name]: "last_7_days" });
      expect(
        (out.value as Record<string, string>)[name],
        `${name} must stay redacted`,
      ).toBe("[REDACTED]");
    }
  });

  it("still redacts the unqualified api_key/secret/password family by name", () => {
    for (const name of ["api_key", "secret", "password", "private_key"]) {
      const out = projectSessionValueForPersistence({ [name]: "short_value" });
      expect((out.value as Record<string, string>)[name]).toBe("[REDACTED]");
    }
  });
});

describe("projectSessionValueForPersistence — validation argument dumps", () => {
  it("removes a rejected secret argument from persisted tool-result text", () => {
    const secret = "test-key";
    const text =
      'Validation failed for tool "mcp_manage":\n'
      + "  - action: must be equal to one of the allowed values\n\n"
      + "Received arguments:\n"
      + JSON.stringify({
        action: "env_set",
        env_key: "EXAMPLE_TOKEN",
        env_value: secret,
      });
    const out = projectSessionValueForPersistence({
      role: "toolResult",
      content: [{ type: "text", text }],
    });
    const persisted = JSON.stringify(out.value);

    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("Received arguments:");
    expect(persisted).toContain("Invalid parameters");
    expect(out.redactions).toBeGreaterThan(0);
  });
});

describe("projectSessionValueForPersistence — structural conversation identity", () => {
  // A conversation ref is `cv_` + 43 base64url chars: machine-minted, and
  // high-entropy by construction, so the API-key heuristic reads it as a
  // credential. Redacting it protects nothing and corrupts the record — a
  // persisted `conversationRef` of `[REDACTED]` no longer parses, which made the
  // delivered-assistant idempotency scan skip the stored attempt and append a
  // duplicate on every retry.
  const REF = "cv_pOlYgluGmYXit8tyt8ISFbDrcagaUAexi7C7Kolw0IA";

  it("keeps a conversation ref intact through the persistence projection", () => {
    const out = projectSessionValueForPersistence({
      conversationRef: REF,
      attemptId: "attempt_a",
    });

    expect(out.redactions).toBe(0);
    expect((out.value as { conversationRef: string }).conversationRef).toBe(REF);
  });

  it("keeps the ref intact when nested inside a custom session entry", () => {
    const out = projectSessionValueForPersistence({
      type: "custom",
      customType: "delivered_assistant_history",
      data: { conversationRef: REF, text: "already seen by the user" },
    });

    expect((out.value as { data: { conversationRef: string } }).data.conversationRef).toBe(REF);
  });

  it("still redacts a credential parked under the conversationRef key", () => {
    // The carve-out requires the exact ref shape, so it cannot be used as a
    // laundering channel for a real secret.
    const out = projectSessionValueForPersistence({
      conversationRef: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    expect(out.redactions).toBeGreaterThan(0);
    expect((out.value as { conversationRef: string }).conversationRef).not.toContain("sk-ant");
  });

  it("still redacts a high-entropy value under an unrelated key", () => {
    const out = projectSessionValueForPersistence({ someOtherField: REF });

    expect(out.redactions).toBeGreaterThan(0);
  });
});

describe("projectSessionValueForPersistence — runtime citation receipts", () => {
  const DIGEST = createHash("sha256")
    .update("https://example.com/source", "utf8")
    .digest("hex");

  it("does not trust a digest-shaped assistant property as a runtime receipt", () => {
    const out = projectSessionValueForPersistence({
      role: "assistant",
      content: [{ type: "text", text: "[Source](https://example.com/source)" }],
      citationEvidenceDigests: [DIGEST],
    });

    expect(out.redactions).toBeGreaterThan(0);
    expect(
      (out.value as { citationEvidenceDigests: string[] }).citationEvidenceDigests,
    ).toEqual(["[REDACTED]"]);
  });

  it("redacts an unjournaled assistant digest through durable session repair", () => {
    const tmpDir = makeTmpDir();
    try {
      const path = writeJsonl(tmpDir, [
        { type: "session", version: 1, id: "s1" },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[Source](https://example.com/source)" }],
            citationEvidenceDigests: [DIGEST],
          },
        },
      ]);

      expect(sanitizeSessionSecrets(path)).toBe(1);
      const entries = readJsonlEntries(path) as Array<{
        message?: { citationEvidenceDigests?: string[] };
      }>;
      expect(entries[1]?.message?.citationEvidenceDigests).toEqual(["[REDACTED]"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still redacts a digest-shaped value outside a runtime assistant receipt", () => {
    const out = projectSessionValueForPersistence({
      role: "user",
      citationEvidenceDigests: [DIGEST],
    });

    expect(out.redactions).toBeGreaterThan(0);
    expect(
      (out.value as { citationEvidenceDigests: string[] }).citationEvidenceDigests,
    ).toEqual(["[REDACTED]"]);
  });

  it("keeps a validated append-only runtime citation receipt", () => {
    const out = projectSessionValueForPersistence({
      type: "custom",
      customType: "citation_evidence",
      data: {
        sourceMessageId: "message_a",
        urlDigests: [DIGEST],
      },
    });

    expect(out.redactions).toBe(0);
    expect(
      (out.value as { data: { urlDigests: string[] } }).data.urlDigests,
    ).toEqual([DIGEST]);
  });
});
