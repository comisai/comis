// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page, Locator } from "playwright-core";

// Mock playwright-session before importing snapshot module
vi.mock("./playwright-session.js", () => ({
  ensurePageState: vi.fn(),
  storeRoleRefs: vi.fn(),
}));

import { takeSnapshot } from "./playwright-snapshots.js";
import { ensurePageState, storeRoleRefs } from "./playwright-session.js";

// ── Mock helpers ─────────────────────────────────────────────────────

function createMockLocator(ariaResult: string): Locator {
  return {
    ariaSnapshot: vi.fn().mockResolvedValue(ariaResult),
  } as unknown as Locator;
}

function createMockPage(ariaResult: string, overrides?: Partial<Page>): Page {
  const locator = createMockLocator(ariaResult);
  return {
    locator: vi.fn().mockReturnValue(locator),
    url: vi.fn().mockReturnValue("https://example.com"),
    title: vi.fn().mockResolvedValue("Example Page"),
    ...overrides,
  } as unknown as Page;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("takeSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Default mode: ref annotation ──────────────────────────────────

  describe("default mode (ref annotation)", () => {
    it("should annotate interactive elements with sequential refs", async () => {
      const aria = [
        "- button \"Submit\"",
        "- link \"Home\"",
        "- textbox \"Email\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.snapshot).toContain("[ref=e1]");
      expect(result.snapshot).toContain("[ref=e2]");
      expect(result.snapshot).toContain("[ref=e3]");
      expect(result.refs.e1).toEqual({ role: "button", name: "Submit" });
      expect(result.refs.e2).toEqual({ role: "link", name: "Home" });
      expect(result.refs.e3).toEqual({ role: "textbox", name: "Email" });
    });

    it("should annotate named content elements with refs", async () => {
      const aria = [
        "- heading \"Title\"",
        "- cell \"Data\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.refs.e1).toEqual({ role: "heading", name: "Title" });
      expect(result.refs.e2).toEqual({ role: "cell", name: "Data" });
    });

    it("should NOT annotate structural elements with refs", async () => {
      const aria = [
        "- generic",
        "- group",
        "- list",
        "- button \"Click\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      // Only the button should get a ref
      expect(Object.keys(result.refs)).toHaveLength(1);
      expect(result.refs.e1).toEqual({ role: "button", name: "Click" });
    });

    it("should NOT annotate unnamed content elements with refs", async () => {
      const aria = [
        "- heading",
        "- button \"OK\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      // Only the button gets a ref; unnamed heading does not
      expect(Object.keys(result.refs)).toHaveLength(1);
      expect(result.refs.e1).toEqual({ role: "button", name: "OK" });
    });

    it("should preserve role names in quotes", async () => {
      const aria = "- button \"Submit Form\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.snapshot).toContain("button \"Submit Form\"");
    });

    it("should preserve suffix content after role+name", async () => {
      const aria = "- checkbox \"Agree\" [checked=true]";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.snapshot).toContain("[checked=true]");
      expect(result.snapshot).toContain("[ref=e1]");
    });

    it("should produce sequential refs e1, e2, e3", async () => {
      const aria = [
        "- button \"A\"",
        "- link \"B\"",
        "- checkbox \"C\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.refs).toHaveProperty("e1");
      expect(result.refs).toHaveProperty("e2");
      expect(result.refs).toHaveProperty("e3");
      expect(result.refs).not.toHaveProperty("e0");
    });

    it("should return (empty) when aria snapshot is empty", async () => {
      const page = createMockPage("");

      const result = await takeSnapshot(page);

      expect(result.snapshot).toBe("(empty)");
    });
  });

  // ── Interactive-only mode ─────────────────────────────────────────

  describe("interactive-only mode", () => {
    it("should only include interactive role elements", async () => {
      const aria = [
        "- heading \"Title\"",
        "  - button \"Submit\"",
        "  - paragraph",
        "  - link \"Home\"",
        "- generic",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { interactive: true });

      expect(result.snapshot).toContain("button \"Submit\"");
      expect(result.snapshot).toContain("link \"Home\"");
      expect(result.snapshot).not.toContain("heading");
      expect(result.snapshot).not.toContain("paragraph");
      expect(result.snapshot).not.toContain("generic");
    });

    it("should flatten indentation to top-level", async () => {
      const aria = [
        "- group",
        "  - list",
        "    - button \"Deep\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { interactive: true });

      // Interactive mode flattens: "- button" not "    - button"
      expect(result.snapshot).toMatch(/^- button "Deep"/);
    });

    it("should return '(no interactive elements)' when none found", async () => {
      const aria = [
        "- heading \"Title\"",
        "- paragraph",
        "- generic",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { interactive: true });

      expect(result.snapshot).toBe("(no interactive elements)");
    });

    it("should include combobox, searchbox, switch, tab, and other interactive roles", async () => {
      const aria = [
        "- combobox \"Choose\"",
        "- searchbox \"Search\"",
        "- switch \"Toggle\"",
        "- tab \"Settings\"",
        "- slider \"Volume\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { interactive: true });

      expect(Object.keys(result.refs)).toHaveLength(5);
    });
  });

  // ── Compact mode ──────────────────────────────────────────────────

  describe("compact mode", () => {
    it("should remove unnamed structural elements without ref children", async () => {
      const aria = [
        "- generic",
        "  - group",
        "    - list",
        "- button \"Submit\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { compact: true });

      // The button gets [ref=e1], and anonymous structural lines with
      // no ref children should be removed by compact
      expect(result.snapshot).toContain("button \"Submit\"");
      // "generic" at top with no ref children is removed
      expect(result.snapshot.split("\n").length).toBeLessThan(4);
    });

    it("should keep named content elements", async () => {
      const aria = [
        "- heading \"Important\"",
        "- generic",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { compact: true });

      expect(result.snapshot).toContain("heading \"Important\"");
    });

    it("should keep lines with [ref=]", async () => {
      const aria = [
        "- group",
        "  - button \"Click\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { compact: true });

      // button has [ref=e1] so it's kept; group is structural parent with ref child so kept
      expect(result.snapshot).toContain("[ref=e1]");
    });

    it("should remove unnamed structural elements even with compact", async () => {
      const aria = [
        "- generic",
        "- generic",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { compact: true });

      // Both unnamed generics have no ref children, should be removed
      // compactTree only keeps lines with [ref=], lines with colon+content, and structural parents of [ref=]
      expect(result.snapshot).toBe("");
    });
  });

  // ── maxDepth filtering ────────────────────────────────────────────

  describe("maxDepth filtering", () => {
    it("should exclude elements deeper than maxDepth", async () => {
      const aria = [
        "- group",
        "  - button \"Shallow\"",
        "    - link \"Deep\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { maxDepth: 1 });

      expect(result.snapshot).toContain("button \"Shallow\"");
      expect(result.snapshot).not.toContain("link \"Deep\"");
    });

    it("should include depth 0 elements when maxDepth is 0", async () => {
      const aria = [
        "- button \"Top\"",
        "  - link \"Nested\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { maxDepth: 0 });

      expect(result.snapshot).toContain("button \"Top\"");
      expect(result.snapshot).not.toContain("link \"Nested\"");
    });

    it("should respect maxDepth in interactive-only mode", async () => {
      const aria = [
        "- group",
        "  - list",
        "    - button \"Deep Button\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { interactive: true, maxDepth: 1 });

      // Button is at depth 2, should be excluded with maxDepth 1
      expect(result.snapshot).toBe("(no interactive elements)");
    });
  });

  // ── Ref tracking and nth ──────────────────────────────────────────

  describe("ref tracking and nth", () => {
    it("should add [nth=N] annotations for duplicate role+name pairs", async () => {
      const aria = [
        "- button \"Submit\"",
        "- button \"Submit\"",
        "- button \"Submit\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      // First occurrence: nth=0 internally but only displayed from nth=1
      // Second: nth=1, Third: nth=2
      expect(result.snapshot).toContain("[nth=1]");
      expect(result.snapshot).toContain("[nth=2]");
      // refs should have nth values
      expect(result.refs.e2!.nth).toBe(1);
      expect(result.refs.e3!.nth).toBe(2);
    });

    it("should NOT add nth for unique role+name pairs", async () => {
      const aria = [
        "- button \"Submit\"",
        "- button \"Cancel\"",
        "- link \"Home\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.snapshot).not.toContain("[nth=");
      // nth should be removed from refs for unique pairs
      expect(result.refs.e1!.nth).toBeUndefined();
      expect(result.refs.e2!.nth).toBeUndefined();
      expect(result.refs.e3!.nth).toBeUndefined();
    });

    it("should handle mixed duplicate and unique pairs", async () => {
      const aria = [
        "- button \"Save\"",
        "- link \"Home\"",
        "- button \"Save\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      // "Save" buttons are duplicates, "Home" link is unique
      expect(result.refs.e1!.nth).toBe(0); // first Save, nth kept because duplicate
      expect(result.refs.e2!.nth).toBeUndefined(); // unique Home
      expect(result.refs.e3!.nth).toBe(1); // second Save
    });
  });

  // ── Truncation (maxChars) ─────────────────────────────────────────

  describe("truncation (maxChars)", () => {
    it("should truncate snapshot exceeding maxChars", async () => {
      const longLine = "- button \"" + "A".repeat(200) + "\"";
      const page = createMockPage(longLine);

      const result = await takeSnapshot(page, { maxChars: 50 });

      expect(result.snapshot).toContain("[...TRUNCATED - page too large]");
      expect(result.truncated).toBe(true);
    });

    it("should NOT truncate snapshot within maxChars", async () => {
      const aria = "- button \"Submit\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { maxChars: 10000 });

      expect(result.snapshot).not.toContain("TRUNCATED");
      expect(result.truncated).toBeUndefined();
    });

    it("should not truncate when maxChars is 0", async () => {
      const aria = "- button \"Submit\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page, { maxChars: 0 });

      expect(result.snapshot).not.toContain("TRUNCATED");
    });
  });

  // ── Stats calculation ─────────────────────────────────────────────

  describe("stats calculation", () => {
    it("should count lines correctly", async () => {
      const aria = [
        "- button \"A\"",
        "- link \"B\"",
        "- heading \"C\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.stats.lines).toBe(3);
    });

    it("should count total characters", async () => {
      const aria = "- button \"Submit\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.stats.chars).toBe(result.snapshot.length);
    });

    it("should count total refs", async () => {
      const aria = [
        "- button \"A\"",
        "- link \"B\"",
        "- generic",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.stats.refs).toBe(2); // button + link, not generic
    });

    it("should count interactive refs separately", async () => {
      const aria = [
        "- button \"A\"",
        "- heading \"Title\"",
        "- link \"B\"",
      ].join("\n");
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      // 3 refs total (button, heading with name, link)
      expect(result.stats.refs).toBe(3);
      // 2 interactive (button, link)
      expect(result.stats.interactive).toBe(2);
    });
  });

  // ── takeSnapshot integration with mock Page ───────────────────────

  describe("takeSnapshot integration", () => {
    it("should call page.locator(':root').ariaSnapshot() by default", async () => {
      const aria = "- button \"Click\"";
      const page = createMockPage(aria);

      await takeSnapshot(page);

      expect(page.locator).toHaveBeenCalledWith(":root");
    });

    it("should call page.locator(selector) when selector is provided", async () => {
      const aria = "- button \"Click\"";
      const page = createMockPage(aria);

      await takeSnapshot(page, { selector: "#content" });

      expect(page.locator).toHaveBeenCalledWith("#content");
    });

    it("should store refs via storeRoleRefs with 'role' mode", async () => {
      const aria = "- button \"Submit\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(storeRoleRefs).toHaveBeenCalledWith(
        page,
        result.refs,
        "role",
      );
    });

    it("should return url from page.url()", async () => {
      const aria = "- button \"Click\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.url).toBe("https://example.com");
    });

    it("should return title from page.title()", async () => {
      const aria = "- button \"Click\"";
      const page = createMockPage(aria);

      const result = await takeSnapshot(page);

      expect(result.title).toBe("Example Page");
    });

    it("should return empty string when page.title() fails", async () => {
      const aria = "- button \"Click\"";
      const page = createMockPage(aria, {
        title: vi.fn().mockRejectedValue(new Error("detached")),
      });

      const result = await takeSnapshot(page);

      expect(result.title).toBe("");
    });

    it("should call ensurePageState on the page", async () => {
      const aria = "- button \"Click\"";
      const page = createMockPage(aria);

      await takeSnapshot(page);

      expect(ensurePageState).toHaveBeenCalledWith(page);
    });

    it("should handle null ariaSnapshot gracefully", async () => {
      const mockLocator = {
        ariaSnapshot: vi.fn().mockResolvedValue(null),
      } as unknown as Locator;
      const page = {
        locator: vi.fn().mockReturnValue(mockLocator),
        url: vi.fn().mockReturnValue("https://example.com"),
        title: vi.fn().mockResolvedValue("Test"),
      } as unknown as Page;

      const result = await takeSnapshot(page);

      expect(result.snapshot).toBe("(empty)");
    });
  });
});
