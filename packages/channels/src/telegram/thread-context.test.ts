import { describe, it, expect } from "vitest";
import {
  TELEGRAM_GENERAL_TOPIC_ID,
  TELEGRAM_THREAD_META_KEYS,
  resolveTelegramThreadContext,
  buildSendThreadParams,
  buildTypingThreadParams,
  isTelegramThreadNotFoundError,
  resolveOutboundThreadParams,
} from "./thread-context.js";

// ---------------------------------------------------------------------------
// resolveTelegramThreadContext
// ---------------------------------------------------------------------------

describe("resolveTelegramThreadContext", () => {
  it("returns forum scope with explicit threadId for forum group", () => {
    const result = resolveTelegramThreadContext({
      isForum: true,
      isGroup: true,
      rawThreadId: 42,
    });
    expect(result).toEqual({ threadId: 42, scope: "forum" });
  });

  it("defaults to General Topic ID=1 for forum group without threadId", () => {
    const result = resolveTelegramThreadContext({
      isForum: true,
      isGroup: true,
      rawThreadId: undefined,
    });
    expect(result).toEqual({ threadId: TELEGRAM_GENERAL_TOPIC_ID, scope: "forum" });
  });

  it("returns scope none for non-forum group even with message_thread_id", () => {
    const result = resolveTelegramThreadContext({
      isForum: false,
      isGroup: true,
      rawThreadId: 42,
    });
    expect(result).toEqual({ threadId: undefined, scope: "none" });
  });

  it("returns scope none for non-forum group without message_thread_id", () => {
    const result = resolveTelegramThreadContext({
      isForum: false,
      isGroup: true,
      rawThreadId: undefined,
    });
    expect(result).toEqual({ threadId: undefined, scope: "none" });
  });

  it("returns dm scope when DM has rawThreadId", () => {
    const result = resolveTelegramThreadContext({
      isForum: false,
      isGroup: false,
      rawThreadId: 7,
    });
    expect(result).toEqual({ threadId: 7, scope: "dm" });
  });

  it("returns scope none for regular DM without topic", () => {
    const result = resolveTelegramThreadContext({
      isForum: false,
      isGroup: false,
      rawThreadId: undefined,
    });
    expect(result).toEqual({ threadId: undefined, scope: "none" });
  });

  it("returns scope none for channel post (not group, not forum)", () => {
    const result = resolveTelegramThreadContext({
      isForum: false,
      isGroup: false,
      rawThreadId: undefined,
    });
    expect(result).toEqual({ threadId: undefined, scope: "none" });
  });
});

// ---------------------------------------------------------------------------
// buildSendThreadParams
// ---------------------------------------------------------------------------

describe("buildSendThreadParams", () => {
  it("returns message_thread_id for forum scope with non-General Topic", () => {
    expect(buildSendThreadParams(42, "forum")).toEqual({ message_thread_id: 42 });
  });

  it("returns undefined for forum scope with General Topic ID=1 (asymmetry)", () => {
    expect(buildSendThreadParams(TELEGRAM_GENERAL_TOPIC_ID, "forum")).toBeUndefined();
  });

  it("returns message_thread_id for dm scope with ID=1", () => {
    expect(buildSendThreadParams(1, "dm")).toEqual({ message_thread_id: 1 });
  });

  it("returns message_thread_id for dm scope with ID=7", () => {
    expect(buildSendThreadParams(7, "dm")).toEqual({ message_thread_id: 7 });
  });

  it("returns undefined for undefined threadId", () => {
    expect(buildSendThreadParams(undefined, "forum")).toBeUndefined();
  });

  it("returns undefined for negative threadId (defensive guard)", () => {
    expect(buildSendThreadParams(-1, "forum")).toBeUndefined();
  });

  it("returns undefined for zero threadId (defensive guard)", () => {
    expect(buildSendThreadParams(0, "forum")).toBeUndefined();
  });

  it("returns undefined for scope none regardless of threadId", () => {
    expect(buildSendThreadParams(42, "none")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildTypingThreadParams
// ---------------------------------------------------------------------------

describe("buildTypingThreadParams", () => {
  it("returns message_thread_id for normal topic", () => {
    expect(buildTypingThreadParams(42)).toEqual({ message_thread_id: 42 });
  });

  it("returns message_thread_id for General Topic ID=1 (unlike send)", () => {
    expect(buildTypingThreadParams(TELEGRAM_GENERAL_TOPIC_ID)).toEqual({
      message_thread_id: 1,
    });
  });

  it("returns undefined for undefined threadId", () => {
    expect(buildTypingThreadParams(undefined)).toBeUndefined();
  });

  it("returns undefined for negative threadId (defensive guard)", () => {
    expect(buildTypingThreadParams(-1)).toBeUndefined();
  });

  it("returns undefined for zero threadId (defensive guard)", () => {
    expect(buildTypingThreadParams(0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isTelegramThreadNotFoundError
// ---------------------------------------------------------------------------

describe("isTelegramThreadNotFoundError", () => {
  it("detects 'message thread not found' error", () => {
    expect(isTelegramThreadNotFoundError(new Error("Bad Request: message thread not found"))).toBe(
      true,
    );
  });

  it("detects TOPIC_CLOSED error", () => {
    expect(isTelegramThreadNotFoundError(new Error("TOPIC_CLOSED"))).toBe(true);
  });

  it("detects TOPIC_DELETED error", () => {
    expect(isTelegramThreadNotFoundError(new Error("TOPIC_DELETED"))).toBe(true);
  });

  it("returns false for unrelated error", () => {
    expect(isTelegramThreadNotFoundError(new Error("Bad Request: chat not found"))).toBe(false);
  });

  it("handles string input gracefully", () => {
    expect(isTelegramThreadNotFoundError("message thread not found")).toBe(true);
  });

  it("returns false for non-string non-Error input", () => {
    expect(isTelegramThreadNotFoundError(42)).toBe(false);
    expect(isTelegramThreadNotFoundError(null)).toBe(false);
    expect(isTelegramThreadNotFoundError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveOutboundThreadParams
// ---------------------------------------------------------------------------

describe("resolveOutboundThreadParams", () => {
  it("returns undefined for missing options", () => {
    expect(resolveOutboundThreadParams(undefined)).toBeUndefined();
  });

  it("returns undefined when options has no threadId", () => {
    expect(resolveOutboundThreadParams({})).toBeUndefined();
  });

  it("returns message_thread_id for valid forum threadId", () => {
    expect(
      resolveOutboundThreadParams({
        threadId: "42",
        extra: { telegramThreadScope: "forum" },
      }),
    ).toEqual({ message_thread_id: 42 });
  });

  it("returns undefined for General Topic in forum scope (asymmetry)", () => {
    expect(
      resolveOutboundThreadParams({
        threadId: "1",
        extra: { telegramThreadScope: "forum" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for non-numeric threadId", () => {
    expect(
      resolveOutboundThreadParams({
        threadId: "abc",
        extra: { telegramThreadScope: "forum" },
      }),
    ).toBeUndefined();
  });

  it("defaults scope to forum when telegramThreadScope not in extra", () => {
    expect(
      resolveOutboundThreadParams({ threadId: "7" }),
    ).toEqual({ message_thread_id: 7 });
  });

  it("returns message_thread_id=1 for dm scope (DM topics always include)", () => {
    expect(
      resolveOutboundThreadParams({
        threadId: "1",
        extra: { telegramThreadScope: "dm" },
      }),
    ).toEqual({ message_thread_id: 1 });
  });

  it("returns undefined for negative threadId string", () => {
    expect(
      resolveOutboundThreadParams({ threadId: "-5" }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TELEGRAM_THREAD_META_KEYS
// ---------------------------------------------------------------------------

describe("TELEGRAM_THREAD_META_KEYS", () => {
  it("contains all 4 expected metadata keys", () => {
    expect(TELEGRAM_THREAD_META_KEYS).toContain("telegramThreadId");
    expect(TELEGRAM_THREAD_META_KEYS).toContain("telegramIsForum");
    expect(TELEGRAM_THREAD_META_KEYS).toContain("telegramThreadScope");
    expect(TELEGRAM_THREAD_META_KEYS).toContain("threadId");
  });

  it("has exactly 4 entries", () => {
    expect(TELEGRAM_THREAD_META_KEYS).toHaveLength(4);
  });
});
