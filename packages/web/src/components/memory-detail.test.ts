// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcMemoryDetail } from "./memory-detail.js";
import type { MemoryEntry } from "../api/types/index.js";

// Import side-effect to register custom element
import "./memory-detail.js";

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

const testEntry: MemoryEntry = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  content:
    "Meeting scheduled at 3pm with the product team to discuss Q2 roadmap priorities.",
  memoryType: "episodic",
  trustLevel: "learned",
  agentId: "default",
  tenantId: "default",
  source: "telegram / user:12345",
  tags: ["meeting", "product", "roadmap"],
  hasEmbedding: true,
  embeddingDims: 1536,
  createdAt: Date.now() - 7200000,
  score: 0.9234,
};

describe("IcMemoryDetail", () => {
  it("renders empty state when entry is null", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: null,
    });
    const empty = el.shadowRoot?.querySelector(".empty-state");
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain("No entry selected");
  });

  it("renders entry ID in mono font", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const idEl = el.shadowRoot?.querySelector(".detail-id");
    expect(idEl).toBeTruthy();
    expect(idEl?.textContent?.trim()).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("renders score as large number", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const scoreEl = el.shadowRoot?.querySelector(".score-display");
    expect(scoreEl).toBeTruthy();
    expect(scoreEl?.textContent?.trim()).toBe("0.9234");
  });

  it("does not render score section when score is undefined", async () => {
    const noScoreEntry: MemoryEntry = {
      ...testEntry,
      score: undefined,
    };
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: noScoreEntry,
    });
    const scoreEl = el.shadowRoot?.querySelector(".score-display");
    expect(scoreEl).toBeNull();
  });

  it("renders full content text", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const contentEl = el.shadowRoot?.querySelector(".content-block");
    expect(contentEl).toBeTruthy();
    expect(contentEl?.textContent?.trim()).toContain("Meeting scheduled at 3pm");
  });

  it("renders memory type as ic-tag", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const tags = el.shadowRoot?.querySelectorAll("ic-tag");
    // First tag in badges-row should be the memory type
    const badgesRow = el.shadowRoot?.querySelector(".badges-row");
    const typeTags = badgesRow?.querySelectorAll("ic-tag");
    expect(typeTags).toBeTruthy();
    expect(typeTags!.length).toBeGreaterThanOrEqual(1);
    expect(typeTags![0].textContent?.trim()).toBe("episodic");
  });

  it("renders trust level as ic-tag", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const badgesRow = el.shadowRoot?.querySelector(".badges-row");
    const tags = badgesRow?.querySelectorAll("ic-tag");
    expect(tags).toBeTruthy();
    expect(tags!.length).toBeGreaterThanOrEqual(2);
    expect(tags![1].textContent?.trim()).toBe("learned");
  });

  it("renders agent ID", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const sections = el.shadowRoot?.querySelectorAll(".detail-section");
    const agentSection = Array.from(sections!).find(
      (s) => s.querySelector(".detail-label")?.textContent?.trim() === "Agent",
    );
    expect(agentSection).toBeTruthy();
    const value = agentSection?.querySelector(".detail-value");
    expect(value?.textContent?.trim()).toBe("default");
  });

  it("renders source info when present", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const sections = el.shadowRoot?.querySelectorAll(".detail-section");
    const sourceSection = Array.from(sections!).find(
      (s) => s.querySelector(".detail-label")?.textContent?.trim() === "Source",
    );
    expect(sourceSection).toBeTruthy();
    const value = sourceSection?.querySelector(".detail-value");
    expect(value?.textContent?.trim()).toBe("telegram / user:12345");
  });

  it("does not render source when absent", async () => {
    const noSourceEntry: MemoryEntry = {
      ...testEntry,
      source: undefined,
    };
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: noSourceEntry,
    });
    const sections = el.shadowRoot?.querySelectorAll(".detail-section");
    const sourceSection = Array.from(sections!).find(
      (s) => s.querySelector(".detail-label")?.textContent?.trim() === "Source",
    );
    expect(sourceSection).toBeFalsy();
  });

  it("renders tags when present", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const tagsList = el.shadowRoot?.querySelector(".tags-list");
    expect(tagsList).toBeTruthy();
    const tags = tagsList?.querySelectorAll("ic-tag");
    expect(tags?.length).toBe(3);
    const tagTexts = Array.from(tags!).map((t) => t.textContent?.trim());
    expect(tagTexts).toContain("meeting");
    expect(tagTexts).toContain("product");
    expect(tagTexts).toContain("roadmap");
  });

  it("shows embedding status with dimensions when hasEmbedding is true", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const embeddingStatus = el.shadowRoot?.querySelector(".embedding-status");
    expect(embeddingStatus).toBeTruthy();
    const icon = embeddingStatus?.querySelector(".embedding-icon--yes");
    expect(icon).toBeTruthy();
    const dims = embeddingStatus?.querySelector(".embedding-dims");
    expect(dims?.textContent).toContain("1536");
  });

  it("shows 'Not indexed' when hasEmbedding is false", async () => {
    const noEmbeddingEntry: MemoryEntry = {
      ...testEntry,
      hasEmbedding: false,
      embeddingDims: undefined,
    };
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: noEmbeddingEntry,
    });
    const embeddingStatus = el.shadowRoot?.querySelector(".embedding-status");
    expect(embeddingStatus).toBeTruthy();
    const icon = embeddingStatus?.querySelector(".embedding-icon--no");
    expect(icon).toBeTruthy();
    expect(embeddingStatus?.textContent).toContain("Not indexed");
  });

  it("shows creation timestamp", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const sections = el.shadowRoot?.querySelectorAll(".detail-section");
    const createdSection = Array.from(sections!).find(
      (s) => s.querySelector(".detail-label")?.textContent?.trim() === "Created",
    );
    expect(createdSection).toBeTruthy();
    const value = createdSection?.querySelector(".timestamp-value");
    expect(value?.textContent?.trim().length).toBeGreaterThan(5);
  });

  it("delete button is present", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const deleteBtn = el.shadowRoot?.querySelector(".delete-btn");
    expect(deleteBtn).toBeTruthy();
    expect(deleteBtn?.textContent?.trim()).toBe("Delete Entry");
  });

  it("delete button dispatches delete-requested event with entry ID", async () => {
    const el = await createElement<IcMemoryDetail>("ic-memory-detail", {
      entry: testEntry,
    });
    const handler = vi.fn();
    el.addEventListener("delete-requested", handler);

    const deleteBtn = el.shadowRoot?.querySelector(".delete-btn") as HTMLElement;
    deleteBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
