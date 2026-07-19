// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import type {
  NormalizedMessage,
  ResolvedTurnScope,
  WorkspacePolicySnapshot,
} from "@comis/core";

import {
  assembleModelRequest,
  prepareTurn,
  type ActiveCapabilitySnapshot,
  type AssembledConversationWindow,
  type RecallContext,
  type ResolvedLocale,
} from "./turn-preparation.js";

const scope: ResolvedTurnScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  principal: { kind: "user", id: "user_a" },
  endpoint: { kind: "api", id: "endpoint_a" },
  conversation: {
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "user_a",
    channelType: "api",
    channelId: "endpoint_a",
    threadId: "thread_a",
    partition: "direct",
  },
};

const workspacePolicy: WorkspacePolicySnapshot = {
  agentId: "agent_a",
  sections: [],
  combinedHash: "a".repeat(64),
};

const capabilities: ActiveCapabilitySnapshot = {
  tools: [{ name: "read", description: "Read a file" }],
};

const locale: ResolvedLocale = {
  policy: { locale: "en", source: "explicit", enforceLocale: true },
  confidence: "high",
};

const currentRequest: NormalizedMessage = {
  id: "message_a",
  channelType: "api",
  channelId: "endpoint_a",
  senderId: "user_a",
  text: "current request sentinel",
  timestamp: 1,
};

const conversation: AssembledConversationWindow = {
  history: [{ role: "assistant", content: "prior reply" }],
  currentRequest,
};

const recall: RecallContext = {
  memories: [{ id: "memory_a", content: "recalled fact" }],
};

function makeResolvers() {
  return {
    resolveWorkspacePolicy: vi.fn(async () => ok(workspacePolicy)),
    captureCapabilities: vi.fn(() => ok(capabilities)),
    assembleConversation: vi.fn(async () => ok(conversation)),
    selectRecall: vi.fn(async () => ok(recall)),
  };
}

describe("turn preparation", () => {
  it("resolves each authoritative turn input exactly once", async () => {
    const resolvers = makeResolvers();

    const result = await prepareTurn({
      scope,
      locale,
      selectedSkills: [],
      externalInstructions: [],
      resolvers,
    });

    expect(result.ok).toBe(true);
    expect(resolvers.resolveWorkspacePolicy).toHaveBeenCalledTimes(1);
    expect(resolvers.captureCapabilities).toHaveBeenCalledTimes(1);
    expect(resolvers.assembleConversation).toHaveBeenCalledTimes(1);
    expect(resolvers.selectRecall).toHaveBeenCalledTimes(1);
  });

  it.each([
    "workspacePolicy",
    "scope",
    "capabilities",
  ] as const)("fails when required %s authority is missing", async (missing) => {
    const resolvers = makeResolvers();
    if (missing === "workspacePolicy") {
      resolvers.resolveWorkspacePolicy = vi.fn(async () => ok(undefined));
    }
    if (missing === "capabilities") {
      resolvers.captureCapabilities = vi.fn(() => ok(undefined));
    }

    const result = await prepareTurn({
      scope: missing === "scope" ? undefined : scope,
      locale,
      selectedSkills: [],
      externalInstructions: [],
      resolvers,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: `missing_${missing === "workspacePolicy" ? "workspace_policy" : missing}` },
    });
  });

  it("places the current request only in the assembled conversation", async () => {
    const prepared = await prepareTurn({
      scope,
      locale,
      selectedSkills: [],
      externalInstructions: [],
      resolvers: makeResolvers(),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const request = assembleModelRequest({
      preparedTurn: prepared.value,
      compiledPrompt: { systemPrompt: "trusted policy" },
    });

    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.value.conversation.at(-1)).toEqual({
      role: "user",
      content: "current request sentinel",
    });
    expect(JSON.stringify(request.value).match(/current request sentinel/gu)).toHaveLength(1);
  });
});
