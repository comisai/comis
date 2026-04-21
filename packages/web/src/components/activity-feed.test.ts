// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { relativeTime, summarizePayload, IcActivityFeed } from "./activity-feed.js";
import type { ActivityEntry } from "../api/types/index.js";
import type { SseEventHandler } from "../api/api-client.js";

// Import side-effects to register custom elements
import "./activity-feed.js";
import "./form/ic-filter-chips.js";

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

function makeEntry(
  id: number,
  event: string,
  payload: Record<string, unknown> = {},
  timestampOffset = 0,
): ActivityEntry {
  return {
    id,
    event,
    payload,
    timestamp: Date.now() - timestampOffset,
  };
}

function createMockSubscribe(): {
  subscribe: (handler: SseEventHandler) => () => void;
  getHandler: () => SseEventHandler | null;
  unsubscribeFn: ReturnType<typeof vi.fn>;
} {
  let handler: SseEventHandler | null = null;
  const unsubscribeFn = vi.fn();
  const subscribe = (h: SseEventHandler): (() => void) => {
    handler = h;
    return unsubscribeFn;
  };
  return {
    subscribe,
    getHandler: () => handler,
    unsubscribeFn,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---- Utility function tests (existing) ----

describe("relativeTime", () => {
  it("returns 'Xs ago' for timestamps within 60 seconds", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(now - 30_000)).toBe("30s ago");
    expect(relativeTime(now - 1_000)).toBe("1s ago");
  });

  it("returns 'Xm ago' for timestamps within 60 minutes", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(now - 120_000)).toBe("2m ago");
    expect(relativeTime(now - 3_540_000)).toBe("59m ago");
  });

  it("returns 'Xh ago' for timestamps within 24 hours", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(now - 3_600_000)).toBe("1h ago");
    expect(relativeTime(now - 82_800_000)).toBe("23h ago");
  });

  it("returns 'Xd ago' for timestamps beyond 24 hours", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(relativeTime(now - 86_400_000)).toBe("1d ago");
    expect(relativeTime(now - 172_800_000)).toBe("2d ago");
  });
});

describe("summarizePayload", () => {
  it("extracts channel and text for message events", () => {
    const result = summarizePayload("message:received", {
      channelType: "telegram",
      text: "hello world",
    });
    expect(result).toBe("[telegram] hello world");
  });

  it("truncates text at 60 chars with '...'", () => {
    const longText = "A".repeat(80);
    const result = summarizePayload("message:sent", {
      channelType: "discord",
      text: longText,
    });
    expect(result).toBe(`[discord] ${"A".repeat(57)}...`);
    expect(result.length).toBeLessThanOrEqual(70);
  });

  it("extracts error message for system:error events", () => {
    const result = summarizePayload("system:error", {
      message: "Connection timeout",
    });
    expect(result).toBe("Connection timeout");
  });

  it("uses 'error' field fallback for system:error events", () => {
    const result = summarizePayload("system:error", {
      error: "Something broke",
    });
    expect(result).toBe("Something broke");
  });

  it("returns 'Unknown error' when no message field in system:error", () => {
    const result = summarizePayload("system:error", {});
    expect(result).toBe("Unknown error");
  });

  it("extracts skill name for skill events", () => {
    const result = summarizePayload("skill:executed", {
      skillName: "web-search",
    });
    expect(result).toBe("web-search");
  });

  it("uses 'name' field fallback for skill events", () => {
    const result = summarizePayload("skill:loaded", {
      name: "memory-recall",
    });
    expect(result).toBe("memory-recall");
  });

  it("returns generic key-value fallback for unknown events", () => {
    const result = summarizePayload("custom:event", {
      foo: "bar",
      baz: "qux",
    });
    expect(result).toBe("foo: bar, baz: qux");
  });

  it("returns empty string when payload is empty for unknown events", () => {
    const result = summarizePayload("custom:event", {});
    expect(result).toBe("");
  });
});

// ---- Component rendering tests ----

describe("IcActivityFeed", () => {
  describe("basic rendering", () => {
    it("renders feed container with header, filter chips area, and feed list", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });
      const container = el.shadowRoot?.querySelector(".feed-container");
      const header = el.shadowRoot?.querySelector(".feed-header");
      const filters = el.shadowRoot?.querySelector(".feed-filters");
      const feedList = el.shadowRoot?.querySelector(".feed-list");

      expect(container).not.toBeNull();
      expect(header).not.toBeNull();
      expect(filters).not.toBeNull();
      expect(feedList).not.toBeNull();
    });

    it("shows 'No activity yet' when entries is empty", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });
      const empty = el.shadowRoot?.querySelector(".empty-state");
      expect(empty?.textContent?.trim()).toBe("No activity yet");
    });

    it("shows Live indicator when sseSubscribe is connected", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      const liveIndicator = el.shadowRoot?.querySelector(".live-indicator");
      expect(liveIndicator).not.toBeNull();
      expect(liveIndicator?.textContent).toContain("Live");
    });

    it("does not show Live indicator when no sseSubscribe", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });
      const liveIndicator = el.shadowRoot?.querySelector(".live-indicator");
      expect(liveIndicator).toBeNull();
    });

    it("renders event badges with correct labels from EVENT_CONFIG", async () => {
      const entries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "hi" }),
        makeEntry(2, "system:error", { message: "Timeout" }),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", { entries });
      const badges = el.shadowRoot?.querySelectorAll(".event-badge");

      expect(badges?.length).toBe(2);
      // Entries are reversed (newest first based on initial order reversal)
      const badgeTexts = Array.from(badges!).map((b) => b.textContent?.trim());
      expect(badgeTexts).toContain("MSG IN");
      expect(badgeTexts).toContain("ERROR");
    });

    it("renders relative timestamps for entries", async () => {
      const entries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "hi" }, 5000),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", { entries });
      const times = el.shadowRoot?.querySelectorAll(".event-time");
      expect(times?.length).toBe(1);
      expect(times![0].textContent?.trim()).toMatch(/\d+s ago/);
    });

    it("combines live entries with initial entries (deduplicates by ID)", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const initialEntries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "initial" }),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: initialEntries,
        sseSubscribe: subscribe,
      });

      // Simulate a live SSE event
      getHandler()!("message:sent", { channelType: "discord", text: "live msg" });
      await el.updateComplete;

      const items = el.shadowRoot?.querySelectorAll(".feed-item");
      expect(items?.length).toBe(2);
    });
  });

  // ---- Filter chip tests ----

  describe("filtering", () => {
    it("renders ic-filter-chips element in the feed", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });
      const chips = el.shadowRoot?.querySelector("ic-filter-chips");
      expect(chips).not.toBeNull();
    });

    it("filter chips have options matching EVENT_CONFIG keys", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });
      const chips = el.shadowRoot?.querySelector("ic-filter-chips") as any;
      expect(chips).not.toBeNull();
      // The options property should have the same number of entries as EVENT_CONFIG
      expect(chips.options.length).toBe(14); // 14 event types in EVENT_CONFIG
      const values = chips.options.map((o: { value: string }) => o.value);
      expect(values).toContain("message:received");
      expect(values).toContain("system:error");
      expect(values).toContain("scheduler:job_completed");
    });

    it("setting active filters hides non-matching entries", async () => {
      const entries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "hi" }),
        makeEntry(2, "system:error", { message: "Timeout" }),
        makeEntry(3, "message:sent", { channelType: "discord", text: "bye" }),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", { entries });

      // Set filter to only show message:received
      (el as any)._activeFilters = new Set(["message:received"]);
      await el.updateComplete;

      const items = el.shadowRoot?.querySelectorAll(".feed-item");
      expect(items?.length).toBe(1);
      const badge = items![0].querySelector(".event-badge");
      expect(badge?.textContent?.trim()).toBe("MSG IN");
    });

    it("empty active filters (Set) shows all entries", async () => {
      const entries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "hi" }),
        makeEntry(2, "system:error", { message: "Timeout" }),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", { entries });

      // Ensure empty filter shows all
      (el as any)._activeFilters = new Set();
      await el.updateComplete;

      const items = el.shadowRoot?.querySelectorAll(".feed-item");
      expect(items?.length).toBe(2);
    });

    it("dispatching filter-change event from filter chips updates displayed entries", async () => {
      const entries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "hi" }),
        makeEntry(2, "system:error", { message: "Timeout" }),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", { entries });

      // Dispatch filter-change from the filter chips
      const chips = el.shadowRoot?.querySelector("ic-filter-chips");
      expect(chips).not.toBeNull();

      chips!.dispatchEvent(
        new CustomEvent("filter-change", {
          detail: { selected: new Set(["system:error"]) },
          bubbles: true,
          composed: true,
        }),
      );
      await el.updateComplete;

      const items = el.shadowRoot?.querySelectorAll(".feed-item");
      expect(items?.length).toBe(1);
      const badge = items![0].querySelector(".event-badge");
      expect(badge?.textContent?.trim()).toBe("ERROR");
    });

    it("filter applies to both initial entries and live entries", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const entries: ActivityEntry[] = [
        makeEntry(1, "message:received", { channelType: "telegram", text: "initial" }),
      ];

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries,
        sseSubscribe: subscribe,
      });

      // Add a live event of different type
      getHandler()!("system:error", { message: "Live error" });
      await el.updateComplete;

      // Should show both without filter
      let items = el.shadowRoot?.querySelectorAll(".feed-item");
      expect(items?.length).toBe(2);

      // Apply filter for system:error only
      (el as any)._activeFilters = new Set(["system:error"]);
      await el.updateComplete;

      items = el.shadowRoot?.querySelectorAll(".feed-item");
      expect(items?.length).toBe(1);
      const badge = items![0].querySelector(".event-badge");
      expect(badge?.textContent?.trim()).toBe("ERROR");
    });
  });

  // ---- Pause/resume tests ----

  describe("pause/resume", () => {
    it("pause button renders in feed header when SSE connected", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      const pauseBtn = el.shadowRoot?.querySelector(".pause-btn");
      expect(pauseBtn).not.toBeNull();
      expect(pauseBtn?.textContent?.trim()).toBe("Pause");
    });

    it("does not render pause button when no SSE connection", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });

      const pauseBtn = el.shadowRoot?.querySelector(".pause-btn");
      expect(pauseBtn).toBeNull();
    });

    it("clicking pause button sets _paused to true", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      const pauseBtn = el.shadowRoot?.querySelector(".pause-btn") as HTMLButtonElement;
      pauseBtn.click();
      await el.updateComplete;

      expect((el as any)._paused).toBe(true);
    });

    it("when paused, indicator shows 'Paused' instead of 'Live'", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause
      (el as any)._paused = true;
      await el.updateComplete;

      const pausedIndicator = el.shadowRoot?.querySelector(".paused-indicator");
      expect(pausedIndicator).not.toBeNull();
      expect(pausedIndicator?.textContent).toContain("Paused");

      const liveIndicator = el.shadowRoot?.querySelector(".live-indicator");
      expect(liveIndicator).toBeNull();
    });

    it("when paused, new SSE events go to _pauseBuffer (not _liveEntries)", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause
      (el as any)._paused = true;
      await el.updateComplete;

      const liveCountBefore = (el as any)._liveEntries.length;

      // Send SSE event while paused
      getHandler()!("message:received", { channelType: "telegram", text: "buffered" });
      await el.updateComplete;

      expect((el as any)._pauseBuffer.length).toBe(1);
      expect((el as any)._liveEntries.length).toBe(liveCountBefore);
    });

    it("resume merges _pauseBuffer into _liveEntries", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause and add buffered events
      (el as any)._paused = true;
      await el.updateComplete;

      getHandler()!("message:received", { channelType: "telegram", text: "buffered1" });
      getHandler()!("system:error", { message: "buffered error" });
      await el.updateComplete;

      expect((el as any)._pauseBuffer.length).toBe(2);

      // Resume
      (el as any)._togglePause();
      await el.updateComplete;

      expect((el as any)._liveEntries.length).toBe(2);
      expect((el as any)._paused).toBe(false);
    });

    it("resume clears _pauseBuffer", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause and buffer
      (el as any)._paused = true;
      await el.updateComplete;
      getHandler()!("message:received", { channelType: "telegram", text: "buffered" });
      await el.updateComplete;

      // Resume
      (el as any)._togglePause();
      await el.updateComplete;

      expect((el as any)._pauseBuffer.length).toBe(0);
    });

    it("pause button shows buffered count: 'Resume (3)'", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause
      const pauseBtn = el.shadowRoot?.querySelector(".pause-btn") as HTMLButtonElement;
      pauseBtn.click();
      await el.updateComplete;

      // Buffer 3 events
      getHandler()!("message:received", { text: "1" });
      getHandler()!("message:received", { text: "2" });
      getHandler()!("message:received", { text: "3" });
      await el.updateComplete;

      const btn = el.shadowRoot?.querySelector(".pause-btn");
      expect(btn?.textContent?.trim()).toBe("Resume (3)");
    });

    it("after resume, indicator shows 'Live' again", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause then resume
      (el as any)._paused = true;
      await el.updateComplete;
      (el as any)._togglePause();
      await el.updateComplete;

      const liveIndicator = el.shadowRoot?.querySelector(".live-indicator");
      expect(liveIndicator).not.toBeNull();
      expect(liveIndicator?.textContent).toContain("Live");

      const pausedIndicator = el.shadowRoot?.querySelector(".paused-indicator");
      expect(pausedIndicator).toBeNull();
    });
  });

  // ---- Ring buffer tests ----

  describe("ring buffer", () => {
    it("_liveEntries capped at 200 entries (not 100)", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Send 210 events
      for (let i = 0; i < 210; i++) {
        getHandler()!("message:received", { text: `msg-${i}` });
      }
      await el.updateComplete;

      expect((el as any)._liveEntries.length).toBe(200);
    });

    it("oldest entries pruned when buffer exceeds 200", async () => {
      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Send 205 events
      for (let i = 0; i < 205; i++) {
        getHandler()!("message:received", { text: `msg-${i}` });
      }
      await el.updateComplete;

      const liveEntries = (el as any)._liveEntries as ActivityEntry[];
      expect(liveEntries.length).toBe(200);
      // The newest should be first (id will be 100_000 + 204)
      expect(liveEntries[0].id).toBe(100_000 + 204);
      // Oldest surviving should be 100_000 + 5 (first 5 pruned)
      expect(liveEntries[199].id).toBe(100_000 + 5);
    });

    it("_mergedEntries returns max 200 combined entries", async () => {
      // Create 150 initial entries and 100 live entries = 250 total
      const initialEntries: ActivityEntry[] = [];
      for (let i = 0; i < 150; i++) {
        initialEntries.push(makeEntry(i, "message:received", { text: `initial-${i}` }));
      }

      const { subscribe, getHandler } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: initialEntries,
        sseSubscribe: subscribe,
      });

      // Add 100 live entries (distinct IDs starting at 100_000)
      for (let i = 0; i < 100; i++) {
        getHandler()!("message:received", { text: `live-${i}` });
      }
      await el.updateComplete;

      const merged = (el as any)._mergedEntries() as ActivityEntry[];
      expect(merged.length).toBeLessThanOrEqual(200);
    });
  });

  // ---- Design token tests ----

  describe("design tokens", () => {
    it("feed container uses var(--ic-surface) background", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });

      // Check CSS in shadow root contains design token references
      const styleSheets = el.shadowRoot?.adoptedStyleSheets ?? [];
      const allCss = styleSheets.map((s) =>
        Array.from(s.cssRules).map((r) => r.cssText).join("\n"),
      ).join("\n");

      expect(allCss).toContain("--ic-surface");
    });

    it("feed items use var(--ic-border) for borders", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });

      const styleSheets = el.shadowRoot?.adoptedStyleSheets ?? [];
      const allCss = styleSheets.map((s) =>
        Array.from(s.cssRules).map((r) => r.cssText).join("\n"),
      ).join("\n");

      expect(allCss).toContain("--ic-border");
    });
  });

  // ---- Accessibility tests ----

  describe("accessibility", () => {
    it("feed list has aria-live='polite'", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });

      const feedList = el.shadowRoot?.querySelector(".feed-list");
      expect(feedList?.getAttribute("aria-live")).toBe("polite");
    });

    it("feed container has aria-label", async () => {
      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
      });

      const container = el.shadowRoot?.querySelector(".feed-container");
      expect(container?.getAttribute("aria-label")).toBe("Activity feed");
    });

    it("pause button has aria-label describing current state (pause)", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      const pauseBtn = el.shadowRoot?.querySelector(".pause-btn");
      expect(pauseBtn?.getAttribute("aria-label")).toBe("Pause live feed");
    });

    it("pause button has aria-label describing current state (resume)", async () => {
      const { subscribe } = createMockSubscribe();

      const el = await createElement<IcActivityFeed>("ic-activity-feed", {
        entries: [],
        sseSubscribe: subscribe,
      });

      // Pause
      (el as any)._paused = true;
      await el.updateComplete;

      const pauseBtn = el.shadowRoot?.querySelector(".pause-btn");
      expect(pauseBtn?.getAttribute("aria-label")).toBe("Resume live feed");
    });
  });
});
