// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createSessionHandlers as createSessionHandlersRaw } from "./session-handlers/index.js";
import type { SessionHandlerDeps } from "./session-handlers/index.js";
import { withHeldCapabilities } from "../../../../test/support/held-capabilities.js";
import { createConversationRef, createNoOpDeliveryMirror, type ConversationRef, type ConversationScope } from "@comis/core";
import { ok } from "@comis/shared";

// The gated session.spawn handler requires an injected `_capabilities`
// (orch:spawn) at its top — production supplies it via createAgentRpcCall
// (setup-tools-capabilities.ts). These body-tests call the handlers directly,
// so wrap the bound record to carry the held cap each gated method needs. The
// ungated session.* methods (delete/reset/export/compact/etc., governed by
// `_trustLevel`) pass through unchanged.
function createSessionHandlers(deps: SessionHandlerDeps): ReturnType<typeof createSessionHandlersRaw> {
  const refToSessionKey = new Map<ConversationRef, string>();
  const rawStore = deps.sessionStore as any;
  const normalizeResult = <T>(value: T) => (
    value && typeof value === "object" && "ok" in value ? value : ok(value)
  );
  const scopeForKey = (sessionKey: string): ConversationScope => ({
    tenantId: "default",
    agentId: "default",
    partition: { kind: "principal", principalId: sessionKey },
  });
  const locatorForKey = (sessionKey: string) => {
    const scope = scopeForKey(sessionKey);
    const reference = createConversationRef(scope);
    if (!reference.ok) throw reference.error;
    refToSessionKey.set(reference.value, sessionKey);
    return { scope, conversationRef: reference.value };
  };
  const sessionStore = {
    ...rawStore,
    loadByRef: (scope: { tenantId: string; agentId: string }, conversationRef: ConversationRef) => {
      if (rawStore.loadByRef) return normalizeResult(rawStore.loadByRef(scope, conversationRef));
      const sessionKey = refToSessionKey.get(conversationRef) ?? "valid-session";
      const value = rawStore.loadByFormattedKey?.(sessionKey);
      return normalizeResult(value === undefined ? undefined : {
        ...value,
        conversationRef,
        conversationScope: scopeForKey(sessionKey),
      });
    },
    deleteByRef: (scope: { tenantId: string; agentId: string }, conversationRef: ConversationRef) => {
      if (rawStore.deleteByRef) return normalizeResult(rawStore.deleteByRef(scope, conversationRef));
      return normalizeResult(rawStore.deleteByFormattedKey?.(refToSessionKey.get(conversationRef) ?? "valid-session") ?? false);
    },
    save: (scope: ConversationScope, messages: unknown[], metadata: Record<string, unknown>) => {
      if (rawStore.save) return normalizeResult(rawStore.save(scope, messages, metadata));
      const reference = createConversationRef(scope);
      const sessionKey = reference.ok ? refToSessionKey.get(reference.value) ?? "valid-session" : "valid-session";
      return normalizeResult(rawStore.saveByFormattedKey?.(sessionKey, messages, metadata));
    },
    listDetailed: (scope: { tenantId: string; agentId: string }) => {
      const listed = normalizeResult<any[]>(rawStore.listDetailed?.(scope) ?? []);
      if (!listed.ok) return listed;
      return ok(listed.value.map((row) => {
        if (row.conversationScope && row.conversationRef) return row;
        const sessionKey = typeof row.sessionKey === "string" ? row.sessionKey : "valid-session";
        const locator = locatorForKey(sessionKey);
        return {
          ...row,
          conversationRef: locator.conversationRef,
          conversationScope: locator.scope,
          agentId: locator.scope.agentId,
        };
      }));
    },
  };
  const rawHandlers = withHeldCapabilities(createSessionHandlersRaw({ ...deps, sessionStore }));
  return Object.fromEntries(Object.entries(rawHandlers).map(([method, handler]) => [
    method,
    (params: Record<string, unknown>) => {
      const namedKey = typeof params.session_key === "string"
        ? params.session_key
        : typeof params._callerSessionKey === "string"
          ? params._callerSessionKey
          : "valid-session";
      const authority = locatorForKey(namedKey === "self" ? "valid-session" : namedKey);
      return handler({
        tenant_id: authority.scope.tenantId,
        agent_id: authority.scope.agentId,
        conversation_ref: authority.conversationRef,
        ...params,
      });
    },
  ])) as ReturnType<typeof createSessionHandlersRaw>;
}

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
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as never,
    deliveryMirror: createNoOpDeliveryMirror(),
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
      })) as { conversationRef: string; deleted: boolean; transcript: { messageCount: number } };

      expect(result.conversationRef).toMatch(/^cv_/);
      expect(result.deleted).toBe(true);
      expect(result.transcript.messageCount).toBe(2);
      expect(result.transcript).toHaveProperty("messages");
      expect(result.transcript).toHaveProperty("metadata");
    });

    it("reports a missing canonical conversation", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.delete"]!({ session_key: "non-existent", _trustLevel: "admin" }),
      ).rejects.toThrow(/Conversation not found: cv_/);
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

    it("severs the LCD and runtime layers so a deleted session cannot resurface in session.list", async () => {
      // Deletion must clear every authoritative persistence layer so a
      // recreated conversation cannot inherit the deleted transcript.
      const lcdStore = {
        runOnConversation: vi.fn(async (_id: string, fn: () => Promise<number>) => fn()),
        deleteConversationLcd: vi.fn(async () => 3),
      };
      const destroyRuntimeSession = vi.fn(async () => true);
      const deps = makeDeps({
        lcdStore: lcdStore as never,
        destroyRuntimeSession: destroyRuntimeSession as never,
        tenantId: "default",
      });
      const handlers = createSessionHandlers(deps);

      const result = (await handlers["session.delete"]!({
        session_key: "valid-session",
        _trustLevel: "admin",
      })) as { deleted: boolean };

      expect(result.deleted).toBe(true);
      expect(lcdStore.deleteConversationLcd).toHaveBeenCalled();
      expect(destroyRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "default", agentId: "default" }),
        expect.objectContaining({ tenantId: "default", agentId: "default" }),
      );
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
      })) as { conversationRef: string; reset: boolean; previousMessageCount: number };

      expect(result.conversationRef).toMatch(/^cv_/);
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

    it("reports a missing canonical conversation", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.reset"]!({ session_key: "non-existent" }),
      ).rejects.toThrow(/Conversation not found: cv_/);
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
        conversationRef: string;
        messages: unknown[];
        metadata: Record<string, unknown>;
        messageCount: number;
        createdAt: number;
        updatedAt: number;
      };

      expect(result.conversationRef).toMatch(/^cv_/);
      expect(result.messages).toHaveLength(2);
      expect(result.metadata).toBeDefined();
      expect(result.messageCount).toBe(2);
      expect(result.createdAt).toEqual(expect.any(Number));
      expect(result.updatedAt).toEqual(expect.any(Number));
    });

    it("reports a missing canonical conversation", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.export"]!({ session_key: "non-existent", _trustLevel: "admin" }),
      ).rejects.toThrow(/Conversation not found: cv_/);
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
        conversationRef: string;
        messageCount: number;
        estimatedTokens: number;
        compactionTriggered: boolean;
        instructions: string | null;
      };

      expect(result.conversationRef).toMatch(/^cv_/);
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

    it("reports a missing canonical conversation", async () => {
      const deps = makeDeps();
      const handlers = createSessionHandlers(deps);

      await expect(
        handlers["session.compact"]!({ session_key: "non-existent" }),
      ).rejects.toThrow(/Conversation not found: cv_/);
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
      })) as { mode: string; results: Array<{ conversationRef: string; agentId: string; channelType: string; snippet: string; score: number; timestamp: number }>; total: number };

      expect(response.mode).toBe("search");
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.conversationRef).toMatch(/^cv_/);
      expect(response.results[0]!.agentId).toBe("default");
      expect(response.results[0]!.channelType).toBe("dm");
      expect(response.results[0]!.snippet).toContain("TypeScript");
      expect(response.results[0]!.score).toBe(1.0);
      expect(typeof response.results[0]!.timestamp).toBe("number");
    });

    it("matches multi-keyword queries whose terms are non-contiguous in the message (token-AND, not substring)", async () => {
      // Live finding 2026-06-12: `axolotl Quark` returned 0 against a message
      // reading "...a purple axolotl named Quark" because the handler did a
      // literal indexOf on the whole query. The tool advertises "keywords",
      // so all query tokens present (order-independent) must match.
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "kw-session",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 1,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [
              { role: "assistant", content: "The mascot is a purple axolotl named Quark." },
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
        query: "axolotl Quark",
      })) as { results: Array<{ conversationRef: string; snippet: string }>; total: number };

      expect(response.total).toBe(1);
      expect(response.results[0]!.conversationRef).toMatch(/^cv_/);
      // Snippet anchors on a matched term and shows the surrounding text.
      expect(response.results[0]!.snippet.toLowerCase()).toContain("axolotl");
    });

    it("does NOT match when only some query keywords are present (AND, not OR)", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [
            {
              sessionKey: "partial-session",
              userId: "u1",
              channelId: "c1",
              metadata: {},
              createdAt: 1000,
              updatedAt: 2000,
              messageCount: 1,
            },
          ],
          loadByFormattedKey: () => ({
            messages: [{ role: "user", content: "the axolotl is purple" }],
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
        query: "axolotl Quark",
      })) as { results: unknown[]; total: number };
      expect(response.total).toBe(0);
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
                      toolCallId: "tc-attach-1",
                      content: [{ type: "text", text: '{"messageId":"abc123def4567890.png","channelId":"web:default"}' }],
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
      expect(assistantWithAttach!.content).toContain("/media/abc123def4567890.png");
      expect(assistantWithAttach!.content).toContain('"type":"image"');
      expect(assistantWithAttach!.content).toContain('"fileName":"cat.png"');
      const markerMatch = assistantWithAttach!.content.match(/<!-- attachment:(\{.*\}) -->/s);
      expect(markerMatch).not.toBeNull();
      expect(JSON.parse(markerMatch![1])).toEqual({
        url: "/media/abc123def4567890.png",
        type: "image",
        mimeType: "image/png",
        fileName: "cat.png",
      });
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

    it("does not map non-gateway attachment results onto the local media route", async () => {
      const deps = makeDeps({
        sessionStore: {
          listDetailed: () => [],
          loadByFormattedKey: (key: string) =>
            key === "valid-session"
              ? {
                  messages: [
                    {
                      role: "assistant",
                      content: [{
                        type: "toolCall",
                        name: "message",
                        id: "tc-telegram-attachment",
                        arguments: {
                          action: "attach",
                          channel_type: "telegram",
                          attachment_type: "image",
                          mime_type: "image/png",
                          file_name: "remote.png",
                        },
                      }],
                    },
                    {
                      role: "toolResult",
                      tool_use_id: "tc-telegram-attachment",
                      content: '{"messageId":"telegram-message-42","channelId":"chat-42"}',
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

      expect(result.messages.some((message) => message.content.includes("<!-- attachment:"))).toBe(false);
      expect(JSON.stringify(result.messages)).not.toContain("/media/telegram-message-42");
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
        sessions: Array<{ conversationRef: string; agentId: string; channelType: string; messageCount: number; updatedAt: number; createdAt: number }>;
        total: number;
      };

      expect(response.mode).toBe("recent");
      expect(response.sessions).toHaveLength(3);
      expect(response.sessions[0]!).toHaveProperty("conversationRef");
      expect(response.sessions[0]!).toHaveProperty("agentId");
      expect(response.sessions[0]!).toHaveProperty("channelType");
      expect(response.sessions[0]!).toHaveProperty("messageCount");
      expect(response.sessions[0]!).toHaveProperty("updatedAt");
      expect(response.sessions[0]!).toHaveProperty("createdAt");
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

  });

  // -------------------------------------------------------------------------
  // session.spawn (async-only; dedup propagation)
  // -------------------------------------------------------------------------
  //
  // The sync-wait poll-until-complete branch was deleted
  // (CHANGELOG: callers passing `async: false` are now
  // treated as async). The async response no longer carries the
  // multi-line `note` field that the legacy sync-timeout branch produced —
  // the `noteType: "background_running"` field IS the canonical signal.

  describe("session.spawn", () => {
    function makeSpawnDeps(overrides?: Partial<SessionHandlerDeps>): SessionHandlerDeps {
      // subAgentRunner stub returns a stable runId; getRunStatus
      // returns "running" so the async-response path emits the base
      // (non-queued) shape.
      const subAgentRunner = {
        spawn: vi.fn().mockReturnValue("test-run-id-001"),
        getRunStatus: vi.fn().mockReturnValue({
          runId: "test-run-id-001",
          status: "running",
          agentId: "default",
          task: "any",
          sessionKey: "",
          startedAt: 0,
          depth: 0,
        }),
        lastSpawnDedupInfo: vi.fn(() => undefined),
      } as never;
      const securityConfig = { agentToAgent: { enabled: true, waitTimeoutMs: 10 } };
      return makeDeps({ subAgentRunner, securityConfig, ...overrides });
    }

    it("async response carries runId + inProgress + background_running noteType", async () => {
      const deps = makeSpawnDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.spawn"]!({
        task: "T",
      })) as Record<string, unknown>;

      expect(response.runId).toBe("test-run-id-001");
      expect(response.async).toBe(true);
      expect(response.inProgress).toBe(true);
      expect(response.noteType).toBe("background_running");
    });

    it("legacy timeout note string no longer appears in spawn response", async () => {
      const deps = makeSpawnDeps();
      const handlers = createSessionHandlers(deps);

      const response = await handlers["session.spawn"]!({
        task: "T",
      });

      expect(JSON.stringify(response).includes("Spawn timed out, check run_status later")).toBe(false);
    });

    it("response includes deduped and existingRunId when spawn deduped against in-flight run", async () => {
      const subAgentRunner = {
        spawn: vi.fn().mockReturnValue("test-run-id-001"),
        getRunStatus: vi.fn().mockReturnValue({
          runId: "test-run-id-001",
          status: "running",
          agentId: "default",
          task: "any",
          sessionKey: "",
          startedAt: 0,
          depth: 0,
        }),
        lastSpawnDedupInfo: vi.fn(() => ({
          deduped: true as const,
          existingRunId: "run-zzz-existing",
          ageMs: 1234,
        })),
      } as never;
      const deps = makeDeps({
        subAgentRunner,
        securityConfig: { agentToAgent: { enabled: true, waitTimeoutMs: 10 } },
      });
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.spawn"]!({
        task: "T",
      })) as Record<string, unknown>;

      expect(response.deduped).toBe(true);
      expect(response.existingRunId).toBe("run-zzz-existing");
      expect(response.dedupAgeMs).toBe(1234);
      // The dedup signal is additive — still has the in-progress signal.
      expect(response.inProgress).toBe(true);
      expect(response.noteType).toBe("background_running");
    });

    it("response omits deduped fields when no dedup hit occurred for this spawn", async () => {
      const deps = makeSpawnDeps();
      const handlers = createSessionHandlers(deps);

      const response = (await handlers["session.spawn"]!({
        task: "T",
      })) as Record<string, unknown>;

      expect("deduped" in response).toBe(false);
      expect("existingRunId" in response).toBe(false);
      expect(response.inProgress).toBe(true);
      expect(response.noteType).toBe("background_running");
    });
  });
});
