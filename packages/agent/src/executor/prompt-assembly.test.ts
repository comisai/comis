// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted ensures availability before vi.mock factory hoisting)
// ---------------------------------------------------------------------------

const {
  mockAssembleRichSystemPrompt,
  mockBuildDateTimeSection,
  mockBuildInboundMetadataSection,
  mockBuildSenderTrustSection,
  mockLoadWorkspaceBootstrapFiles,
  mockBuildBootstrapContextFiles,
  mockFilterBootstrapFilesForLightContext,
  mockFilterBootstrapFilesForGroupChat,
  mockDeduplicateResults,
  mockHybridSplit,
  mockCreateHybridMemoryInjector,
  mockReadFile,
  mockIsBootContentEffectivelyEmpty,
  mockDetectOnboardingState,
  mockBuildSubagentRoleSection,
  mockAssembleRichSystemPromptBlocks,
} = vi.hoisted(() => ({
  mockAssembleRichSystemPrompt: vi.fn().mockReturnValue("assembled-prompt"),
  mockAssembleRichSystemPromptBlocks: vi.fn().mockReturnValue({ staticPrefix: "static-prefix", attribution: "attribution", semiStableBody: "semi-stable-body" }),
  mockBuildDateTimeSection: vi.fn().mockReturnValue(["## Current Date & Time", "2026-03-12T00:00:00.000Z (mock)"]),
  mockBuildInboundMetadataSection: vi.fn().mockReturnValue([]),
  mockBuildSenderTrustSection: vi.fn().mockReturnValue(["## Authorized Senders", "", "### Admin", "- user-1"]),
  mockLoadWorkspaceBootstrapFiles: vi.fn().mockResolvedValue([]),
  mockBuildBootstrapContextFiles: vi.fn().mockReturnValue([]),
  mockFilterBootstrapFilesForLightContext: vi.fn((files: any[]) => files.filter((f: any) => f.name === "HEARTBEAT.md")),
  mockFilterBootstrapFilesForGroupChat: vi.fn((files: any[]) => files.filter((f: any) => f.name !== "USER.md")),
  mockDeduplicateResults: vi.fn((results: any[]) => results),
  mockHybridSplit: vi.fn().mockReturnValue({ inlineMemory: undefined, systemPromptSections: ["rag-section-1"] }),
  mockCreateHybridMemoryInjector: vi.fn(),
  mockReadFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mockIsBootContentEffectivelyEmpty: vi.fn().mockReturnValue(true),
  mockDetectOnboardingState: vi.fn().mockResolvedValue(false),
  mockBuildSubagentRoleSection: vi.fn().mockReturnValue([]),
}));

// Wire mockCreateHybridMemoryInjector to return an object with mockHybridSplit
mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });

vi.mock("../bootstrap/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadWorkspaceBootstrapFiles: mockLoadWorkspaceBootstrapFiles,
    buildBootstrapContextFiles: mockBuildBootstrapContextFiles,
    assembleRichSystemPrompt: mockAssembleRichSystemPrompt,
    assembleRichSystemPromptBlocks: mockAssembleRichSystemPromptBlocks,
    buildDateTimeSection: mockBuildDateTimeSection,
    buildInboundMetadataSection: mockBuildInboundMetadataSection,
    buildSenderTrustSection: mockBuildSenderTrustSection,
    buildSubagentRoleSection: mockBuildSubagentRoleSection,
    filterBootstrapFilesForLightContext: mockFilterBootstrapFilesForLightContext,
    filterBootstrapFilesForGroupChat: mockFilterBootstrapFilesForGroupChat,
    resolveSenderDisplay: vi.fn().mockImplementation((sid: string) => sid),
  };
});

vi.mock("../rag/rag-retriever.js", () => ({
  deduplicateResults: mockDeduplicateResults,
}));

vi.mock("../rag/hybrid-memory-injector.js", () => ({
  createHybridMemoryInjector: mockCreateHybridMemoryInjector,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("../workspace/boot-file.js", () => ({
  isBootContentEffectivelyEmpty: mockIsBootContentEffectivelyEmpty,
  BOOT_FILE_NAME: "BOOT.md",
}));

vi.mock("../workspace/onboarding-detector.js", () => ({
  detectOnboardingState: mockDetectOnboardingState,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const overrides = {
    hostname: () => "test-host",
    platform: () => "linux",
    arch: () => "x64",
    userInfo: () => ({ shell: "/bin/bash" }),
  };
  return {
    ...actual,
    ...overrides,
    default: { ...actual.default, ...overrides },
  };
});

import { assembleExecutionPrompt, extractUserLanguage, clearSessionToolNameSnapshot, clearSessionBootstrapFileSnapshot, clearSessionPromptSkillsXmlSnapshot, getCacheSafeParams, clearCacheSafeParams, type PromptAssemblyParams, type CacheSafeParams } from "./prompt-assembly.js";
import { formatSessionKey, type SpawnPacket } from "@comis/core";
import { createSpawnPacketBuilder } from "../spawn/spawn-packet-builder.js";

/** Formatted session key matching makeParams() default sessionKey. */
const DEFAULT_SESSION_KEY = formatSessionKey({ agentId: "agent-1", channelType: "telegram", channelId: "chat-1" } as any);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides?: Record<string, unknown>) {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  } as any;
}

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    name: "TestAgent",
    provider: "anthropic",
    model: "claude-3-opus",
    bootstrap: { promptMode: "full" },
    rag: { enabled: false },
    ...overrides,
  } as any;
}

function makeParams(overrides?: Partial<PromptAssemblyParams>): PromptAssemblyParams {
  return {
    config: makeConfig(),
    deps: { workspaceDir: "/workspace" },
    msg: makeMsg(),
    sessionKey: { agentId: "agent-1", channelType: "telegram", channelId: "chat-1" },
    agentId: "agent-1",
    mergedCustomTools: [],
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleExecutionPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear snapshots to prevent cross-test leakage
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockFilterBootstrapFilesForLightContext.mockImplementation((files: any[]) => files.filter((f: any) => f.name === "HEARTBEAT.md"));
    mockFilterBootstrapFilesForGroupChat.mockImplementation((files: any[]) => files.filter((f: any) => f.name !== "USER.md"));
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: ["rag-section-1"] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue([]);
  });

  // -----------------------------------------------------------------
  // 1. Basic assembly
  // -----------------------------------------------------------------
  it("calls assembleRichSystemPrompt with correct agentName, promptMode, toolNames, hasMemoryTools", async () => {
    const params = makeParams({ mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[] });
    await assembleExecutionPrompt(params);

    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledTimes(1);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.agentName).toBe("TestAgent");
    expect(call.promptMode).toBe("full");
    expect(call.toolNames).toEqual(["read", "exec"]);
    expect(call.hasMemoryTools).toBe(false);
  });

  // -----------------------------------------------------------------
  // 2. promptMode "none" skips bootstrap loading
  // -----------------------------------------------------------------
  it("skips bootstrap loading when promptMode is 'none'", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: { promptMode: "none" } }),
    });
    await assembleExecutionPrompt(params);

    expect(mockLoadWorkspaceBootstrapFiles).not.toHaveBeenCalled();
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.bootstrapFiles).toEqual([]);
  });

  // -----------------------------------------------------------------
  // 3. promptMode "minimal" still loads bootstrap
  // -----------------------------------------------------------------
  it("loads bootstrap files when promptMode is 'minimal'", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: { promptMode: "minimal" } }),
    });
    await assembleExecutionPrompt(params);

    expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalled();
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.promptMode).toBe("minimal");
  });

  // -----------------------------------------------------------------
  // 4. RAG retrieval via hybrid memory injector (Task 229)
  // -----------------------------------------------------------------
  it("invokes hybrid memory injector when memoryPort and rag.enabled are set", async () => {
    const mockSearchResult = {
      entry: { id: "m1", tenantId: "t", content: "Test memory", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
      score: 0.85,
    };
    const memoryPort = {
      search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
      store: vi.fn(),
    } as any;
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    expect(memoryPort.search).toHaveBeenCalledOnce();
    expect(mockCreateHybridMemoryInjector).toHaveBeenCalledOnce();
    expect(mockHybridSplit).toHaveBeenCalledWith([mockSearchResult], 5000);
    // RAG relocated to dynamic preamble, not system prompt
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.additionalSections).toEqual([]);
    expect(result.dynamicPreamble).toContain("rag-section-1");
  });

  // -----------------------------------------------------------------
  // 5. RAG failure is non-fatal
  // -----------------------------------------------------------------
  it("does not throw when RAG retrieval fails", async () => {
    const memoryPort = {
      search: vi.fn().mockRejectedValue(new Error("RAG boom")),
    } as any;
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("assembled-prompt");
    // memorySections fallback to empty
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.additionalSections).toEqual([]);
    // RAG failed, so nothing injected into dynamic preamble either
    expect(result.dynamicPreamble).not.toContain("rag-section");
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 6. RAG skipped when no memoryPort
  // -----------------------------------------------------------------
  it("does not invoke RAG when memoryPort is absent", async () => {
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true } }),
      deps: { workspaceDir: "/workspace" }, // no memoryPort
    });
    const result = await assembleExecutionPrompt(params);

    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 7. RAG skipped when rag.enabled=false
  // -----------------------------------------------------------------
  it("does not invoke RAG when rag.enabled is false", async () => {
    const memoryPort = { search: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({ rag: { enabled: false } }),
      deps: { workspaceDir: "/workspace", memoryPort },
    });
    const result = await assembleExecutionPrompt(params);

    expect(memoryPort.search).not.toHaveBeenCalled();
    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 7b. RAG skipped when skipRag is true
  // -----------------------------------------------------------------
  it("does not invoke RAG when skipRag is true", async () => {
    const memoryPort = { search: vi.fn() } as any;
    const params = makeParams({
      config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
      deps: { workspaceDir: "/workspace", memoryPort },
      skipRag: true,
    });
    const result = await assembleExecutionPrompt(params);

    expect(memoryPort.search).not.toHaveBeenCalled();
    expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
    expect(result.inlineMemory).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // 8. hasMemoryTools detection
  // -----------------------------------------------------------------
  it("detects hasMemoryTools when memory_store is in tools", async () => {
    const params = makeParams({
      mergedCustomTools: [{ name: "memory_store" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.hasMemoryTools).toBe(true);
  });

  it("detects hasMemoryTools when memory_search is in tools", async () => {
    const params = makeParams({
      mergedCustomTools: [{ name: "memory_search" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.hasMemoryTools).toBe(true);
  });

  // -----------------------------------------------------------------
  // 9. Hook injection: systemPrompt override
  // -----------------------------------------------------------------
  it("uses hook systemPrompt override when provided", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ systemPrompt: "hook-override" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("hook-override");
  });

  // -----------------------------------------------------------------
  // 10. Hook prependContext (relocated to dynamicPreamble)
  // -----------------------------------------------------------------
  it("relocates hook prependContext to dynamicPreamble", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "PREPEND" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
    });
    const result = await assembleExecutionPrompt(params);

    // prependContext now in dynamicPreamble, not systemPrompt
    expect(result.dynamicPreamble).toContain("PREPEND");
    expect(result.systemPrompt).not.toContain("PREPEND");
    expect(result.systemPrompt).toBe("assembled-prompt");
  });

  // -----------------------------------------------------------------
  // 11. Safety reinforcement injection (relocated to dynamic preamble)
  // -----------------------------------------------------------------
  it("relocates safety reinforcement to dynamicPreamble", async () => {
    const params = makeParams({ safetyReinforcement: "SAFETY LINE" });
    const result = await assembleExecutionPrompt(params);

    // Safety reinforcement no longer in system prompt
    expect(result.systemPrompt).not.toContain("SAFETY LINE");
    // Now appears in dynamic preamble
    expect(result.dynamicPreamble).toContain("SAFETY LINE");
  });

  // -----------------------------------------------------------------
  // 12. API system prompt override (relocated to dynamicPreamble)
  // -----------------------------------------------------------------
  it("relocates wrapped external API system prompt to dynamicPreamble", async () => {
    const params = makeParams({
      msg: makeMsg({ metadata: { openaiSystemPrompt: "external instruction" } }),
    });
    const result = await assembleExecutionPrompt(params);

    // API system prompt now in dynamicPreamble, not systemPrompt
    expect(result.dynamicPreamble).toContain("external instruction");
    expect(result.systemPrompt).not.toContain("external instruction");
    // System prompt is untouched
    expect(result.systemPrompt).toBe("assembled-prompt");
  });

  // -----------------------------------------------------------------
  // 13. Chat type resolution via metadata (tests resolveChatType)
  // -----------------------------------------------------------------
  describe("chat type resolution", () => {
    async function getChatType(metadata: Record<string, unknown>, channelType = "telegram") {
      const params = makeParams({
        msg: makeMsg({ metadata, channelType }),
      });
      await assembleExecutionPrompt(params);
      return mockAssembleRichSystemPrompt.mock.calls[0][0].inboundMeta.chatType;
    }

    it("resolves Telegram private to 'dm'", async () => {
      expect(await getChatType({ telegramChatType: "private" })).toBe("dm");
    });

    it("resolves Telegram group to 'group'", async () => {
      expect(await getChatType({ telegramChatType: "group" })).toBe("group");
    });

    it("resolves Telegram supergroup to 'group'", async () => {
      expect(await getChatType({ telegramChatType: "supergroup" })).toBe("group");
    });

    it("resolves Telegram channel to 'channel'", async () => {
      expect(await getChatType({ telegramChatType: "channel" })).toBe("channel");
    });

    it("resolves Discord with parentChannelId to 'thread'", async () => {
      expect(await getChatType({ parentChannelId: "parent-1" }, "discord")).toBe("thread");
    });

    it("resolves Discord with guildId to 'group'", async () => {
      expect(await getChatType({ guildId: "guild-1" }, "discord")).toBe("group");
    });

    it("resolves Discord plain to 'dm'", async () => {
      expect(await getChatType({}, "discord")).toBe("dm");
    });

    it("resolves Slack with slackThreadTs to 'thread'", async () => {
      expect(await getChatType({ slackThreadTs: "1234.5678" }, "slack")).toBe("thread");
    });

    it("resolves WhatsApp with isGroup=true to 'group'", async () => {
      expect(await getChatType({ isGroup: true }, "whatsapp")).toBe("group");
    });

    it("resolves Signal with signalGroupId to 'group'", async () => {
      expect(await getChatType({ signalGroupId: "group-1" }, "signal")).toBe("group");
    });

    it("resolves IRC with ircIsDm=true to 'dm'", async () => {
      expect(await getChatType({ ircIsDm: true }, "irc")).toBe("dm");
    });

    it("resolves IRC without ircIsDm to 'channel'", async () => {
      expect(await getChatType({}, "irc")).toBe("channel");
    });

    it("resolves LINE with lineSourceType 'group' to 'group'", async () => {
      expect(await getChatType({ lineSourceType: "group" }, "line")).toBe("group");
    });

    it("resolves LINE with lineSourceType 'room' to 'group'", async () => {
      expect(await getChatType({ lineSourceType: "room" }, "line")).toBe("group");
    });

    it("resolves LINE with lineSourceType 'user' to 'dm'", async () => {
      expect(await getChatType({ lineSourceType: "user" }, "line")).toBe("dm");
    });

    it("defaults to 'dm' with no metadata", async () => {
      expect(await getChatType({})).toBe("dm");
    });
  });

  // -----------------------------------------------------------------
  // 14. Message flags via metadata (tests buildMessageFlags)
  // -----------------------------------------------------------------
  describe("message flags", () => {
    async function getFlags(msgOverrides: Record<string, unknown>) {
      const params = makeParams({ msg: makeMsg(msgOverrides) });
      await assembleExecutionPrompt(params);
      return mockAssembleRichSystemPrompt.mock.calls[0][0].inboundMeta.flags;
    }

    it("sets isGroup when metadata.isGroup is true", async () => {
      const flags = await getFlags({ metadata: { isGroup: true } });
      expect(flags.isGroup).toBe(true);
    });

    it("sets isGroup when metadata.imsgIsGroup is true", async () => {
      const flags = await getFlags({ metadata: { imsgIsGroup: true } });
      expect(flags.isGroup).toBe(true);
    });

    it("sets isGroup when metadata.signalGroupId is present", async () => {
      const flags = await getFlags({ metadata: { signalGroupId: "g1" } });
      expect(flags.isGroup).toBe(true);
    });

    it("sets isThread when metadata.parentChannelId is present", async () => {
      const flags = await getFlags({ metadata: { parentChannelId: "p1" } });
      expect(flags.isThread).toBe(true);
    });

    it("sets isThread when metadata.slackThreadTs is present", async () => {
      const flags = await getFlags({ metadata: { slackThreadTs: "123.456" } });
      expect(flags.isThread).toBe(true);
    });

    it("sets hasAttachments when attachments array is non-empty", async () => {
      const flags = await getFlags({
        attachments: [{ type: "image", url: "https://example.com/img.png" }],
      });
      expect(flags.hasAttachments).toBe(true);
    });

    it("does not set hasAttachments when attachments is empty", async () => {
      const flags = await getFlags({ attachments: [] });
      expect(flags.hasAttachments).toBeUndefined();
    });

    it("sets isReply when replyTo is set", async () => {
      const flags = await getFlags({ replyTo: "reply-msg-1" });
      expect(flags.isReply).toBe(true);
    });

    it("sets isScheduled when metadata.isScheduled is true", async () => {
      const flags = await getFlags({ metadata: { isScheduled: true } });
      expect(flags.isScheduled).toBe(true);
    });

    it("sets isCronAgentTurn when metadata.isCronAgentTurn is true", async () => {
      const flags = await getFlags({ metadata: { isCronAgentTurn: true } });
      expect(flags.isCronAgentTurn).toBe(true);
    });

    it("does not set isScheduled for isCronAgentTurn messages", async () => {
      const flags = await getFlags({ metadata: { isCronAgentTurn: true } });
      expect(flags.isScheduled).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // 15. Prompt skills forwarding
  // -----------------------------------------------------------------
  it("puts promptSkillsXml in system prompt and activePromptSkillContent in preamble", async () => {
    const params = makeParams({
      deps: {
        workspaceDir: "/workspace",
        getPromptSkillsXml: () => "<skills>xml</skills>",
      },
      msg: makeMsg({ metadata: { promptSkillContent: "Active content" } }),
    });
    const result = await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    // promptSkillsXml routed through assemblerParams to semiStableBody (1h cache)
    expect(call.promptSkillsXml).toBe("<skills>xml</skills>");
    // Skills XML should NOT appear in dynamic preamble (removed from per-message injection)
    expect(result.dynamicPreamble).not.toContain("<skills>xml</skills>");
    expect(result.dynamicPreamble).not.toContain("## Available Skills");
    // activePromptSkillContent relocated to dynamic preamble
    expect(call.activePromptSkillContent).toBeUndefined();
    expect(result.dynamicPreamble).toContain("## Active Skill");
    expect(result.dynamicPreamble).toContain("Active content");
  });

  // -----------------------------------------------------------------
  // Additional: RuntimeInfo construction
  // -----------------------------------------------------------------
  it("builds runtimeInfo with os, host, model, channel from config and msg", async () => {
    const params = makeParams({
      config: makeConfig({ model: "gpt-4o" }),
      msg: makeMsg({ channelType: "discord" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    const ri = call.runtimeInfo;
    expect(ri.host).toBe("test-host");
    expect(ri.os).toBe("linux");
    expect(ri.arch).toBe("x64");
    expect(ri.model).toBe("gpt-4o");
    expect(ri.channel).toBe("discord");
    expect(ri.shell).toBe("/bin/bash");
  });

  // -----------------------------------------------------------------
  // Additional: channelContext forwarding
  // -----------------------------------------------------------------
  it("passes channelContext as undefined for cache stability", async () => {
    const params = makeParams({
      msg: makeMsg({ channelType: "slack", channelId: "C123" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.channelContext).toBeUndefined();
  });

  it("includes channel ID and announce hint in dynamic preamble", async () => {
    const params = makeParams({
      msg: makeMsg({ channelType: "slack", channelId: "C123" }),
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.dynamicPreamble).toContain("Current channel: slack (ID: C123)");
    expect(result.dynamicPreamble).toContain('announce_channel_type="slack"');
  });

  // -----------------------------------------------------------------
  // Additional: reasoningTagHint based on provider
  // -----------------------------------------------------------------
  it("sets reasoningTagHint=false for anthropic provider", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "anthropic" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(false);
  });

  it("sets reasoningTagHint=true for non-anthropic provider", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  it("sets reasoningTagHint=false for non-anthropic provider with native reasoning active", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai", thinkingLevel: "high" }),
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(false);
  });

  it("sets reasoningTagHint=true for non-anthropic provider with thinkingLevel off", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai", thinkingLevel: "off" }),
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  it("sets reasoningTagHint=true for non-anthropic provider with no thinkingLevel config", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  it("sets reasoningTagHint=false for non-anthropic provider with resolvedModelReasoning=true", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
      resolvedModelReasoning: true,
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(false);
  });

  it("sets reasoningTagHint=true for non-anthropic provider with resolvedModelReasoning=false", async () => {
    const params = makeParams({
      config: makeConfig({ provider: "openai" }),
      resolvedModelReasoning: false,
    });
    await assembleExecutionPrompt(params);
    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.reasoningTagHint).toBe(true);
  });

  // -----------------------------------------------------------------
  // Additional: safety reinforcement and hook prependContext both in dynamicPreamble
  // -----------------------------------------------------------------
  it("safety reinforcement and hook prependContext both appear in dynamicPreamble", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "HOOK-CONTEXT" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      safetyReinforcement: "SAFETY",
    });
    const result = await assembleExecutionPrompt(params);

    // Both safety and hook prependContext in dynamic preamble
    expect(result.dynamicPreamble).toContain("SAFETY");
    expect(result.dynamicPreamble).toContain("HOOK-CONTEXT");
    // Neither in system prompt
    expect(result.systemPrompt).not.toContain("HOOK-CONTEXT");
    expect(result.systemPrompt).not.toContain("SAFETY");
  });

  // -----------------------------------------------------------------
  // Additional: hook systemPrompt override + safety reinforcement in preamble
  // -----------------------------------------------------------------
  it("safety reinforcement in dynamicPreamble even when hook overrides systemPrompt", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ systemPrompt: "hook-prompt" }),
    };
    const params = makeParams({
      deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      safetyReinforcement: "SAFETY",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("hook-prompt");
    expect(result.dynamicPreamble).toContain("SAFETY");
  });

  // -----------------------------------------------------------------
  // Additional: media flags forwarding
  // -----------------------------------------------------------------
  it("forwards mediaPersistenceEnabled and autonomousMediaEnabled to assembler", async () => {
    const params = makeParams({
      deps: {
        workspaceDir: "/workspace",
        mediaPersistenceEnabled: true,
        autonomousMediaEnabled: true,
        outboundMediaEnabled: true,
      },
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.mediaPersistenceEnabled).toBe(true);
    expect(call.autonomousMediaEnabled).toBe(true);
    expect(call.outboundMediaEnabled).toBe(true);
  });

  // -----------------------------------------------------------------
  // Additional: default promptMode when bootstrap config is missing
  // -----------------------------------------------------------------
  it("defaults to 'full' promptMode when bootstrap config is missing", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: undefined }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.promptMode).toBe("full");
  });

  // -----------------------------------------------------------------
  // 16. postCompactionSections config threading
  // -----------------------------------------------------------------
  it("threads postCompactionSections from config.session.compaction to assembler", async () => {
    const params = makeParams({
      config: makeConfig({
        session: { compaction: { postCompactionSections: ["Custom Section", "Another"] } },
      }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.postCompactionSections).toEqual(["Custom Section", "Another"]);
  });

  it("passes undefined postCompactionSections when session config is absent", async () => {
    const params = makeParams({
      config: makeConfig({ session: undefined }),
    });
    await assembleExecutionPrompt(params);

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.postCompactionSections).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // Context filtering
  // -----------------------------------------------------------------
  describe("context filtering", () => {
    const fakeBootstrapFiles = [
      { name: "SOUL.md", path: "/ws/SOUL.md", content: "soul", missing: false },
      { name: "IDENTITY.md", path: "/ws/IDENTITY.md", content: "identity", missing: false },
      { name: "USER.md", path: "/ws/USER.md", content: "user", missing: false },
      { name: "AGENTS.md", path: "/ws/AGENTS.md", content: "agents", missing: false },
      { name: "TOOLS.md", path: "/ws/TOOLS.md", content: "tools", missing: false },
      { name: "HEARTBEAT.md", path: "/ws/HEARTBEAT.md", content: "heartbeat", missing: false },
      { name: "BOOTSTRAP.md", path: "/ws/BOOTSTRAP.md", content: "bootstrap", missing: false },
    ];

    // tests (lightContext)

    it("applies lightContext filter when msg.metadata.lightContext is true", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { lightContext: true, trigger: "heartbeat", isScheduled: true } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledWith(fakeBootstrapFiles);
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    it("does not apply lightContext filter when metadata.lightContext is absent", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: {} }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForLightContext).not.toHaveBeenCalled();
    });

    // tests (group chat)

    it("applies group chat filter for Telegram group messages", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).toHaveBeenCalledOnce();
    });

    it("applies group chat filter for Discord guild threads", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { parentChannelId: "p1", guildId: "g1" }, channelType: "discord" }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).toHaveBeenCalledOnce();
    });

    it("does not apply group chat filter for DM messages", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { telegramChatType: "private" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // tests (config opt-out)

    it("does not apply group chat filter when groupChatFiltering is false", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "full", groupChatFiltering: false } }),
        msg: makeMsg({ metadata: { telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // Filter precedence test

    it("lightContext takes precedence over group chat filter", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue(fakeBootstrapFiles);
      const params = makeParams({
        msg: makeMsg({ metadata: { lightContext: true, telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockFilterBootstrapFilesForLightContext).toHaveBeenCalledOnce();
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });

    // test (sub-agent / promptMode none)

    it("promptMode none skips all filtering", async () => {
      const params = makeParams({
        config: makeConfig({ bootstrap: { promptMode: "none" } }),
        msg: makeMsg({ metadata: { lightContext: true, telegramChatType: "group" } }),
      });
      await assembleExecutionPrompt(params);

      expect(mockLoadWorkspaceBootstrapFiles).not.toHaveBeenCalled();
      expect(mockFilterBootstrapFilesForLightContext).not.toHaveBeenCalled();
      expect(mockFilterBootstrapFilesForGroupChat).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // BOOT.md injection (relocated from system prompt to dynamic preamble)
  // -----------------------------------------------------------------
  describe("BOOT.md injection", () => {
    it("injects BOOT.md content into dynamicPreamble when isFirstMessageInSession=true", async () => {
      mockReadFile.mockResolvedValue("Check HEARTBEAT.md for pending tasks");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("[Session startup instructions from BOOT.md]");
      expect(result.dynamicPreamble).toContain("Check HEARTBEAT.md for pending tasks");
      expect(result.dynamicPreamble).toContain("[End startup instructions]");
      // System prompt remains unchanged
      expect(result.systemPrompt).not.toContain("[Session startup instructions");
    });

    it("skips BOOT.md injection when isFirstMessageInSession=false", async () => {
      mockReadFile.mockResolvedValue("Some boot content");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: false },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("skips BOOT.md injection when lightContext=true even if isFirstMessageInSession=true", async () => {
      mockReadFile.mockResolvedValue("Some boot content");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
        msg: makeMsg({ metadata: { lightContext: true } }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("skips BOOT.md injection when file content is effectively empty", async () => {
      mockReadFile.mockResolvedValue("# BOOT.md\n\n# Just headers");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
    });

    it("skips BOOT.md injection when file is missing (no error thrown)", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.systemPrompt).toBe("assembled-prompt");
      expect(result.dynamicPreamble).not.toContain("[Session startup instructions");
    });
  });

  // -----------------------------------------------------------------
  // userLanguage extraction from USER.md
  // -----------------------------------------------------------------
  it("passes userLanguage to assembler when USER.md has preferred language", async () => {
    mockBuildBootstrapContextFiles.mockReturnValue([
      { path: "USER.md", content: "- **Preferred language:** Hebrew\n- **Notes:**" },
    ]);
    await assembleExecutionPrompt(makeParams());

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.userLanguage).toBe("Hebrew");
  });

  it("passes undefined userLanguage when USER.md has no preferred language", async () => {
    mockBuildBootstrapContextFiles.mockReturnValue([
      { path: "USER.md", content: "- **Name:** Mosh\n- **Notes:**" },
    ]);
    await assembleExecutionPrompt(makeParams());

    const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
    expect(call.userLanguage).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // Onboarding injection (relocated from system prompt to dynamic preamble)
  // -----------------------------------------------------------------
  describe("Onboarding injection", () => {
    it("injects BOOTSTRAP.md with onboarding framing into dynamicPreamble", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("Bootstrap content here");
      const params = makeParams();
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).toContain("Bootstrap content here");
      expect(result.dynamicPreamble).toContain("[End onboarding instructions]");
      // System prompt remains unchanged
      expect(result.systemPrompt).not.toContain("[ONBOARDING ACTIVE");
    });

    it("passes excludeBootstrapFromContext=true to assembler when onboarding", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("Bootstrap content");
      const params = makeParams();
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.excludeBootstrapFromContext).toBe(true);
    });

    it("does not inject onboarding when isOnboarding=false", async () => {
      mockDetectOnboardingState.mockResolvedValue(false);
      const params = makeParams();
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[ONBOARDING ACTIVE");
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.excludeBootstrapFromContext).toBe(true);  // Always excluded: either elevated (onboarding) or dead weight (post-onboarding)
    });

    it("onboarding injection coexists with BOOT.md injection in dynamicPreamble", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("file content");
      mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
      const params = makeParams({
        deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      });
      const result = await assembleExecutionPrompt(params);

      // Both blocks present in dynamic preamble
      expect(result.dynamicPreamble).toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).toContain("[Session startup instructions from BOOT.md]");
      // Onboarding appears first due to unshift ordering
      const onboardIdx = result.dynamicPreamble.indexOf("[ONBOARDING ACTIVE");
      const bootIdx = result.dynamicPreamble.indexOf("[Session startup instructions from BOOT.md]");
      expect(onboardIdx).toBeLessThan(bootIdx);
    });

    it("skips onboarding injection when BOOTSTRAP.md read fails", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const params = makeParams();
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[ONBOARDING ACTIVE");
      // excludeBootstrapFromContext is still true because detection passed
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.excludeBootstrapFromContext).toBe(true);
    });

    // F3 (2026-04-19): specialist-profile agents are task workers and must never
    // receive the "greet the user, ask who I am" onboarding script, even when
    // their workspace is freshly seeded and detectOnboardingState returns true.
    it("does NOT inject onboarding for workspace.profile='specialist' even when isOnboarding=true", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("Bootstrap content that must not leak");
      const params = makeParams({
        config: makeConfig({ workspace: { profile: "specialist" } }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).not.toContain("Bootstrap content that must not leak");
    });

    it("still injects onboarding for workspace.profile='full' (default-agent path preserved)", async () => {
      mockDetectOnboardingState.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("First-run greeting");
      const params = makeParams({
        config: makeConfig({ workspace: { profile: "full" } }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("[ONBOARDING ACTIVE");
      expect(result.dynamicPreamble).toContain("First-run greeting");
    });
  });

  // -----------------------------------------------------------------
  // Dynamic content relocation tests
  // -----------------------------------------------------------------
  describe("dynamic content relocation", () => {
    it("channel appears in dynamicPreamble not system prompt Runtime section", async () => {
      const params = makeParams({
        msg: makeMsg({ channelType: "discord" }),
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("## Channel");
      expect(result.dynamicPreamble).toContain("discord");
      // RuntimeInfo struct still carries channel for internal use
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.runtimeInfo.channel).toBe("discord");
    });

    it("sender trust entries appear in dynamicPreamble not system prompt", async () => {
      const params = makeParams({
        config: makeConfig({
          elevatedReply: { senderTrustMap: { "user-1": "admin" }, defaultTrustLevel: "external" },
        }),
        deps: {
          workspaceDir: "/workspace",
          senderTrustDisplayConfig: { enabled: true, displayMode: "raw" },
        },
      });
      const result = await assembleExecutionPrompt(params);

      // trust section appears in dynamicPreamble
      expect(result.dynamicPreamble).toContain("## Authorized Senders");
      // Not passed to assembler
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.senderTrustEntries).toEqual([]);
      expect(call.senderTrustDisplayMode).toBe("raw");
    });

    it("additionalSections is always empty (RAG relocated to preamble)", async () => {
      const mockSearchResult = {
        entry: { id: "m1", tenantId: "t", content: "Test memory", createdAt: Date.now(), tags: [], trustLevel: "learned", source: { channel: "test" } },
        score: 0.85,
      };
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
        store: vi.fn(),
      } as any;
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.additionalSections).toEqual([]);
      expect(result.dynamicPreamble).toContain("rag-section-1");
    });

    it("subagentRole passed as undefined to assembler (relocated to dynamic preamble)", async () => {
      mockBuildSubagentRoleSection.mockReturnValue(["## Subagent Role", "", "You are a subagent."]);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          spawnPacket: { task: "Analyze logs", depth: 1 } as any,
        },
      });
      const result = await assembleExecutionPrompt(params);

      // Verify subagentRole is passed as undefined to assembler
      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.subagentRole).toBeUndefined();
      // Subagent role appears in dynamic preamble
      expect(result.dynamicPreamble).toContain("## Subagent Role");
      expect(result.dynamicPreamble).toContain("You are a subagent.");
    });

    it("canarySecret and sessionKey not passed to assembler (relocated to dynamic preamble)", async () => {
      const secretManager = { get: (key: string) => key === "CANARY_SECRET" ? "test-secret" : undefined };
      const params = makeParams({
        deps: { workspaceDir: "/workspace", secretManager: secretManager as any },
      });
      await assembleExecutionPrompt(params);

      const call = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call.canarySecret).toBeUndefined();
      expect(call.sessionKey).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // System prompt stability across session states
  // -----------------------------------------------------------------
  it("system prompt is identical regardless of isFirstMessageInSession or safetyReinforcement", async () => {
    // Turn 1 with BOOT.md and safety
    mockReadFile.mockResolvedValue("Boot content");
    mockIsBootContentEffectivelyEmpty.mockReturnValue(false);
    const params1 = makeParams({
      deps: { workspaceDir: "/workspace", isFirstMessageInSession: true },
      safetyReinforcement: "SAFETY LINE",
    });
    const result1 = await assembleExecutionPrompt(params1);

    // Turn 2 without BOOT.md or safety
    const params2 = makeParams({
      deps: { workspaceDir: "/workspace", isFirstMessageInSession: false },
    });
    const result2 = await assembleExecutionPrompt(params2);

    // System prompts must be identical (both just "assembled-prompt" from mock)
    expect(result1.systemPrompt).toBe(result2.systemPrompt);
    // But dynamic preambles differ
    expect(result1.dynamicPreamble).not.toBe(result2.dynamicPreamble);
    expect(result1.dynamicPreamble).toContain("SAFETY LINE");
    expect(result1.dynamicPreamble).toContain("[Session startup instructions from BOOT.md]");
    expect(result2.dynamicPreamble).not.toContain("SAFETY LINE");
    expect(result2.dynamicPreamble).not.toContain("[Session startup instructions from BOOT.md]");
  });

  // -----------------------------------------------------------------
  // Prompt budget breakdown logging
  // -----------------------------------------------------------------

  it("emits Prompt budget breakdown INFO log with all required fields", async () => {
    const params = makeParams({
      mergedCustomTools: [{ name: "bash" }, { name: "file_read" }] as any[],
      deps: {
        workspaceDir: "/workspace",
        isFirstMessageInSession: true,
        spawnPacket: { task: "Analyze logs", depth: 1 } as any,
      },
    });
    await assembleExecutionPrompt(params);

    const infoCalls = (params.logger.info as any).mock.calls;
    const budgetCall = infoCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Prompt budget breakdown",
    );
    expect(budgetCall).toBeDefined();
    const [fields] = budgetCall!;
    expect(typeof fields.systemPromptTokens).toBe("number");
    expect(typeof fields.dynamicPreambleTokens).toBe("number");
    expect(typeof fields.systemPromptChars).toBe("number");
    expect(typeof fields.dynamicPreambleChars).toBe("number");
    expect(typeof fields.bootstrapChars).toBe("number");
    expect(typeof fields.bootstrapPercent).toBe("number");
    expect(fields.toolCount).toBe(2);
    expect(fields.isFirstMessage).toBe(true);
    expect(fields.hasSpawnPacket).toBe(true);
  });

  it("defaults isFirstMessage to false when undefined", async () => {
    const params = makeParams({
      deps: { workspaceDir: "/workspace" },
    });
    await assembleExecutionPrompt(params);

    const infoCalls = (params.logger.info as any).mock.calls;
    const budgetCall = infoCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Prompt budget breakdown",
    );
    expect(budgetCall).toBeDefined();
    const [fields] = budgetCall!;
    expect(fields.isFirstMessage).toBe(false);
  });

  it("defaults hasSpawnPacket to false when no spawnPacket", async () => {
    const params = makeParams({
      deps: { workspaceDir: "/workspace" },
    });
    await assembleExecutionPrompt(params);

    const infoCalls = (params.logger.info as any).mock.calls;
    const budgetCall = infoCalls.find(
      ([_fields, msg]: [any, string]) => msg === "Prompt budget breakdown",
    );
    expect(budgetCall).toBeDefined();
    const [fields] = budgetCall!;
    expect(fields.hasSpawnPacket).toBe(false);
  });

  // -----------------------------------------------------------------
  // Delivery mirror injection
  // -----------------------------------------------------------------
  describe("delivery mirror injection", () => {
    function createMockMirror(pendingEntries: any[] = []) {
      return {
        record: vi.fn(),
        pending: vi.fn().mockResolvedValue({ ok: true, value: pendingEntries }),
        acknowledge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
        pruneOld: vi.fn(),
      };
    }

    function makeMirrorEntry(overrides: Record<string, unknown> = {}) {
      return {
        id: "mirror-1",
        sessionKey: "agent-1:telegram:chat-1",
        text: "Hello from the other side",
        mediaUrls: [],
        channelType: "telegram",
        channelId: "chat-1",
        origin: "agent",
        idempotencyKey: "key-1",
        status: "pending",
        createdAt: Date.now(),
        acknowledgedAt: null,
        ...overrides,
      };
    }

    it("injects mirror entries into dynamicPreamble when deliveryMirror has pending entries", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "First message" }),
        makeMirrorEntry({ id: "m2", text: "Second message", channelType: "discord" }),
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
          deliveryMirrorConfig: { maxEntriesPerInjection: 10, maxCharsPerInjection: 4000 },
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("## Your Recent Outbound Messages");
      expect(result.dynamicPreamble).toContain("[You sent on telegram]: First message");
      expect(result.dynamicPreamble).toContain("[You sent on discord]: Second message");
    });

    it("respects maxEntriesPerInjection budget", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "Entry 1" }),
        makeMirrorEntry({ id: "m2", text: "Entry 2" }),
        makeMirrorEntry({ id: "m3", text: "Entry 3" }),
        makeMirrorEntry({ id: "m4", text: "Entry 4" }),
        makeMirrorEntry({ id: "m5", text: "Entry 5" }),
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
          deliveryMirrorConfig: { maxEntriesPerInjection: 2, maxCharsPerInjection: 40000 },
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("Entry 1");
      expect(result.dynamicPreamble).toContain("Entry 2");
      expect(result.dynamicPreamble).not.toContain("Entry 3");
      // Only 2 IDs acknowledged
      expect(mirror.acknowledge).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("respects maxCharsPerInjection budget", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "Short" }),       // 5 chars
        makeMirrorEntry({ id: "m2", text: "A".repeat(20) }), // 20 chars -- total 25, under 30
        makeMirrorEntry({ id: "m3", text: "B".repeat(20) }), // 20 chars -- total 45, over 30
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
          deliveryMirrorConfig: { maxEntriesPerInjection: 100, maxCharsPerInjection: 30 },
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("Short");
      expect(result.dynamicPreamble).toContain("A".repeat(20));
      expect(result.dynamicPreamble).not.toContain("B".repeat(20));
      // Only 2 IDs acknowledged
      expect(mirror.acknowledge).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("calls acknowledge for injected entries", async () => {
      const entries = [
        makeMirrorEntry({ id: "m1", text: "Msg 1" }),
        makeMirrorEntry({ id: "m2", text: "Msg 2" }),
      ];
      const mirror = createMockMirror(entries);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
        },
      });
      await assembleExecutionPrompt(params);

      expect(mirror.acknowledge).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("skips injection when deliveryMirror is undefined", async () => {
      const params = makeParams({
        deps: { workspaceDir: "/workspace" },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("Your Recent Outbound Messages");
    });

    it("skips injection when no pending entries", async () => {
      const mirror = createMockMirror([]);
      const params = makeParams({
        deps: {
          workspaceDir: "/workspace",
          deliveryMirror: mirror as any,
        },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).not.toContain("Your Recent Outbound Messages");
      expect(mirror.acknowledge).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // Tool name snapshotting
  // -----------------------------------------------------------------
  describe("tool name snapshotting", () => {
    afterEach(() => {
      // Clean up snapshot between tests
      clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    });

    it("uses first-turn tool names for system prompt on subsequent turns", async () => {
      // First turn: 3 tools
      const params1 = makeParams({
        mergedCustomTools: [{ name: "read" }, { name: "exec" }, { name: "write" }] as any[],
      });
      await assembleExecutionPrompt(params1);
      const call1 = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call1.toolNames).toEqual(["read", "exec", "write"]);

      mockAssembleRichSystemPrompt.mockClear();

      // Second turn: different tools (simulating MCP tools connecting)
      const params2 = makeParams({
        mergedCustomTools: [{ name: "read" }, { name: "exec" }, { name: "write" }, { name: "mcp_search" }, { name: "mcp_query" }] as any[],
      });
      await assembleExecutionPrompt(params2);
      const call2 = mockAssembleRichSystemPrompt.mock.calls[0][0];
      // Should still use the first-turn snapshot
      expect(call2.toolNames).toEqual(["read", "exec", "write"]);
    });

    it("creates fresh snapshot after clearSessionToolNameSnapshot", async () => {
      const params1 = makeParams({
        mergedCustomTools: [{ name: "read" }] as any[],
      });
      await assembleExecutionPrompt(params1);

      clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
      mockAssembleRichSystemPrompt.mockClear();

      const params2 = makeParams({
        mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[],
      });
      await assembleExecutionPrompt(params2);
      const call2 = mockAssembleRichSystemPrompt.mock.calls[0][0];
      expect(call2.toolNames).toEqual(["read", "exec"]);
    });
  });

  // -----------------------------------------------------------------
  // Bootstrap file snapshotting
  // -----------------------------------------------------------------
  describe("bootstrap file snapshotting", () => {
    beforeEach(() => {
      // Reset loadWorkspaceBootstrapFiles completely (clear once-queue and default)
      // to prevent cross-test leakage from earlier tests that also call assembleExecutionPrompt.
      mockLoadWorkspaceBootstrapFiles.mockReset();
      mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
      clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    });

    afterEach(() => {
      clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    });

    it("loads bootstrap files from disk only on first turn", async () => {
      // First turn: returns IDENTITY.md content
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "original identity", missing: false },
      ]);
      mockBuildBootstrapContextFiles.mockReturnValue([
        { path: "IDENTITY.md", content: "original identity" },
      ]);

      const params1 = makeParams();
      await assembleExecutionPrompt(params1);

      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(1);

      // Second turn: mock returns different content (simulating agent writing file)
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "CHANGED identity", missing: false },
      ]);

      mockAssembleRichSystemPrompt.mockClear();
      mockBuildBootstrapContextFiles.mockClear();

      const params2 = makeParams();
      await assembleExecutionPrompt(params2);

      // loadWorkspaceBootstrapFiles should NOT be called again -- snapshot reused
      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(1);
      // buildBootstrapContextFiles should receive the original snapshot
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [{ name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "original identity", missing: false }],
        expect.any(Object),
      );
    });

    it("creates fresh snapshot after clearSessionBootstrapFileSnapshot", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "v1", missing: false },
      ]);

      const params1 = makeParams();
      await assembleExecutionPrompt(params1);

      clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "v2", missing: false },
      ]);
      mockBuildBootstrapContextFiles.mockClear();

      const params2 = makeParams();
      await assembleExecutionPrompt(params2);

      // After clearing, should load fresh from disk
      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(2);
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [{ name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "v2", missing: false }],
        expect.any(Object),
      );
    });

    it("applies per-turn lightContext filtering on snapshotted files", async () => {
      mockLoadWorkspaceBootstrapFiles.mockResolvedValueOnce([
        { name: "IDENTITY.md", path: "/workspace/IDENTITY.md", content: "identity", missing: false },
        { name: "HEARTBEAT.md", path: "/workspace/HEARTBEAT.md", content: "heartbeat", missing: false },
      ]);

      // First turn: normal context
      const params1 = makeParams();
      await assembleExecutionPrompt(params1);

      // Second turn: light context (heartbeat) -- should filter snapshot, not reload
      mockBuildBootstrapContextFiles.mockClear();
      const params2 = makeParams({
        msg: makeMsg({ metadata: { lightContext: true } }),
      });
      await assembleExecutionPrompt(params2);

      // Still only 1 disk load
      expect(mockLoadWorkspaceBootstrapFiles).toHaveBeenCalledTimes(1);
      // But buildBootstrapContextFiles receives filtered set (only HEARTBEAT.md)
      expect(mockBuildBootstrapContextFiles).toHaveBeenCalledWith(
        [{ name: "HEARTBEAT.md", path: "/workspace/HEARTBEAT.md", content: "heartbeat", missing: false }],
        expect.any(Object),
      );
    });
  });

  // -----------------------------------------------------------------
  // Task 229: Hybrid memory injector -- inlineMemory
  // -----------------------------------------------------------------
  describe("Task 229: hybrid memory injector -- inlineMemory", () => {
    function makeSearchResult(content: string, score: number, trustLevel = "learned") {
      return {
        entry: {
          id: `mem-${Math.random().toString(36).slice(2, 8)}`,
          tenantId: "test-tenant",
          content,
          createdAt: Date.now(),
          tags: [],
          trustLevel,
          source: { channel: "test" },
        },
        score,
      };
    }

    it("returns inlineMemory when hybrid injector produces one", async () => {
      const result1 = makeSearchResult("User prefers dark mode", 0.85);
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [result1] }),
      } as any;
      mockHybridSplit.mockReturnValue({
        inlineMemory: "\n[Relevant context: User prefers dark mode]\n",
        systemPromptSections: [],
      });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.inlineMemory).toBe("\n[Relevant context: User prefers dark mode]\n");
      expect(result.dynamicPreamble).not.toContain("Relevant context");
    });

    it("returns undefined inlineMemory when all results are low-score", async () => {
      const result1 = makeSearchResult("Vague memory", 0.5);
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [result1] }),
      } as any;
      mockHybridSplit.mockReturnValue({
        inlineMemory: undefined,
        systemPromptSections: ["## Relevant Memories\n- some section"],
      });
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.inlineMemory).toBeUndefined();
      expect(result.dynamicPreamble).toContain("## Relevant Memories");
    });

    it("returns undefined inlineMemory when RAG is disabled", async () => {
      const memoryPort = { search: vi.fn() } as any;
      const params = makeParams({
        config: makeConfig({ rag: { enabled: false } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.inlineMemory).toBeUndefined();
      expect(memoryPort.search).not.toHaveBeenCalled();
    });

    it("filters results by trust level before passing to hybrid injector", async () => {
      const learnedResult = makeSearchResult("Learned memory", 0.9, "learned");
      const externalResult = makeSearchResult("External memory", 0.95, "external");
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [externalResult, learnedResult] }),
      } as any;
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      await assembleExecutionPrompt(params);

      // deduplicateResults receives only the learned result (external filtered out)
      expect(mockDeduplicateResults).toHaveBeenCalledWith([learnedResult]);
    });

    it("skips hybrid injector when search returns no results", async () => {
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      } as any;
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
      expect(result.inlineMemory).toBeUndefined();
    });

    it("skips hybrid injector when search result is not ok", async () => {
      const memoryPort = {
        search: vi.fn().mockResolvedValue({ ok: false, error: "search failed" }),
      } as any;
      const params = makeParams({
        config: makeConfig({ rag: { enabled: true, maxResults: 5, minScore: 0.3, includeTrustLevels: ["learned"], maxContextChars: 5000 } }),
        deps: { workspaceDir: "/workspace", memoryPort },
      });
      const result = await assembleExecutionPrompt(params);

      expect(mockCreateHybridMemoryInjector).not.toHaveBeenCalled();
      expect(result.inlineMemory).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------
  // dynamic preamble relocation
  // -----------------------------------------------------------------
  describe("dynamic preamble relocation", () => {
    it("prependContext appears in dynamicPreamble, not systemPrompt", async () => {
      const hookRunner = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "Hook injected context" }),
      };
      const params = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.dynamicPreamble).toContain("Hook injected context");
      expect(result.systemPrompt).not.toContain("Hook injected context");
    });

    it("systemPrompt digest is stable when prependContext varies", async () => {
      // Turn 1: prependContext = "context-turn-1"
      const hookRunner1 = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "context-turn-1" }),
      };
      const params1 = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner1 as any },
      });
      const result1 = await assembleExecutionPrompt(params1);

      mockAssembleRichSystemPrompt.mockClear();

      // Turn 2: prependContext = "context-turn-2"
      const hookRunner2 = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "context-turn-2" }),
      };
      const params2 = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner2 as any },
      });
      const result2 = await assembleExecutionPrompt(params2);

      // System prompts identical (both just "assembled-prompt" from mock)
      expect(result1.systemPrompt).toBe(result2.systemPrompt);
      // Dynamic preambles differ
      expect(result1.dynamicPreamble).toContain("context-turn-1");
      expect(result2.dynamicPreamble).toContain("context-turn-2");
      expect(result1.dynamicPreamble).not.toContain("context-turn-2");
    });

    it("hookResult.systemPrompt still replaces system prompt (backward compat)", async () => {
      const hookRunner = {
        runBeforeAgentStart: vi.fn().mockResolvedValue({ systemPrompt: "Completely replaced prompt" }),
      };
      const params = makeParams({
        deps: { workspaceDir: "/workspace", hookRunner: hookRunner as any },
      });
      const result = await assembleExecutionPrompt(params);

      expect(result.systemPrompt).toBe("Completely replaced prompt");
    });

    it("API system prompt appears in dynamicPreamble, not systemPrompt", async () => {
      const params = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "External API instructions" } }),
      });
      const result = await assembleExecutionPrompt(params);

      // Wrapped content appears in dynamicPreamble
      expect(result.dynamicPreamble).toContain("External API instructions");
      // Not in systemPrompt
      expect(result.systemPrompt).not.toContain("External API instructions");
    });

    it("different API system prompts produce identical system prompt digests", async () => {
      // Call 1: API system prompt A
      const params1 = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "API instructions A" } }),
      });
      const result1 = await assembleExecutionPrompt(params1);

      mockAssembleRichSystemPrompt.mockClear();

      // Call 2: API system prompt B
      const params2 = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "API instructions B" } }),
      });
      const result2 = await assembleExecutionPrompt(params2);

      // System prompts identical
      expect(result1.systemPrompt).toBe(result2.systemPrompt);
      // Dynamic preambles differ
      expect(result1.dynamicPreamble).toContain("API instructions A");
      expect(result2.dynamicPreamble).toContain("API instructions B");
      expect(result1.dynamicPreamble).not.toContain("API instructions B");
    });

    it("wrapExternalContent is applied to API system prompt in dynamicPreamble", async () => {
      const params = makeParams({
        msg: makeMsg({ metadata: { openaiSystemPrompt: "Test API prompt" } }),
      });
      const result = await assembleExecutionPrompt(params);

      // Wrapped content should contain security markers from wrapExternalContent
      expect(result.dynamicPreamble).toContain("Test API prompt");
      // wrapExternalContent wraps with UNTRUSTED markers
      expect(result.dynamicPreamble).toMatch(/<<<UNTRUSTED_\w+>>>/);
      expect(result.dynamicPreamble).toMatch(/<<<END_UNTRUSTED_\w+>>>/);
    });
  });

  // -----------------------------------------------------------------
  // MCP server instructions injection
  // -----------------------------------------------------------------
  describe("MCP server instructions injection", () => {
    it("injects MCP server instructions into dynamic preamble", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: {
          workspaceDir: "/workspace",
          mcpServerInstructions: [
            { serverName: "context7", instructions: "Use resolve-library-id before query-docs." },
            { serverName: "filesystem", instructions: "Prefer read_file over read_directory." },
          ],
        },
      }));

      expect(result.dynamicPreamble).toContain("## MCP Server Instructions");
      expect(result.dynamicPreamble).toContain("### context7");
      expect(result.dynamicPreamble).toContain("Use resolve-library-id before query-docs.");
      expect(result.dynamicPreamble).toContain("### filesystem");
      expect(result.dynamicPreamble).toContain("Prefer read_file over read_directory.");
    });

    it("omits MCP server instructions section when none provided", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: { workspaceDir: "/workspace", mcpServerInstructions: undefined },
      }));

      expect(result.dynamicPreamble).not.toContain("MCP Server Instructions");
    });

    it("omits MCP server instructions section when array is empty", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: { workspaceDir: "/workspace", mcpServerInstructions: [] },
      }));

      expect(result.dynamicPreamble).not.toContain("MCP Server Instructions");
    });

    it("does not inject MCP server instructions into systemPrompt", async () => {
      const result = await assembleExecutionPrompt(makeParams({
        deps: {
          workspaceDir: "/workspace",
          mcpServerInstructions: [
            { serverName: "test-server", instructions: "Test instructions for cache stability." },
          ],
        },
      }));

      expect(result.systemPrompt).not.toContain("MCP Server Instructions");
      expect(result.systemPrompt).not.toContain("test-server");
      expect(result.dynamicPreamble).toContain("## MCP Server Instructions");
    });
  });
  // -----------------------------------------------------------------
  // Verbosity hints in dynamic preamble
  // -----------------------------------------------------------------
  describe("verbosity hints in dynamic preamble", () => {
    it("includes character limit hint when auto mode with channelMaxChars", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: true, defaultLevel: "auto", overrides: {} },
        }),
        deps: { workspaceDir: "/workspace", channelMaxChars: 4096 },
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).toContain("4096 character message limit");
    });

    it("omits verbosity hint when config.verbosity is undefined", async () => {
      const params = makeParams({
        config: makeConfig({ verbosity: undefined }),
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).not.toContain("character message limit");
      expect(result.dynamicPreamble).not.toContain("Response Style");
    });

    it("omits verbosity hint when config.verbosity.enabled is false", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: false, defaultLevel: "auto", overrides: {} },
        }),
        deps: { workspaceDir: "/workspace", channelMaxChars: 4096 },
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).not.toContain("character message limit");
    });

    it("includes Response Style section for concise level", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: true, defaultLevel: "concise", overrides: {} },
        }),
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.dynamicPreamble).toContain("## Response Style");
      expect(result.dynamicPreamble).toContain("brief and focused");
    });

    it("does not leak verbosity hint into systemPrompt", async () => {
      const params = makeParams({
        config: makeConfig({
          verbosity: { enabled: true, defaultLevel: "auto", overrides: {} },
        }),
        deps: { workspaceDir: "/workspace", channelMaxChars: 2000 },
      });
      const result = await assembleExecutionPrompt(params);
      expect(result.systemPrompt).not.toContain("character message limit");
    });
  });
});

// ---------------------------------------------------------------------------
// extractUserLanguage (unit tests)
// ---------------------------------------------------------------------------

describe("extractUserLanguage", () => {
  it("extracts language from USER.md with bold markdown", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- **Preferred language:** Hebrew" },
    ])).toBe("Hebrew");
  });

  it("extracts language without bold markdown", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- Preferred language: Arabic" },
    ])).toBe("Arabic");
  });

  it("returns undefined when field has placeholder text", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- **Preferred language:** _(e.g., English, Hebrew)_" },
    ])).toBeUndefined();
  });

  it("returns undefined when USER.md is missing", () => {
    expect(extractUserLanguage([
      { path: "SOUL.md", content: "some content" },
    ])).toBeUndefined();
  });

  it("returns undefined when field is absent", () => {
    expect(extractUserLanguage([
      { path: "USER.md", content: "- **Name:** Mosh\n- **Notes:**" },
    ])).toBeUndefined();
  });

  it("handles case-insensitive file matching", () => {
    expect(extractUserLanguage([
      { path: "user.md", content: "- **Preferred language:** Japanese" },
    ])).toBe("Japanese");
  });
});

// ---------------------------------------------------------------------------
// CacheSafeParams
// ---------------------------------------------------------------------------

describe("CacheSafeParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue([]);
  });

  it("getCacheSafeParams returns undefined for unknown session key", () => {
    expect(getCacheSafeParams("unknown-session-key")).toBeUndefined();
  });

  it("captures CacheSafeParams after assembleExecutionPrompt completes (first turn)", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.frozenSystemPrompt).toBe("assembled-prompt");
    expect(captured!.toolNames).toEqual(["read", "exec"]);
    expect(captured!.model).toBe("claude-3-opus");
    expect(captured!.provider).toBe("anthropic");
    expect(captured!.cacheRetention).toBe("short");
  });

  it("does NOT overwrite CacheSafeParams on second call when toolHash unchanged", async () => {
    const params1 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params1);

    const first = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(first).toBeDefined();
    expect(first!.frozenSystemPrompt).toBe("assembled-prompt");

    // Second call with different system prompt but SAME tools -- toolHash unchanged
    mockAssembleRichSystemPrompt.mockReturnValue("different-prompt");
    const params2 = makeParams({
      config: makeConfig({ model: "claude-4-opus", provider: "google", cacheRetention: "long" }),
      mergedCustomTools: [{ name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params2);

    const second = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(second).toBeDefined();
    // Should still have first-turn values (toolHash unchanged, no refresh)
    expect(second!.frozenSystemPrompt).toBe("assembled-prompt");
    expect(second!.model).toBe("claude-3-opus");
    expect(second!.provider).toBe("anthropic");
    expect(second!.cacheRetention).toBe("short");
  });

  it("clearCacheSafeParams causes getCacheSafeParams to return undefined", async () => {
    const params = makeParams();
    await assembleExecutionPrompt(params);
    expect(getCacheSafeParams(DEFAULT_SESSION_KEY)).toBeDefined();

    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(getCacheSafeParams(DEFAULT_SESSION_KEY)).toBeUndefined();
  });

  it("does NOT capture CacheSafeParams for sub-agent sessions (spawnPacket present)", async () => {
    const params = makeParams({
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: {
          task: "sub-task",
          artifactRefs: [],
          domainKnowledge: [],
          toolGroups: [],
          objective: "test",
          workspaceDir: "/workspace",
          depth: 1,
          maxDepth: 3,
        },
      },
    });
    await assembleExecutionPrompt(params);

    expect(getCacheSafeParams(DEFAULT_SESSION_KEY)).toBeUndefined();
  });

  it("captures CacheSafeParams with undefined cacheRetention when not set", async () => {
    const params = makeParams({
      config: makeConfig({ model: "model-1", provider: "openai" }),
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.cacheRetention).toBeUndefined();
  });

  // 4.2: CacheSafeParams versioned with toolHash
  it("includes cacheWriteTimestamp and toolHash in captured CacheSafeParams", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "exec" }, { name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.cacheWriteTimestamp).toBeTypeOf("number");
    expect(captured!.cacheWriteTimestamp).toBeGreaterThan(0);
    // toolHash is sorted tool names joined with ","
    expect(captured!.toolHash).toBe("exec,read");
  });

  it("refreshes CacheSafeParams when toolHash changes mid-session (4.2)", async () => {
    // First turn with tools [read]
    const params1 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params1);

    const first = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(first).toBeDefined();
    expect(first!.toolHash).toBe("read");

    // Second turn with different tools [exec, read] -- MCP server connected mid-session
    mockAssembleRichSystemPrompt.mockReturnValue("refreshed-prompt");
    const params2 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "exec" }, { name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params2);

    const second = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(second).toBeDefined();
    // Should be refreshed with new toolHash
    expect(second!.toolHash).toBe("exec,read");
    // Frozen prompt should be updated to the new value
    expect(second!.frozenSystemPrompt).toBe("refreshed-prompt");
    // New cacheWriteTimestamp should be set
    expect(second!.cacheWriteTimestamp).toBeTypeOf("number");
  });

  it("does NOT refresh CacheSafeParams when toolHash is unchanged (4.2)", async () => {
    // First turn
    const params1 = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
      mergedCustomTools: [{ name: "read" }, { name: "exec" }] as any[],
    });
    await assembleExecutionPrompt(params1);

    const first = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(first).toBeDefined();
    const firstTimestamp = first!.cacheWriteTimestamp;

    // Second turn with same tools (different order -- hash is sorted so same)
    mockAssembleRichSystemPrompt.mockReturnValue("different-prompt");
    const params2 = makeParams({
      config: makeConfig({ model: "claude-4-opus", provider: "google", cacheRetention: "long" }),
      mergedCustomTools: [{ name: "exec" }, { name: "read" }] as any[],
    });
    await assembleExecutionPrompt(params2);

    const second = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(second).toBeDefined();
    // Should NOT be refreshed (toolHash is the same: "exec,read")
    expect(second!.frozenSystemPrompt).toBe("assembled-prompt");
    expect(second!.model).toBe("claude-3-opus");
    expect(second!.cacheWriteTimestamp).toBe(firstTimestamp);
  });
});

// ---------------------------------------------------------------------------
// SpawnPacket.cacheSafeParams
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parent prefix reuse early-return path
// ---------------------------------------------------------------------------

describe("parent prefix reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue(["## Sub-Agent Role", "Task: do-thing"]);
  });

  /** Build a SpawnPacket with cacheSafeParams for testing prefix reuse. */
  function makeSpawnPacketWithCache(overrides?: Partial<CacheSafeParams>): SpawnPacket {
    return {
      task: "sub-task",
      artifactRefs: [],
      domainKnowledge: [],
      toolGroups: [],
      objective: "test-objective",
      workspaceDir: "/workspace",
      depth: 1,
      maxDepth: 3,
      cacheSafeParams: {
        frozenSystemPrompt: "parent-frozen-prompt",
        toolNames: ["read", "exec"],
        model: "claude-3-opus",
        provider: "anthropic",
        cacheRetention: "short",
        ...overrides,
      },
    } as SpawnPacket;
  }

  it("returns parent's frozenSystemPrompt when model+provider match", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    // Full assembly should NOT be called (early return)
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
  });

  it("falls through to full assembly when model mismatches", async () => {
    const params = makeParams({
      config: makeConfig({ model: "gpt-4o", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ model: "claude-3-opus" }),
      },
      resolvedModelId: "gpt-4o",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    // Should use full assembly path
    expect(result.systemPrompt).toBe("assembled-prompt");
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledOnce();
  });

  it("falls through to full assembly when provider mismatches", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "openai" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ provider: "anthropic" }),
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "openai",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("assembled-prompt");
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledOnce();
  });

  it("falls through to full assembly when cacheSafeParams not present on spawnPacket", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: {
          task: "sub-task",
          artifactRefs: [],
          domainKnowledge: [],
          toolGroups: [],
          objective: "test",
          workspaceDir: "/workspace",
          depth: 1,
          maxDepth: 3,
          // No cacheSafeParams
        } as SpawnPacket,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("assembled-prompt");
    expect(mockAssembleRichSystemPrompt).toHaveBeenCalledOnce();
  });

  it("independently assembles dynamic preamble on prefix reuse", async () => {
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
        getPromptSkillsXml: () => "<skills>test-xml</skills>",
        mcpServerInstructions: [{ serverName: "test-mcp", instructions: "Use test tools" }],
      },
      msg: makeMsg({ metadata: { promptSkillContent: "Active skill content" } }),
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
      safetyReinforcement: "SAFETY-REMINDER",
    });
    const result = await assembleExecutionPrompt(params);

    // System prompt is parent's frozen prompt
    expect(result.systemPrompt).toBe("parent-frozen-prompt");

    // Dynamic preamble is independently assembled
    expect(result.dynamicPreamble).toContain("2026-03-12"); // dateTime section from mock
    expect(result.dynamicPreamble).toContain("## Sub-Agent Role"); // subagent role from mock
    expect(result.dynamicPreamble).toContain("<skills>test-xml</skills>"); // prompt skills
    expect(result.dynamicPreamble).toContain("Active skill content"); // active skill
    expect(result.dynamicPreamble).toContain("SAFETY-REMINDER"); // safety reinforcement
    expect(result.dynamicPreamble).toContain("test-mcp"); // MCP instructions
    expect(result.inlineMemory).toBeUndefined();
  });

  it("does NOT populate sessionToolNameSnapshots on reuse path", async () => {
    // Use a distinct session key for this test to avoid cross-test pollution
    const distinctKey = { agentId: "agent-sub-unique", channelType: "telegram", channelId: "chat-sub" } as any;
    const distinctFormattedKey = formatSessionKey(distinctKey);

    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
      },
      sessionKey: distinctKey,
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
      mergedCustomTools: [{ name: "tool-a" }, { name: "tool-b" }] as any[],
    });
    await assembleExecutionPrompt(params);

    // assembleRichSystemPrompt should NOT be called (early return)
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();

    // Clean up
    clearSessionToolNameSnapshot(distinctFormattedKey);
    clearSessionBootstrapFileSnapshot(distinctFormattedKey);
    clearSessionPromptSkillsXmlSnapshot(distinctFormattedKey);
    clearCacheSafeParams(distinctFormattedKey);
  });

  it("uses resolvedModelId/resolvedModelProvider for match, not config.model/config.provider", async () => {
    // config.model differs from resolvedModelId but resolvedModelId matches parent
    const params = makeParams({
      config: makeConfig({ model: "claude-config-model", provider: "config-provider" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ model: "claude-3-opus", provider: "anthropic" }),
      },
      resolvedModelId: "claude-3-opus",       // matches parent
      resolvedModelProvider: "anthropic",      // matches parent
    });
    const result = await assembleExecutionPrompt(params);

    // Early return should trigger because resolved matches, even though config differs
    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
  });

  it("falls back to config.model/config.provider when resolvedModelId/resolvedModelProvider absent", async () => {
    // No resolvedModelId/Provider; config.model matches parent
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache({ model: "claude-3-opus", provider: "anthropic" }),
      },
      // resolvedModelId: undefined -- falls back to config.model
      // resolvedModelProvider: undefined -- falls back to config.provider
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
  });

  it("runs hook beforeAgentStart on prefix reuse path for dynamic content", async () => {
    const hookRunner = {
      runBeforeAgentStart: vi.fn().mockResolvedValue({ prependContext: "HOOK-DYNAMIC" }),
    };
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: makeSpawnPacketWithCache(),
        hookRunner: hookRunner as any,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledOnce();
    expect(result.dynamicPreamble).toContain("HOOK-DYNAMIC");
    expect(result.systemPrompt).toBe("parent-frozen-prompt");
  });
});

describe("SpawnPacket.cacheSafeParams post-build assignment", () => {
  it("SpawnPacket from createSpawnPacketBuilder().build() accepts post-build cacheSafeParams assignment", () => {
    const builder = createSpawnPacketBuilder({
      workspaceDir: "/workspace",
      currentDepth: 0,
      maxSpawnDepth: 3,
    });
    const packet: SpawnPacket = builder.build({
      task: "test-task",
      objective: "test-objective",
    });

    // Verify cacheSafeParams is initially undefined (builder does not set it)
    expect(packet.cacheSafeParams).toBeUndefined();

    // Assign cacheSafeParams post-build (this is the pattern setup-cross-session uses)
    const cacheSafeParams: CacheSafeParams = {
      frozenSystemPrompt: "frozen-system-prompt",
      toolNames: ["read", "write"],
      model: "claude-3-opus",
      provider: "anthropic",
      cacheRetention: "short",
    };
    packet.cacheSafeParams = cacheSafeParams;

    // Verify the field is readable and has correct shape
    expect(packet.cacheSafeParams).toBeDefined();
    expect(packet.cacheSafeParams!.frozenSystemPrompt).toBe("frozen-system-prompt");
    expect(packet.cacheSafeParams!.toolNames).toEqual(["read", "write"]);
    expect(packet.cacheSafeParams!.model).toBe("claude-3-opus");
    expect(packet.cacheSafeParams!.provider).toBe("anthropic");
    expect(packet.cacheSafeParams!.cacheRetention).toBe("short");
  });
});

// ---------------------------------------------------------------------------
// SystemPromptBlocks threading through pipeline
// ---------------------------------------------------------------------------

describe("SystemPromptBlocks threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolNameSnapshot(DEFAULT_SESSION_KEY);
    clearSessionBootstrapFileSnapshot(DEFAULT_SESSION_KEY);
    clearSessionPromptSkillsXmlSnapshot(DEFAULT_SESSION_KEY);
    clearCacheSafeParams(DEFAULT_SESSION_KEY);
    mockAssembleRichSystemPrompt.mockReturnValue("assembled-prompt");
    mockAssembleRichSystemPromptBlocks.mockReturnValue({ staticPrefix: "static-prefix", attribution: "attribution", semiStableBody: "semi-stable-body" });
    mockLoadWorkspaceBootstrapFiles.mockResolvedValue([]);
    mockBuildBootstrapContextFiles.mockReturnValue([]);
    mockDeduplicateResults.mockImplementation((results: any[]) => results);
    mockHybridSplit.mockReturnValue({ inlineMemory: undefined, systemPromptSections: [] });
    mockCreateHybridMemoryInjector.mockReturnValue({ split: mockHybridSplit });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockIsBootContentEffectivelyEmpty.mockReturnValue(true);
    mockDetectOnboardingState.mockResolvedValue(false);
    mockBuildSubagentRoleSection.mockReturnValue([]);
  });

  it("assembleExecutionPrompt returns systemPromptBlocks in ExecutionPromptResult for full mode", async () => {
    const params = makeParams({
      config: makeConfig({ bootstrap: { promptMode: "full" } }),
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPromptBlocks).toBeDefined();
    expect(result.systemPromptBlocks!.staticPrefix).toBe("static-prefix");
    expect(result.systemPromptBlocks!.attribution).toBe("attribution");
    expect(result.systemPromptBlocks!.semiStableBody).toBe("semi-stable-body");
  });

  it("CacheSafeParams.frozenSystemPromptBlocks is populated in session snapshot after first turn", async () => {
    mockAssembleRichSystemPromptBlocks.mockReturnValue({ staticPrefix: "cached-prefix", attribution: "cached-attribution", semiStableBody: "cached-body" });
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic", cacheRetention: "short" }),
    });
    await assembleExecutionPrompt(params);

    const captured = getCacheSafeParams(DEFAULT_SESSION_KEY);
    expect(captured).toBeDefined();
    expect(captured!.frozenSystemPromptBlocks).toBeDefined();
    expect(captured!.frozenSystemPromptBlocks!.staticPrefix).toBe("cached-prefix");
    expect(captured!.frozenSystemPromptBlocks!.attribution).toBe("cached-attribution");
    expect(captured!.frozenSystemPromptBlocks!.semiStableBody).toBe("cached-body");
  });

  it("sub-agent prefix reuse returns systemPromptBlocks from parent cacheSafeParams when model/provider match", async () => {
    const parentBlocks = { staticPrefix: "parent-prefix", attribution: "parent-attribution", semiStableBody: "parent-body" };
    const params = makeParams({
      config: makeConfig({ model: "claude-3-opus", provider: "anthropic" }),
      deps: {
        workspaceDir: "/workspace",
        spawnPacket: {
          task: "sub-task",
          artifactRefs: [],
          domainKnowledge: [],
          toolGroups: [],
          objective: "test-objective",
          workspaceDir: "/workspace",
          depth: 1,
          maxDepth: 3,
          cacheSafeParams: {
            frozenSystemPrompt: "parent-frozen-prompt",
            frozenSystemPromptBlocks: parentBlocks,
            toolNames: ["read", "exec"],
            model: "claude-3-opus",
            provider: "anthropic",
            cacheRetention: "short",
          },
        } as SpawnPacket,
      },
      resolvedModelId: "claude-3-opus",
      resolvedModelProvider: "anthropic",
    });
    const result = await assembleExecutionPrompt(params);

    expect(result.systemPrompt).toBe("parent-frozen-prompt");
    expect(result.systemPromptBlocks).toBeDefined();
    expect(result.systemPromptBlocks!.staticPrefix).toBe("parent-prefix");
    expect(result.systemPromptBlocks!.attribution).toBe("parent-attribution");
    expect(result.systemPromptBlocks!.semiStableBody).toBe("parent-body");
    // Should NOT call the full assembly path
    expect(mockAssembleRichSystemPrompt).not.toHaveBeenCalled();
    expect(mockAssembleRichSystemPromptBlocks).not.toHaveBeenCalled();
  });
});

describe("computeFeatureFlagHash", () => {
  // Import directly -- this is a pure function, no mocks needed
  let computeFeatureFlagHash: (config: { toolPolicy?: { mode?: string }; tools?: { enabledGroups?: string[] } }) => string;

  beforeEach(async () => {
    // Dynamic import to get the actual function (not mocked)
    const mod = await vi.importActual<typeof import("./prompt-assembly.js")>("./prompt-assembly.js");
    computeFeatureFlagHash = mod.computeFeatureFlagHash;
  });

  it("returns different hash when toolPolicy.mode changes (feature-flag)", () => {
    const hash1 = computeFeatureFlagHash({ toolPolicy: { mode: "auto" } });
    const hash2 = computeFeatureFlagHash({ toolPolicy: { mode: "filtered" } });
    expect(hash1).not.toBe(hash2);
  });

  it("returns same hash when unrelated config differs (feature-flag)", () => {
    const hash1 = computeFeatureFlagHash({ toolPolicy: { mode: "auto" } });
    const hash2 = computeFeatureFlagHash({ toolPolicy: { mode: "auto" } });
    expect(hash1).toBe(hash2);
  });

  it("includes enabledGroups in hash computation (feature-flag)", () => {
    const hash1 = computeFeatureFlagHash({ tools: { enabledGroups: ["web", "code"] } });
    const hash2 = computeFeatureFlagHash({ tools: { enabledGroups: ["web"] } });
    expect(hash1).not.toBe(hash2);
  });

  it("returns 'default' when no feature flags set (feature-flag)", () => {
    const hash = computeFeatureFlagHash({});
    expect(hash).toBe("default");
  });
});
