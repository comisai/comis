import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAnnouncementBatcher, sanitizeForUser, type AnnouncementBatcherDeps, type QueuedAnnouncement } from "./announcement-batcher.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAnnouncement(overrides: Partial<QueuedAnnouncement> = {}): QueuedAnnouncement {
  return {
    announcementText:
      "[System Message]\nA background task has completed.\n\nTask: test task\nStatus: Success\nResult: done\n\n---\nRuntime: 1.0s | Steps: 3 | Tokens: 500 | Cost: $0.0050 | Session: default:sub-agent-1:sub-agent:1\n\nInform the user about this completed background task. Summarize the result in your own voice. If no user notification is needed, respond with NO_REPLY.",
    announceChannelType: "discord",
    announceChannelId: "chan-123",
    callerAgentId: "agent-main",
    callerSessionKey: "default:user1:chan1",
    runId: "run-1",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AnnouncementBatcherDeps> = {}): AnnouncementBatcherDeps & { announceToParent: ReturnType<typeof vi.fn>; sendToChannel: ReturnType<typeof vi.fn> } {
  return {
    announceToParent: vi.fn().mockResolvedValue(undefined),
    sendToChannel: vi.fn().mockResolvedValue(true),
    debounceMs: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnnouncementBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("single announcement delivers immediately after debounce", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement());

    // Before debounce fires: not delivered
    expect(deps.announceToParent).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    // Single item delivers with original text unmodified
    expect(deps.announceToParent.mock.calls[0]![2]).toContain("[System Message]");
    expect(deps.announceToParent.mock.calls[0]![2]).toContain("A background task has completed.");
  });

  it("multiple announcements for same parent are batched", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-3" }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combinedText).toContain("3 background tasks have completed.");
    expect(combinedText).toContain("### Task 1");
    expect(combinedText).toContain("### Task 2");
    expect(combinedText).toContain("### Task 3");
    // System prefix and trailing instruction should be stripped from individual items
    expect(combinedText).not.toMatch(/### Task \d\n\[System Message\]/);
  });

  it("different parent sessions get separate batches", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({
      callerAgentId: "agent-a",
      callerSessionKey: "default:userA:chanA",
      runId: "run-a",
    }));
    batcher.enqueue(makeAnnouncement({
      callerAgentId: "agent-b",
      callerSessionKey: "default:userB:chanB",
      runId: "run-b",
    }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(deps.announceToParent).toHaveBeenCalledTimes(2);
  });

  it("flush delivers all pending immediately", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));

    // Don't advance timers -- flush forces delivery
    expect(deps.announceToParent).not.toHaveBeenCalled();

    await batcher.flush();

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combinedText).toContain("2 background tasks have completed.");
  });

  it("pending count reflects queued items", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    expect(batcher.pending).toBe(0);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({
      callerAgentId: "other-agent",
      callerSessionKey: "default:other:chan",
      runId: "run-3",
    }));

    expect(batcher.pending).toBe(3);

    await batcher.flush();

    expect(batcher.pending).toBe(0);
  });

  it("debounce resets on each enqueue", async () => {
    const deps = makeDeps();
    const batcher = createAnnouncementBatcher(deps);

    // Enqueue first item
    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));

    // Advance 1500ms (less than 2000ms debounce)
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.announceToParent).not.toHaveBeenCalled();

    // Enqueue second item -- resets debounce
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));

    // Advance another 1500ms (3000ms total, but only 1500ms since reset)
    await vi.advanceTimersByTimeAsync(1500);
    expect(deps.announceToParent).not.toHaveBeenCalled();

    // Advance remaining 500ms to hit the debounce from the reset
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.announceToParent).toHaveBeenCalledOnce();
    const combinedText = deps.announceToParent.mock.calls[0]![2] as string;
    expect(combinedText).toContain("2 background tasks have completed.");
  });

  // timeout fallback tests (updated for 300s timeout)
  it("single-item delivery falls back to sendToChannel when announceToParent hangs", async () => {
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement());

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    // announceToParent was called
    expect(deps.announceToParent).toHaveBeenCalledOnce();

    // Advance past the 300s timeout
    await vi.advanceTimersByTimeAsync(301_000);

    // sendToChannel should have been called as fallback with sanitized text
    expect(deps.sendToChannel).toHaveBeenCalledOnce();
    const fallbackText = deps.sendToChannel.mock.calls[0]![2] as string;
    // Stripped: no [System Message] prefix
    expect(fallbackText).not.toContain("[System Message]");
    // Stripped: no trailing instruction
    expect(fallbackText).not.toContain("Inform the user about this completed background task.");
    // Sanitized: no session keys, no runtime stats
    expect(fallbackText).not.toContain("Session:");
    expect(fallbackText).not.toMatch(/Runtime:.*Tokens:/);
    expect(fallbackText).not.toMatch(/\bdefault:\w+:\w+:\d+\b/);
    // Fallback extracts "Result:" content
    expect(fallbackText).toContain("done");
  });

  it("multi-item batched delivery falls back to individual sendToChannel calls when announceToParent hangs", async () => {
    const deps = makeDeps({
      announceToParent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const batcher = createAnnouncementBatcher(deps);

    batcher.enqueue(makeAnnouncement({ runId: "run-1" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-2" }));
    batcher.enqueue(makeAnnouncement({ runId: "run-3" }));

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(2000);

    // announceToParent was called for the batch
    expect(deps.announceToParent).toHaveBeenCalledOnce();

    // Advance past the 300s timeout
    await vi.advanceTimersByTimeAsync(301_000);

    // sendToChannel should have been called once for each item as fallback
    expect(deps.sendToChannel).toHaveBeenCalledTimes(3);
    // Each call uses sanitized text
    for (let i = 0; i < 3; i++) {
      const text = deps.sendToChannel.mock.calls[i]![2] as string;
      expect(text).not.toContain("[System Message]");
      expect(text).not.toContain("Inform the user about this completed background task.");
      expect(text).not.toMatch(/Runtime:.*Tokens:/);
      expect(text).not.toMatch(/\bdefault:\w+:\w+:\d+\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeForUser unit tests
// ---------------------------------------------------------------------------

describe("sanitizeForUser", () => {
  it("extracts Summary content from announcement text", () => {
    const text =
      "[System Message]\nA background task has completed.\n\nSummary: The image was generated successfully and saved.\n\n---\nRuntime: 1.0s | Steps: 3 | Tokens: 500 | Cost: $0.0050\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).toContain("The image was generated successfully and saved.");
    expect(result).not.toContain("[System Message]");
    expect(result).not.toContain("Runtime:");
  });

  it("strips subagent markers, session keys, file paths, and stats from extracted text", () => {
    const text =
      "[System Message]\nSummary: [Subagent Result: image_gen] The task at /home/user/.comis/data/output.png completed for session default:user1:discord:123.\nRuntime: 2.5s | Steps: 5 | Tokens: 1200 | Cost: $0.0120\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).not.toContain("[Subagent Result: image_gen]");
    expect(result).not.toContain("default:user1:discord:123");
    expect(result).not.toContain("/home/user/.comis/data/output.png");
    expect(result).not.toMatch(/Runtime:.*Tokens:/);
    expect(result).toContain("The task");
    expect(result).toContain("completed for session");
  });

  it("returns generic fallback when no Summary or Result section found", () => {
    const text = "[System Message]\nSome raw internal metadata only.\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).toBe("A background task completed but the result could not be delivered properly. Please ask me to check on it.");
  });

  it("extracts Result content when no Summary is present", () => {
    const text =
      "[System Message]\nA background task has completed.\n\nTask: web search\nStatus: Success\nResult: Found 3 articles about TypeScript monorepos.\n\n---\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).toContain("Found 3 articles about TypeScript monorepos.");
  });

  it("strips condensation stats from extracted text", () => {
    const text =
      "[System Message]\nSummary: Context was condensed 150 to 50 and 200\u219250 messages were processed.\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).not.toContain("condensed 150 to 50");
    expect(result).not.toMatch(/\d+\u2192\d+\s*messages/);
  });

  it("strips token count and cost patterns", () => {
    const text =
      "[System Message]\nSummary: Task done. Tokens: 1500 in: 1000 out: 500 Cost: $0.015\n\nInform the user about this completed background task.";
    const result = sanitizeForUser(text);
    expect(result).not.toMatch(/Tokens:\s*\d+/);
    expect(result).not.toMatch(/Cost:\s*\$/);
  });
});
