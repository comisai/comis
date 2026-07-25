// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { SessionManager as SdkSessionManager } from "@earendil-works/pi-coding-agent";
import {
  ConversationLocatorSchema,
  ConversationRefSchema,
  conversationScopeToSessionKey,
  createConversationRef,
  validateMemoryWrite,
  type DeliveredAssistantHistoryError,
  type DeliveredAssistantHistoryInput,
  type DeliveredAssistantHistoryPort,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import type { ComisSessionManager } from "./comis-session-manager.js";

export const DELIVERED_ASSISTANT_HISTORY_CUSTOM_TYPE = "delivered_assistant_history";

const MAX_IDENTIFIER_BYTES = 256;
const MAX_DELIVERED_TEXT_BYTES = 64 * 1024;

function hasBoundedUtf8Bytes(value: string, maxBytes: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export const DeliveredAssistantHistoryRecordSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  conversationRef: ConversationRefSchema,
  sourceExecutionId: z.string().min(1),
  attemptId: z.string().min(1),
  lastPlatformMessageId: z.string().min(1).optional(),
  deliveredAtMs: z.number().int().nonnegative().safe(),
  text: z.string().min(1),
  contentTrust: z.enum(["derived", "external"]),
}).superRefine((value, ctx) => {
  for (const [field, text] of [
    ["tenantId", value.tenantId],
    ["agentId", value.agentId],
    ["sourceExecutionId", value.sourceExecutionId],
    ["attemptId", value.attemptId],
    ...(value.lastPlatformMessageId === undefined
      ? []
      : [["lastPlatformMessageId", value.lastPlatformMessageId]]),
  ] as Array<[string, string]>) {
    if (!hasBoundedUtf8Bytes(text, MAX_IDENTIFIER_BYTES)) {
      ctx.addIssue({ code: "custom", path: [field], message: "identifier exceeds UTF-8 byte bound" });
    }
  }
  if (!hasBoundedUtf8Bytes(value.text, MAX_DELIVERED_TEXT_BYTES)) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "delivered text exceeds UTF-8 byte bound" });
  }
});

export type DeliveredAssistantHistoryRecord = z.infer<typeof DeliveredAssistantHistoryRecordSchema>;

export interface DeliveredAssistantHistoryAdapterDeps {
  resolveSessionManager(agentId: string): ComisSessionManager | undefined;
  isAccepting(): boolean;
}

function invalidInput(): Result<never, DeliveredAssistantHistoryError> {
  return err({ code: "invalid_input", errorKind: "validation" });
}

function recordsMatch(
  stored: DeliveredAssistantHistoryRecord,
  expected: Omit<DeliveredAssistantHistoryRecord, "contentTrust">,
): boolean {
  return stored.tenantId === expected.tenantId
    && stored.agentId === expected.agentId
    && stored.conversationRef === expected.conversationRef
    && stored.sourceExecutionId === expected.sourceExecutionId
    && stored.attemptId === expected.attemptId
    && stored.lastPlatformMessageId === expected.lastPlatformMessageId
    && stored.deliveredAtMs === expected.deliveredAtMs
    && stored.text === expected.text;
}

function findExistingAttempt(
  sessionManager: SdkSessionManager,
  expected: Omit<DeliveredAssistantHistoryRecord, "contentTrust">,
): Result<"absent" | "matching" | "conflict", DeliveredAssistantHistoryError> {
  const entries = tryCatch(() => sessionManager.getEntries());
  if (!entries.ok) return err({ code: "append_failed", errorKind: "resource" });

  for (const entry of entries.value) {
    if (entry.type !== "custom" || entry.customType !== DELIVERED_ASSISTANT_HISTORY_CUSTOM_TYPE) continue;
    const parsed = DeliveredAssistantHistoryRecordSchema.safeParse(entry.data);
    if (!parsed.success || parsed.data.attemptId !== expected.attemptId) continue;
    return ok(recordsMatch(parsed.data, expected) ? "matching" : "conflict");
  }
  return ok("absent");
}

function appendUnderLock(
  sessionManager: SdkSessionManager,
  expected: Omit<DeliveredAssistantHistoryRecord, "contentTrust">,
): Result<"appended" | "already_present", DeliveredAssistantHistoryError> {
  const existing = findExistingAttempt(sessionManager, expected);
  if (!existing.ok) return existing;
  if (existing.value === "matching") return ok("already_present");
  if (existing.value === "conflict") {
    return err({ code: "conflict", errorKind: "precondition" });
  }

  const validation = validateMemoryWrite(expected.text);
  if (validation.severity === "critical") return invalidInput();
  const record: DeliveredAssistantHistoryRecord = {
    ...expected,
    contentTrust: validation.severity === "warn" ? "external" : "derived",
  };
  const appended = tryCatch(() => sessionManager.appendCustomEntry(
    DELIVERED_ASSISTANT_HISTORY_CUSTOM_TYPE,
    record,
  ));
  return appended.ok
    ? ok("appended")
    : err({ code: "append_failed", errorKind: "resource" });
}

/** Create the agent-owned adapter for idempotent, session-locked delivery history. */
export function createDeliveredAssistantHistoryAdapter(
  deps: DeliveredAssistantHistoryAdapterDeps,
): DeliveredAssistantHistoryPort {
  return {
    async append(input: DeliveredAssistantHistoryInput) {
      if (!deps.isAccepting()) {
        return err({ code: "not_accepting", errorKind: "precondition" });
      }
      const locator = ConversationLocatorSchema.safeParse(input.conversation);
      if (!locator.success) {
        return err({ code: "invalid_conversation", errorKind: "validation" });
      }
      const expectedRef = createConversationRef(locator.data.conversationScope);
      if (!expectedRef.ok || expectedRef.value !== locator.data.conversationRef) {
        return err({ code: "invalid_conversation", errorKind: "validation" });
      }
      const sessionKey = conversationScopeToSessionKey(locator.data.conversationScope);
      if (!sessionKey.ok) {
        return err({ code: "invalid_conversation", errorKind: "validation" });
      }
      const expected = {
        tenantId: locator.data.conversationScope.tenantId,
        agentId: locator.data.conversationScope.agentId,
        conversationRef: locator.data.conversationRef,
        sourceExecutionId: input.sourceExecutionId,
        attemptId: input.attemptId,
        ...(input.lastPlatformMessageId === undefined
          ? {}
          : { lastPlatformMessageId: input.lastPlatformMessageId }),
        deliveredAtMs: input.deliveredAtMs,
        text: input.deliveredText,
      } satisfies Omit<DeliveredAssistantHistoryRecord, "contentTrust">;
      const validated = DeliveredAssistantHistoryRecordSchema.safeParse({
        ...expected,
        contentTrust: "derived",
      });
      if (!validated.success) return invalidInput();

      const sessionManager = deps.resolveSessionManager(locator.data.conversationScope.agentId);
      if (sessionManager === undefined) {
        return err({ code: "invalid_conversation", errorKind: "validation" });
      }
      const locked = await sessionManager.withSession(
        sessionKey.value,
        async (sdk) => appendUnderLock(sdk, expected),
      );
      if (!locked.ok) {
        return locked.error === "locked"
          ? err({ code: "session_locked", errorKind: "resource" })
          : err({ code: "append_failed", errorKind: "resource" });
      }
      return locked.value;
    },
  };
}
