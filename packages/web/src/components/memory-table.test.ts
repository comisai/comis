// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcMemoryTable } from "./memory-table.js";
import type { MemoryEntry } from "../api/types/index.js";

// Import side-effect to register custom element
import "./memory-table.js";

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

function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "mem-001",
    content: "Test memory content",
    memoryType: "episodic",
    trustLevel: "learned",
    agentId: "default",
    tenantId: "default",
    hasEmbedding: true,
    createdAt: Date.now() - 3600000,
    score: 0.923,
    ...overrides,
  };
}

const testEntries: MemoryEntry[] = [
  makeEntry({
    id: "1",
    content: "Test memory",
    memoryType: "episodic",
    trustLevel: "learned",
    score: 0.923,
    createdAt: Date.now() - 3600000,
  }),
  makeEntry({
    id: "2",
    content: "Another memory",
    memoryType: "semantic",
    trustLevel: "system",
    score: undefined,
    hasEmbedding: false,
    createdAt: Date.now() - 86400000,
  }),
];

const testEntriesWithScores: MemoryEntry[] = [
  makeEntry({
    id: "1",
    content: "Test memory",
    memoryType: "episodic",
    trustLevel: "learned",
    score: 0.923,
  }),
  makeEntry({
    id: "2",
    content: "Another memory",
    memoryType: "semantic",
    trustLevel: "system",
    score: 0.812,
  }),
];

describe("IcMemoryTable", () => {
  it("renders ic-data-table element in shadow DOM", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table");
    expect(dataTable).toBeTruthy();
  });

  it("renders correct number of data rows matching entries", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    expect(dataTable).toBeTruthy();
    // The data table receives the rows
    expect(dataTable.rows?.length).toBe(2);
  });

  it("score column shown when entries have score property", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const scoreCol = columns.find((c) => c.key === "score");
    expect(scoreCol).toBeTruthy();
    expect(scoreCol?.label).toBe("Score");
  });

  it("score column hidden when entries lack score property", async () => {
    const noScoreEntries: MemoryEntry[] = [
      makeEntry({ id: "1", score: undefined }),
      makeEntry({ id: "2", score: undefined }),
    ];
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: noScoreEntries,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const scoreCol = columns.find((c) => c.key === "score");
    expect(scoreCol).toBeFalsy();
  });

  it("content column exists with correct label", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const contentCol = columns.find((c) => c.key === "content");
    expect(contentCol).toBeTruthy();
    expect(contentCol?.label).toBe("Content");
  });

  it("type column exists with correct label", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const typeCol = columns.find((c) => c.key === "memoryType");
    expect(typeCol).toBeTruthy();
    expect(typeCol?.label).toBe("Type");
  });

  it("trust column exists with correct label", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const trustCol = columns.find((c) => c.key === "trustLevel");
    expect(trustCol).toBeTruthy();
    expect(trustCol?.label).toBe("Trust");
  });

  it("agent column exists with correct label", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const agentCol = columns.find((c) => c.key === "agentId");
    expect(agentCol).toBeTruthy();
    expect(agentCol?.label).toBe("Agent");
  });

  it("age column exists with correct label", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const ageCol = columns.find((c) => c.key === "createdAt");
    expect(ageCol).toBeTruthy();
    expect(ageCol?.label).toBe("Age");
  });

  it("row click dispatches detail-requested event with entry data", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const handler = vi.fn();
    el.addEventListener("detail-requested", handler);

    // Simulate row-click from data table
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as HTMLElement;
    dataTable.dispatchEvent(
      new CustomEvent("row-click", { detail: testEntriesWithScores[0], bubbles: true }),
    );

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.id).toBe("1");
  });

  it("selectable mode enables selection on data table", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
      selectable: true,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    expect(dataTable.selectable).toBe(true);
  });

  it("selection change dispatches selection-change event", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
      selectable: true,
    });
    const handler = vi.fn();
    el.addEventListener("selection-change", handler);

    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as HTMLElement;
    dataTable.dispatchEvent(
      new CustomEvent("selection-change", { detail: ["1"], bubbles: true }),
    );

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual(["1"]);
  });

  it("empty entries shows empty state from data table", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: [],
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    expect(dataTable.rows.length).toBe(0);
    expect(dataTable.emptyMessage).toBe("No memory entries found");
  });

  it("has correct column headers (Score, Content, Type, Trust, Agent, Age)", async () => {
    const el = await createElement<IcMemoryTable>("ic-memory-table", {
      entries: testEntriesWithScores,
    });
    const dataTable = el.shadowRoot?.querySelector("ic-data-table") as any;
    const columns = dataTable.columns as Array<{ key: string; label: string }>;
    const labels = columns.map((c) => c.label);
    expect(labels).toContain("Score");
    expect(labels).toContain("Content");
    expect(labels).toContain("Type");
    expect(labels).toContain("Trust");
    expect(labels).toContain("Agent");
    expect(labels).toContain("Age");
  });
});
