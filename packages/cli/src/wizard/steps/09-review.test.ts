/**
 * Tests for review summary step (step 09).
 *
 * Verifies summary display, confirm/edit/cancel actions,
 * go-back navigation via _jumpTo, and summary content
 * containing all configured wizard state values.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { CancelError } from "../index.js";
import { reviewStep } from "./09-review.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    select?: string[];
  } = {},
): WizardPrompter {
  const selectQueue = [...(responses.select ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async (opts) => opts.defaultValue ?? ""),
    select: vi.fn(async () => selectQueue.shift() ?? ""),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    spinner: vi.fn(() => mockSpinner),
    group: vi.fn(async (steps) => {
      const result: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) {
        result[key] = await (fn as () => Promise<unknown>)();
      }
      return result;
    }) as WizardPrompter["group"],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
}

function populatedState(): WizardState {
  return {
    completedSteps: ["welcome", "provider", "credentials", "agent", "channels", "gateway", "workspace"],
    provider: { id: "anthropic", apiKey: "sk-test-key" },
    agentName: "my-agent",
    model: "claude-sonnet-4-5-20250929",
    channels: [{ type: "telegram", botToken: "123:ABC", validated: true }],
    gateway: {
      port: 4766,
      bindMode: "loopback",
      authMethod: "token",
      token: "abc123token",
    },
    dataDir: "/home/test/.comis/data",
  };
}

// ---------- Tests ----------

describe("reviewStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct step id and label", () => {
    expect(reviewStep.id).toBe("review");
    expect(reviewStep.label).toBe("Review");
  });

  it("user confirms -> state unchanged and proceeds", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["confirm"],
    });

    const result = await reviewStep.execute(state, prompter);

    // State should be returned with same values
    expect(result.agentName).toBe("my-agent");
    expect(result.provider?.id).toBe("anthropic");
    expect(result._jumpTo).toBeUndefined();
  });

  it("user selects go back to edit provider -> state._jumpTo = 'provider'", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["edit", "provider"],
    });

    const result = await reviewStep.execute(state, prompter);

    expect(result._jumpTo).toBe("provider");
  });

  it("user selects go back to edit gateway -> state._jumpTo = 'gateway'", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["edit", "gateway"],
    });

    const result = await reviewStep.execute(state, prompter);

    expect(result._jumpTo).toBe("gateway");
  });

  it("user selects go back to edit workspace -> state._jumpTo = 'workspace'", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["edit", "workspace"],
    });

    const result = await reviewStep.execute(state, prompter);

    expect(result._jumpTo).toBe("workspace");
  });

  it("user cancels -> throws CancelError", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["cancel"],
    });

    await expect(reviewStep.execute(state, prompter)).rejects.toThrow(CancelError);
  });

  it("note() called with summary content containing agent name and provider", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["confirm"],
    });

    await reviewStep.execute(state, prompter);

    // note() is called at least twice: heading + summary
    const noteCalls = vi.mocked(prompter.note).mock.calls;
    expect(noteCalls.length).toBeGreaterThanOrEqual(2);

    // The second note call should contain the summary text with provider and agent
    const summaryCall = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("anthropic"),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toContain("my-agent");
  });

  it("summary includes gateway info when gateway is configured", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["confirm"],
    });

    await reviewStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const summaryCall = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("4766"),
    );
    expect(summaryCall).toBeDefined();
  });

  it("summary includes channel info when channels are configured", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["confirm"],
    });

    await reviewStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const summaryCall = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("telegram"),
    );
    expect(summaryCall).toBeDefined();
  });

  it("summary includes workspace info when dataDir is set", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["confirm"],
    });

    await reviewStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const summaryCall = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("/home/test/.comis/data"),
    );
    expect(summaryCall).toBeDefined();
  });

  it("edit options include channels when channels state exists", async () => {
    const state = populatedState();
    const prompter = createMockPrompter({
      select: ["edit", "channels"],
    });

    const result = await reviewStep.execute(state, prompter);

    // Second select call should include channels option
    const secondSelectCall = vi.mocked(prompter.select).mock.calls[1];
    const options = secondSelectCall[0].options as { value: string; label: string }[];
    const channelsOption = options.find((o) => o.value === "channels");
    expect(channelsOption).toBeDefined();
    expect(result._jumpTo).toBe("channels");
  });

  it("shows pending marker for unvalidated channels", async () => {
    const state: WizardState = {
      ...populatedState(),
      channels: [{ type: "telegram", botToken: "123:ABC", validated: false }],
    };
    const prompter = createMockPrompter({
      select: ["confirm"],
    });

    await reviewStep.execute(state, prompter);

    const noteCalls = vi.mocked(prompter.note).mock.calls;
    const summaryCall = noteCalls.find(
      ([msg]) => typeof msg === "string" && msg.includes("pending"),
    );
    expect(summaryCall).toBeDefined();
  });
});
