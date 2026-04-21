// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSessionList } from "./ic-session-list.js";
import type { SessionInfo } from "../../api/types/index.js";

// Side-effect import to register custom element
import "./ic-session-list.js";

const testSessions: SessionInfo[] = [
  {
    key: "abc12345",
    agentId: "default",
    channelType: "telegram",
    messageCount: 47,
    totalTokens: 23400,
    inputTokens: 15234,
    outputTokens: 8166,
    toolCalls: 12,
    compactions: 1,
    resetCount: 0,
    createdAt: Date.now() - 7200000,
    lastActiveAt: Date.now() - 3600000,
  },
  {
    key: "def67890",
    agentId: "default",
    channelType: "discord",
    messageCount: 12,
    totalTokens: 8100,
    inputTokens: 5200,
    outputTokens: 2900,
    toolCalls: 3,
    compactions: 0,
    resetCount: 1,
    createdAt: Date.now() - 18000000,
    lastActiveAt: Date.now() - 7200000,
  },
  {
    key: "ghi11223longkeythatexceedstruncation",
    agentId: "support",
    channelType: "slack",
    messageCount: 103,
    totalTokens: 67200,
    inputTokens: 42000,
    outputTokens: 25200,
    toolCalls: 28,
    compactions: 2,
    resetCount: 0,
    createdAt: Date.now() - 86400000,
    lastActiveAt: Date.now() - 43200000,
  },
];

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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcSessionList", () => {
  it("renders ic-data-table in shadow DOM", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    expect(table).toBeTruthy();
  });

  it("passes sessions as rows to ic-data-table", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table") as any;
    expect(table.rows).toHaveLength(3);
  });

  it("renders correct number of data rows", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const rows = table?.shadowRoot?.querySelectorAll(".grid-row");
    expect(rows?.length).toBe(3);
  });

  it("renders session key as parsed display name with bold text", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    // Check that at least one <strong> element exists in the session column
    const strongElements = table?.shadowRoot?.querySelectorAll(
      ".grid-row .cell strong",
    );
    expect(strongElements?.length).toBeGreaterThan(0);
  });

  it("renders status column with colored dots", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const headerCells = table?.shadowRoot?.querySelectorAll(".header-cell");
    const statusHeader = Array.from(headerCells ?? []).find((h) =>
      h.textContent?.includes("Status"),
    );
    expect(statusHeader).toBeTruthy();
  });

  it("renders agent ID column", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const headerCells = table?.shadowRoot?.querySelectorAll(".header-cell");
    const agentHeader = Array.from(headerCells ?? []).find((h) =>
      h.textContent?.includes("Agent"),
    );
    expect(agentHeader).toBeTruthy();
  });

  it("renders channel column with ic-tag", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const tags = table?.shadowRoot?.querySelectorAll("ic-tag");
    expect(tags?.length).toBeGreaterThan(0);
  });

  it("renders messages column", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const headerCells = table?.shadowRoot?.querySelectorAll(".header-cell");
    const messagesHeader = Array.from(headerCells ?? []).find((h) =>
      h.textContent?.includes("Messages"),
    );
    expect(messagesHeader).toBeTruthy();
  });

  it("renders tokens column with formatted values", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const cells = table?.shadowRoot?.querySelectorAll(".grid-row .cell");
    const allText = Array.from(cells ?? [])
      .map((c) => c.textContent)
      .join(" ");
    // 23400 -> "23.4K"
    expect(allText).toContain("23.4K");
  });

  it("renders age column with ic-relative-time", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const relTimes = table?.shadowRoot?.querySelectorAll("ic-relative-time");
    expect(relTimes?.length).toBeGreaterThan(0);
  });

  it("dispatches session-click event on row click", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
    });
    const handler = vi.fn();
    el.addEventListener("session-click", handler);

    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const row = table?.shadowRoot?.querySelector(".grid-row") as HTMLElement;
    row?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toHaveProperty("key");
  });

  it("forwards selectable property to ic-data-table", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
      selectable: true,
    });
    const table = el.shadowRoot?.querySelector("ic-data-table") as any;
    expect(table?.selectable).toBe(true);
  });

  it("dispatches selection-change event when selection changes", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: testSessions,
      selectable: true,
    });
    const handler = vi.fn();
    el.addEventListener("selection-change", handler);

    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const checkbox = table?.shadowRoot?.querySelector(
      ".grid-row input[type='checkbox']",
    ) as HTMLInputElement;
    checkbox?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(Array.isArray((handler.mock.calls[0][0] as CustomEvent).detail)).toBe(true);
  });

  it("shows empty message when sessions array is empty", async () => {
    const el = await createElement<IcSessionList>("ic-session-list", {
      sessions: [],
    });
    const table = el.shadowRoot?.querySelector("ic-data-table");
    await (table as any)?.updateComplete;
    const emptyMsg = table?.shadowRoot?.querySelector(".empty-message");
    expect(emptyMsg?.textContent).toContain("No sessions found");
  });
});
