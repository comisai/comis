// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createSessionHandlers } from "./session-handlers.js";
import type { SessionHandlerDeps } from "./session-handlers.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helper: create isolated deps per test to avoid shared state
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<SessionHandlerDeps>): SessionHandlerDeps {
  const mockSessionData = {
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    metadata: { parentSessionKey: undefined } as Record<string, unknown>,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
  };
  return {
    defaultAgentId: "default",
    agents: { default: { name: "Test", model: "test-model" } as SessionHandlerDeps["agents"][string] },
    costTrackers: new Map(),
    stepCounters: new Map(),
    sessionStore: {
      listDetailed: () => [],
      loadByFormattedKey: (key: string) =>
        key === "valid-session" ? mockSessionData : undefined,
      deleteByFormattedKey: (key: string) => key === "valid-session",
      saveByFormattedKey: vi.fn(),
    },
    crossSessionSender: { send: vi.fn() } as never,
    subAgentRunner: { spawn: vi.fn(), getRunStatus: vi.fn() } as never,
    securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 5000 } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests for the 4 new session management handlers
// ---------------------------------------------------------------------------

describe("createSessionHandlers - session management", () => {
  // -------------------------------------------------------------------------
  // session.delete
  // -------------------------------------------------------------------------

  describe("session.delete", () => {
    it("deletes existing session and returns transcript with messageCount", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.delete"]!({
        session_key: "valid-session",
        _trustLevel: "admin",
      })) as { sessionKey: string; deleted: boolean; transcript: { messageCount: number } };

      expect(result.sessionKey).toBe("valid-session");
      expect(result.deleted).toBe(true);
      expect(result.transcript.messageCount).toBe(2);
      expect(result.transcript).toHaveProperty("messages");
      expect(result.transcript).toHaveProperty("metadata");
    });

    it("throws 'Session not found' for non-existent session key", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.delete"]!({ session_key: "non-existent", _trustLevel: "admin" }),
      ).rejects.toThrow("Session not found: non-existent");
    });

    it("throws when session_key is missing", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.delete"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing required parameter: session_key");
    });

    it("rejects without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.delete"]!({ session_key: "valid-session" }),
      ).rejects.toThrow("Admin trust level required");
    });

    it("rejects with viewer trust level", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.delete"]!({ session_key: "valid-session", _trustLevel: "viewer" }),
      ).rejects.toThrow("Admin trust level required");
    });

    it("succeeds with admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = await handlers["session.delete"]!({
        session_key: "valid-session",
        _trustLevel: "admin",
      });
      expect(result).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // session.reset
  // -------------------------------------------------------------------------

  describe("session.reset", () => {
    it("resets existing session and returns previousMessageCount", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.reset"]!({
        session_key: "valid-session",
      })) as { sessionKey: string; reset: boolean; previousMessageCount: number };

      expect(result.sessionKey).toBe("valid-session");
      expect(result.reset).toBe(true);
      expect(result.previousMessageCount).toBe(2);
    });

    it("calls saveByFormattedKey with empty messages array and preserves metadata", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await handlers["session.reset"]!({ session_key: "valid-session" });

      expect(deps.sessionStore.saveByFormattedKey).toHaveBeenCalledWith(
        "valid-session",
        [],
        expect.objectContaining({ parentSessionKey: undefined }),
      );
    });

    it("throws 'Session not found' for non-existent session key", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.reset"]!({ session_key: "non-existent" }),
      ).rejects.toThrow("Session not found: non-existent");
    });

    it("throws when session_key is missing", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.reset"]!({}),
      ).rejects.toThrow("Missing required parameter: session_key");
    });
  });

  // -------------------------------------------------------------------------
  // session.export
  // -------------------------------------------------------------------------

  describe("session.export", () => {
    it("exports existing session with all fields", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.export"]!({
        session_key: "valid-session",
        _trustLevel: "admin",
      })) as {
        sessionKey: string;
        messages: unknown[];
        metadata: Record<string, unknown>;
        messageCount: number;
        createdAt: number;
        updatedAt: number;
      };

      expect(result.sessionKey).toBe("valid-session");
      expect(result.messages).toHaveLength(2);
      expect(result.metadata).toBeDefined();
      expect(result.messageCount).toBe(2);
      expect(result.createdAt).toEqual(expect.any(Number));
      expect(result.updatedAt).toEqual(expect.any(Number));
    });

    it("throws 'Session not found' for non-existent session key", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.export"]!({ session_key: "non-existent", _trustLevel: "admin" }),
      ).rejects.toThrow("Session not found: non-existent");
    });

    it("throws when session_key is missing", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.export"]!({ _trustLevel: "admin" }),
      ).rejects.toThrow("Missing required parameter: session_key");
    });

    it("rejects without admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.export"]!({ session_key: "valid-session" }),
      ).rejects.toThrow("Admin trust level required");
    });

    it("succeeds with admin trust level", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = await handlers["session.export"]!({
        session_key: "valid-session",
        _trustLevel: "admin",
      });
      expect(result).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // session.compact
  // -------------------------------------------------------------------------

  describe("session.compact", () => {
    it("returns compaction status for existing session", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.compact"]!({
        session_key: "valid-session",
      })) as {
        sessionKey: string;
        messageCount: number;
        estimatedTokens: number;
        compactionTriggered: boolean;
        instructions: string | null;
      };

      expect(result.sessionKey).toBe("valid-session");
      expect(result.compactionTriggered).toBe(true);
      expect(result.instructions).toBeNull();
    });

    it("includes estimatedTokens and messageCount", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.compact"]!({
        session_key: "valid-session",
      })) as { estimatedTokens: number; messageCount: number };

      expect(result.messageCount).toBe(2);
      expect(result.estimatedTokens).toEqual(expect.any(Number));
      expect(result.estimatedTokens).toBeGreaterThan(0);
    });

    it("passes through optional instructions parameter", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.compact"]!({
        session_key: "valid-session",
        instructions: "Summarize key topics only",
      })) as { instructions: string | null };

      expect(result.instructions).toBe("Summarize key topics only");
    });

    it("throws 'Session not found' for non-existent session key", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.compact"]!({ session_key: "non-existent" }),
      ).rejects.toThrow("Session not found: non-existent");
    });

    it("throws when session_key is missing", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.compact"]!({}),
      ).rejects.toThrow("Missing required parameter: session_key");
    });
  });

  // -------------------------------------------------------------------------
  // session.search
  // -------------------------------------------------------------------------

  describe("session.search", () => {
    it("returns matching sessions with correct shape", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "session-alpha",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 2,
            },
            {
              sessionKey: "session-beta",
              userId: "u2",
              channelId: "c2",
              metadata: {},
              createdAt: 1000,
              updatedAt: 3000,
              messageCount: 1,
            },
          ],
          loadByFormattedKey: (key: string) => {
            if (key === "session-alpha") {
              return {
                messages: [
                  { role: "user", content: "Tell me about TypeScript generics" },
                  { role: "assistant", content: "TypeScript generics allow you to create reusable components." },
                ],
                metadata: {},
                createdAt: 1000,
                updatedAt: 2000,
              };
            }
            if (key === "session-beta") {
              return {
                messages: [
                  { role: "user", content: "What is JavaScript?" },
                ],
                metadata: {},
                createdAt: 1000,
                updatedAt: 3000,
              };
            }
            return undefined;
          },
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "TypeScript",
      })) as { mode: string; results: Array<{ sessionKey: string; agentId: string; channelType: string; snippet: string; score: number; timestamp: number }>; total: number };

      expect(response.mode).toBe("search");
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.sessionKey).toBe("session-alpha");
      expect(response.results[0]!.agentId).toBe("default");
      expect(response.results[0]!.channelType).toBe("dm");
      expect(response.results[0]!.snippet).toContain("TypeScript");
      expect(response.results[0]!.score).toBe(1.0);
      expect(typeof response.results[0]!.timestamp).toBe("number");
    });

    it("filters by scope=user (only user messages)", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "scoped-session",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 2,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [
              { role: "user", content: "Find the keyword alpha" },
              { role: "assistant", content: "The keyword alpha appears in your request." },
            ],
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      // scope=user: should find match in user message
      const userResponse = (await handlers["session.search"]!({
        query: "keyword alpha",
        scope: "user",
      })) as { results: Array<{ sessionKey: string; snippet: string }> };
      expect(userResponse.results).toHaveLength(1);
      expect(userResponse.results[0]!.snippet).toContain("keyword alpha");

      // scope=assistant: should also find match in assistant message
      const assistantResponse = (await handlers["session.search"]!({
        query: "keyword alpha",
        scope: "assistant",
      })) as { results: Array<{ sessionKey: string; snippet: string }> };
      expect(assistantResponse.results).toHaveLength(1);
      expect(assistantResponse.results[0]!.snippet).toContain("keyword alpha");
    });

    it("scope=user does not match assistant-only content", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "scope-test",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 2,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [
              { role: "user", content: "Hello world" },
              { role: "assistant", content: "The unique-secret-phrase is here." },
            ],
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "unique-secret-phrase",
        scope: "user",
      })) as { results: Array<{ sessionKey: string }> };
      expect(response.results).toHaveLength(0);
    });

    it("respects limit parameter", async () => {
      const sessions = Array.from({ length: 5 }, (_, i) => ({
        sessionKey: `session-${i}`,
        userId: "u1",
        channelId: "c1",
        metadata: {},
        createdAt: 1000,
        updatedAt: 2000 + i,
        messageCount: 1,
      }));
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => sessions,
          loadByFormattedKey: () => ({
            messages: [{ role: "user", content: "common search term" }],
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "common search term",
        limit: 2,
      })) as { results: Array<{ sessionKey: string }> };

      expect(response.results).toHaveLength(2);
    });

    it("returns recent sessions when query is missing", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({})) as { mode: string; sessions: unknown[]; total: number };
      expect(response.mode).toBe("recent");
      expect(response.sessions).toEqual([]);
    });

    it("returns recent sessions when query is empty string", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({ query: "" })) as { mode: string; sessions: unknown[]; total: number };
      expect(response.mode).toBe("recent");
      expect(response.sessions).toEqual([]);
    });

    it("returns empty results when no matches found", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "no-match-session",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 1,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [{ role: "user", content: "Hello world" }],
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "xyznonexistent",
      })) as { mode: string; results: unknown[]; total: number };

      expect(response.results).toEqual([]);
    });

    it("performs case-insensitive matching", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "case-session",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 1,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [{ role: "user", content: "Hello World" }],
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "hello world",
      })) as { results: Array<{ sessionKey: string; snippet: string }> };

      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.snippet).toContain("Hello World");
    });
  });

  // -------------------------------------------------------------------------
  // session.history — attachment reconstruction
  // -------------------------------------------------------------------------

  describe("session.history", () => {
    it("reconstructs attachment markers from toolCall/toolResult pairs", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [],
          loadByFormattedKey: (key: string) =>
            key === "valid-session"
              ? {
                  messages: [
                    { role: "user", content: "Generate an image of a cat" },
                    {
                      role: "assistant",
                      content: [
                        { type: "text", text: "Here is your image:" },
                        {
                          type: "toolCall",
                          name: "message",
                          id: "tc-attach-1",
                          arguments: {
                            action: "attach",
                            channel_type: "gateway",
                            attachment_url: "/tmp/cat.png",
                            attachment_type: "image",
                            mime_type: "image/png",
                            file_name: "cat.png",
                            caption: "",
                          },
                        },
                      ],
                    },
                    {
                      role: "toolResult",
                      tool_use_id: "tc-attach-1",
                      content: [{ type: "text", text: '{"messageId":"abc123def456.png","channelId":"web:default"}' }],
                    },
                    { role: "assistant", content: "Let me know if you want any changes!" },
                  ],
                  metadata: {},
                  createdAt: Date.now() - 60000,
                  updatedAt: Date.now(),
                }
              : undefined,
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.history"]!({
        session_key: "valid-session",
        limit: 50,
      })) as { messages: Array<{ role: string; content: string }> };

      // The assistant message with the toolCall should include the attachment marker
      const assistantWithAttach = result.messages.find(
        (m) => m.role === "assistant" && m.content.includes("<!-- attachment:"),
      );
      expect(assistantWithAttach).toBeDefined();
      expect(assistantWithAttach!.content).toContain("Here is your image:");
      expect(assistantWithAttach!.content).toContain("/media/abc123def456.png");
      expect(assistantWithAttach!.content).toContain('"type":"image"');
      expect(assistantWithAttach!.content).toContain('"fileName":"cat.png"');
    });

    it("handles tool_use format (Anthropic API) for attachment reconstruction", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [],
          loadByFormattedKey: (key: string) =>
            key === "valid-session"
              ? {
                  messages: [
                    { role: "user", content: "Send me a file" },
                    {
                      role: "assistant",
                      content: [
                        {
                          type: "tool_use",
                          name: "message",
                          id: "tc-attach-2",
                          input: {
                            action: "attach",
                            channel_type: "gateway",
                            attachment_url: "/tmp/doc.pdf",
                            attachment_type: "file",
                            mime_type: "application/pdf",
                            file_name: "report.pdf",
                            caption: "Your report",
                          },
                        },
                      ],
                    },
                    {
                      role: "tool",
                      tool_use_id: "tc-attach-2",
                      content: '{"messageId":"ff99aa.pdf","channelId":"web:default"}',
                    },
                  ],
                  metadata: {},
                  createdAt: Date.now() - 60000,
                  updatedAt: Date.now(),
                }
              : undefined,
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.history"]!({
        session_key: "valid-session",
        limit: 50,
      })) as { messages: Array<{ role: string; content: string }> };

      const assistantMsg = result.messages.find(
        (m) => m.role === "assistant" && m.content.includes("<!-- attachment:"),
      );
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toContain("/media/ff99aa.pdf");
      expect(assistantMsg!.content).toContain("Your report");
      expect(assistantMsg!.content).toContain('"fileName":"report.pdf"');
    });

    it("does not inject markers for non-attach tool calls", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [],
          loadByFormattedKey: (key: string) =>
            key === "valid-session"
              ? {
                  messages: [
                    { role: "user", content: "Hello" },
                    {
                      role: "assistant",
                      content: [
                        { type: "text", text: "Sending your message." },
                        {
                          type: "toolCall",
                          name: "message",
                          id: "tc-send-1",
                          arguments: { action: "send", channel_type: "telegram", channel_id: "123", text: "hi" },
                        },
                      ],
                    },
                    {
                      role: "toolResult",
                      tool_use_id: "tc-send-1",
                      content: [{ type: "text", text: '{"messageId":"msg-1","channelId":"123"}' }],
                    },
                  ],
                  metadata: {},
                  createdAt: Date.now() - 60000,
                  updatedAt: Date.now(),
                }
              : undefined,
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.history"]!({
        session_key: "valid-session",
        limit: 50,
      })) as { messages: Array<{ role: string; content: string }> };

      const hasAttachment = result.messages.some((m) => m.content.includes("<!-- attachment:"));
      expect(hasAttachment).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // session.list — JSONL session merge
  // -------------------------------------------------------------------------

  describe("session.list - JSONL session merge", () => {
    let tempDir: string;

    function setupJsonlDir(agentId: string, files: Record<string, string>): string {
      tempDir = join(tmpdir(), `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const sessionsDir = join(tempDir, agentId, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(sessionsDir, name), content, "utf-8");
      }
      return tempDir;
    }

    function cleanupTempDir(): void {
      if (tempDir) {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    it("merges JSONL sessions with SQLite results", async () => {
      const agentDataDir = setupJsonlDir("default", {
        "jsonl-session-1.jsonl": '{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi"}',
      });
      try {
        const deps = makeDeps({
          agentDataDir,
          sessionStore: {
            listDetailed: () => [
              {
                sessionKey: "sqlite-session-1",
                userId: "user1",
                channelId: "chan1",
                metadata: {},
                createdAt: Date.now() - 60000,
                updatedAt: Date.now(),
                messageCount: 5,
              },
            ],
            loadByFormattedKey: () => ({
              messages: [],
              metadata: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }),
            deleteByFormattedKey: () => false,
            saveByFormattedKey: vi.fn(),
          },
        });
        const handlers = createSessionHandlers(deps);

        const result = (await handlers["session.list"]!({})) as {
          sessions: Array<{ sessionKey: string }>;
          total: number;
        };

        expect(result.total).toBe(2);
        const keys = result.sessions.map(s => s.sessionKey);
        expect(keys).toContain("sqlite-session-1");
        expect(keys).toContain("jsonl-session-1");
      } finally {
        cleanupTempDir();
      }
    });

    it("deduplicates sessions present in both SQLite and JSONL", async () => {
      const agentDataDir = setupJsonlDir("default", {
        "shared-session.jsonl": '{"role":"user","content":"Hello"}',
      });
      try {
        const deps = makeDeps({
          agentDataDir,
          sessionStore: {
            listDetailed: () => [
              {
                sessionKey: "shared-session",
                userId: "user1",
                channelId: "chan1",
                metadata: {},
                createdAt: Date.now() - 60000,
                updatedAt: Date.now(),
                messageCount: 10,
              },
            ],
            loadByFormattedKey: () => ({
              messages: [],
              metadata: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }),
            deleteByFormattedKey: () => false,
            saveByFormattedKey: vi.fn(),
          },
        });
        const handlers = createSessionHandlers(deps);

        const result = (await handlers["session.list"]!({})) as {
          sessions: Array<{ sessionKey: string }>;
          total: number;
        };

        // Should not duplicate -- SQLite version takes precedence
        expect(result.total).toBe(1);
        expect(result.sessions[0]!.sessionKey).toBe("shared-session");
      } finally {
        cleanupTempDir();
      }
    });

    it("works when agentDataDir is not set (no JSONL merge)", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "only-sqlite",
              userId: "user1",
              channelId: "chan1",
              metadata: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messageCount: 3,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [],
            metadata: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.list"]!({})) as {
        sessions: Array<{ sessionKey: string }>;
        total: number;
      };

      expect(result.total).toBe(1);
      expect(result.sessions[0]!.sessionKey).toBe("only-sqlite");
    });

    it("handles non-existent agent sessions directory gracefully", async () => {
      const agentDataDir = join(tmpdir(), `nonexistent-${Date.now()}`);
      const deps = makeDeps({
        agentDataDir,
        sessionStore: {
          listDetailed: () => [],
          loadByFormattedKey: () => undefined,
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.list"]!({})) as {
        sessions: unknown[];
        total: number;
      };

      expect(result.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // session.search -- enhanced
  // -------------------------------------------------------------------------

  describe("session.search -- enhanced", () => {
    /** Helper: create deps with multiple sessions for agentId scoping tests. */
    function makeScopedDeps(overrides?: Partial<SessionHandlerDeps>) {
      return makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "agent:default:tenant1:user1:ch1",
              userId: "user1",
              channelId: "ch1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 3000,
              messageCount: 2,
            },
            {
              sessionKey: "agent:other-agent:tenant1:user2:ch2",
              userId: "user2",
              channelId: "ch2",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 1,
            },
            {
              sessionKey: "agent:default:tenant1:user3:ch3",
              userId: "user3",
              channelId: "ch3",
              metadata: {},
              createdAt: 1000,
              updatedAt: 1000,
              messageCount: 1,
            },
          ],
          loadByFormattedKey: (key: string) => {
            if (key.includes("default") && key.includes("user1")) {
              return {
                messages: [
                  { role: "user", content: "Tell me about matching topic" },
                  { role: "assistant", content: "Here is info about matching topic." },
                ],
                metadata: {},
                createdAt: 1000,
                updatedAt: 3000,
              };
            }
            if (key.includes("other-agent")) {
              return {
                messages: [
                  { role: "user", content: "Also about matching topic here" },
                ],
                metadata: {},
                createdAt: 1000,
                updatedAt: 2000,
              };
            }
            if (key.includes("default") && key.includes("user3")) {
              return {
                messages: [
                  { role: "user", content: "Different matching topic content" },
                ],
                metadata: {},
                createdAt: 1000,
                updatedAt: 1000,
              };
            }
            return undefined;
          },
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
        ...overrides,
      });
    }

    it("returns recent sessions metadata when no query", async () => {
      const deps = makeScopedDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({})) as {
        mode: string;
        sessions: Array<{ sessionKey: string; agentId: string; channelType: string; messageCount: number; updatedAt: number; createdAt: number }>;
        total: number;
      };

      expect(response.mode).toBe("recent");
      expect(response.sessions).toHaveLength(3);
      expect(response.sessions[0]!).toHaveProperty("sessionKey");
      expect(response.sessions[0]!).toHaveProperty("agentId");
      expect(response.sessions[0]!).toHaveProperty("channelType");
      expect(response.sessions[0]!).toHaveProperty("messageCount");
      expect(response.sessions[0]!).toHaveProperty("updatedAt");
      expect(response.sessions[0]!).toHaveProperty("createdAt");
    });

    it("scopes results to caller agentId", async () => {
      const deps = makeScopedDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        _agentId: "default",
      })) as { mode: string; sessions: Array<{ sessionKey: string; agentId: string }> };

      expect(response.mode).toBe("recent");
      // Should only include sessions belonging to "default" agent
      expect(response.sessions).toHaveLength(2);
      for (const s of response.sessions) {
        expect(s.agentId).toBe("default");
      }
    });

    it("agentId scoping works for search mode too", async () => {
      const deps = makeScopedDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "matching topic",
        _agentId: "default",
      })) as { mode: string; results: Array<{ sessionKey: string; agentId: string }> };

      expect(response.mode).toBe("search");
      // other-agent session should be excluded
      expect(response.results).toHaveLength(2);
      for (const r of response.results) {
        expect(r.agentId).toBe("default");
      }
    });

    it("returns raw snippets when summarizeSession is undefined", async () => {
      const deps = makeScopedDeps();
      // No summarizeSession in deps
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "matching topic",
      })) as { results: Array<{ snippet: string; summary?: string; rawSnippet?: string }> };

      expect(response.results.length).toBeGreaterThan(0);
      for (const r of response.results) {
        expect(r.snippet).toBeTruthy();
        expect(r.summary).toBeUndefined();
        expect(r.rawSnippet).toBeUndefined();
      }
    });

    it("calls summarizeSession for each result when available", async () => {
      const summarizeSession = vi.fn(async () => "LLM summary text");
      const deps = makeScopedDeps({ summarizeSession });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "matching topic",
      })) as { results: Array<{ snippet: string; summary?: string; rawSnippet?: string }> };

      expect(response.results.length).toBeGreaterThan(0);
      expect(summarizeSession).toHaveBeenCalled();
      for (const r of response.results) {
        expect(r.summary).toBe("LLM summary text");
        expect(r.rawSnippet).toBeTruthy();
      }
    });

    it("handles summarization failure gracefully", async () => {
      const summarizeSession = vi.fn(async () => {
        throw new Error("model error");
      });
      const deps = makeScopedDeps({ summarizeSession });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "matching topic",
      })) as { results: Array<{ snippet: string; summary?: string }> };

      // Should still return results with original snippets, no throw
      expect(response.results.length).toBeGreaterThan(0);
      for (const r of response.results) {
        expect(r.snippet).toBeTruthy();
        // summary not set on failure
        expect(r.summary).toBeUndefined();
      }
    });

    it("respects summarize=false flag", async () => {
      const summarizeSession = vi.fn(async () => "should not appear");
      const deps = makeScopedDeps({ summarizeSession });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "matching topic",
        summarize: false,
      })) as { results: Array<{ snippet: string; summary?: string }> };

      expect(response.results.length).toBeGreaterThan(0);
      expect(summarizeSession).not.toHaveBeenCalled();
      for (const r of response.results) {
        expect(r.summary).toBeUndefined();
      }
    });

    it("caps summarization at 5 sessions", async () => {
      const summarizeSession = vi.fn(async () => "summary");
      const manySessions = Array.from({ length: 10 }, (_, i) => ({
        sessionKey: `session-${i}`,
        userId: "u1",
        channelId: "c1",
        metadata: {},
        createdAt: 1000,
        updatedAt: 2000 + i,
        messageCount: 1,
      }));
      const deps = makeDeps({
        summarizeSession,
        sessionStore: {
          listDetailed: () => manySessions,
          loadByFormattedKey: () => ({
            messages: [{ role: "user", content: "common term for matching" }],
            metadata: {},
            createdAt: 1000,
            updatedAt: 2000,
          }),
          deleteByFormattedKey: () => false,
          saveByFormattedKey: vi.fn(),
        },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "common term",
        limit: 10,
      })) as { results: Array<{ summary?: string }> };

      // 10 results but only 5 summarized
      expect(response.results).toHaveLength(10);
      expect(summarizeSession).toHaveBeenCalledTimes(5);
    });

    it("skips scoping when _agentId is not provided (backward compat)", async () => {
      const deps = makeScopedDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.search"]!({
        query: "matching topic",
      })) as { results: Array<{ sessionKey: string }> };

      // Without _agentId, all sessions should be searched (3 total, all match)
      expect(response.results).toHaveLength(3);
    });
  });
});
