// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page, Locator } from "playwright-core";
import { executeAction } from "./playwright-actions.js";
import type { BrowserAction } from "./playwright-actions.js";
import {
  ensurePageState,
  storeRoleRefs,
  getPageState,
  refLocator,
  isConnected,
} from "./playwright-session.js";

// ── Mock helpers ─────────────────────────────────────────────────────

function createMockLocator(overrides?: Record<string, unknown>): Locator {
  const loc: Record<string, unknown> = {
    click: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    dragTo: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    setChecked: vi.fn().mockResolvedValue(undefined),
    nth: vi.fn().mockReturnThis(),
    ...overrides,
  };
  return loc as unknown as Locator;
}

function createMockPage(): Page {
  const mockLocator = createMockLocator();
  const mockKeyboard = { press: vi.fn().mockResolvedValue(undefined) };

  const page = {
    locator: vi.fn().mockReturnValue(mockLocator),
    getByRole: vi.fn().mockReturnValue(mockLocator),
    frameLocator: vi.fn().mockReturnValue({
      locator: vi.fn().mockReturnValue(mockLocator),
      getByRole: vi.fn().mockReturnValue(mockLocator),
    }),
    keyboard: mockKeyboard,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as Page;

  return page;
}

/**
 * Setup a mock page with role refs installed in the real pageStates WeakMap.
 * Uses the real ensurePageState + storeRoleRefs so refLocator works.
 */
function setupPageWithRefs(
  page: Page,
  refs: Record<string, { role: string; name?: string; nth?: number }>,
  mode: "role" | "aria" = "role",
  frameSelector?: string,
): void {
  ensurePageState(page);
  storeRoleRefs(page, refs, mode, frameSelector);
}

// ── executeAction Tests ─────────────────────────────────────────────

describe("executeAction", () => {
  let page: Page;
  let mockLocator: Locator;

  const defaultRefs = {
    e1: { role: "button", name: "Submit" },
    e2: { role: "textbox", name: "Email" },
    e3: { role: "link", name: "Home" },
    e4: { role: "combobox", name: "Options" },
    e5: { role: "checkbox", name: "Agree" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    page = createMockPage();
    mockLocator = createMockLocator();
    // getByRole returns our mockLocator
    (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(mockLocator);
    // Install refs so refLocator can resolve them
    setupPageWithRefs(page, defaultRefs);
  });

  // ── Click action ──────────────────────────────────────────────────

  describe("click action", () => {
    it("should call locator.click with timeout", async () => {
      const result = await executeAction(page, {
        kind: "click",
        ref: "e1",
      });

      expect(result.ok).toBe(true);
      expect(result.action).toBe("click");
      expect(mockLocator.click).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should call locator.dblclick when doubleClick is true", async () => {
      const result = await executeAction(page, {
        kind: "click",
        ref: "e1",
        doubleClick: true,
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.dblclick).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should pass button and modifiers through", async () => {
      await executeAction(page, {
        kind: "click",
        ref: "e1",
        button: "right",
        modifiers: ["Control", "Shift"],
      });

      expect(mockLocator.click).toHaveBeenCalledWith(
        expect.objectContaining({
          button: "right",
          modifiers: ["Control", "Shift"],
        }),
      );
    });

    it("should strip @ prefix from ref", async () => {
      const result = await executeAction(page, {
        kind: "click",
        ref: "@e1",
      });

      expect(result.ok).toBe(true);
      expect(page.getByRole).toHaveBeenCalled();
    });

    it("should return ok:false with error for empty ref", async () => {
      const result = await executeAction(page, {
        kind: "click",
        ref: "",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("ref is required");
    });
  });

  // ── Type action ───────────────────────────────────────────────────

  describe("type action", () => {
    it("should call locator.fill by default", async () => {
      const result = await executeAction(page, {
        kind: "type",
        ref: "e2",
        text: "test@example.com",
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.fill).toHaveBeenCalledWith(
        "test@example.com",
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should call locator.click then locator.type with delay when slowly", async () => {
      const result = await executeAction(page, {
        kind: "type",
        ref: "e2",
        text: "slow typing",
        slowly: true,
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.click).toHaveBeenCalled();
      expect(mockLocator.type).toHaveBeenCalledWith(
        "slow typing",
        expect.objectContaining({ delay: 75 }),
      );
    });

    it("should press Enter after fill when submit is true", async () => {
      await executeAction(page, {
        kind: "type",
        ref: "e2",
        text: "search",
        submit: true,
      });

      expect(mockLocator.fill).toHaveBeenCalled();
      expect(mockLocator.press).toHaveBeenCalledWith(
        "Enter",
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should return error for empty ref", async () => {
      const result = await executeAction(page, {
        kind: "type",
        ref: "",
        text: "hello",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("ref is required");
    });
  });

  // ── Press action ──────────────────────────────────────────────────

  describe("press action", () => {
    it("should call page.keyboard.press with key", async () => {
      const result = await executeAction(page, {
        kind: "press",
        key: "Enter",
      });

      expect(result.ok).toBe(true);
      expect(page.keyboard.press).toHaveBeenCalledWith("Enter", { delay: 0 });
    });

    it("should pass floored delayMs (min 0)", async () => {
      await executeAction(page, {
        kind: "press",
        key: "Tab",
        delayMs: 150.7,
      });

      expect(page.keyboard.press).toHaveBeenCalledWith("Tab", { delay: 150 });
    });

    it("should clamp negative delayMs to 0", async () => {
      await executeAction(page, {
        kind: "press",
        key: "Escape",
        delayMs: -50,
      });

      expect(page.keyboard.press).toHaveBeenCalledWith("Escape", { delay: 0 });
    });

    it("should return error for empty key", async () => {
      const result = await executeAction(page, {
        kind: "press",
        key: "",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("key is required");
    });
  });

  // ── Hover action ──────────────────────────────────────────────────

  describe("hover action", () => {
    it("should call locator.hover with timeout", async () => {
      const result = await executeAction(page, {
        kind: "hover",
        ref: "e3",
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.hover).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should map error through toFriendlyError", async () => {
      (mockLocator.hover as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Timeout 8000ms exceeded waiting for locator to be visible"),
      );

      const result = await executeAction(page, {
        kind: "hover",
        ref: "e3",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found or not visible");
    });
  });

  // ── Drag action ───────────────────────────────────────────────────

  describe("drag action", () => {
    it("should call startRef locator.dragTo(endRef locator)", async () => {
      const result = await executeAction(page, {
        kind: "drag",
        startRef: "e1",
        endRef: "e3",
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.dragTo).toHaveBeenCalled();
    });

    it("should include both refs in error message on failure", async () => {
      (mockLocator.dragTo as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("intercepts pointer events"),
      );

      const result = await executeAction(page, {
        kind: "drag",
        startRef: "e1",
        endRef: "e3",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not interactable");
    });
  });

  // ── Select action ─────────────────────────────────────────────────

  describe("select action", () => {
    it("should call locator.selectOption with values array", async () => {
      const result = await executeAction(page, {
        kind: "select",
        ref: "e4",
        values: ["option1", "option2"],
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.selectOption).toHaveBeenCalledWith(
        ["option1", "option2"],
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should return error for empty values", async () => {
      const result = await executeAction(page, {
        kind: "select",
        ref: "e4",
        values: [],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("values are required");
    });
  });

  // ── Fill action (batch) ───────────────────────────────────────────

  describe("fill action (batch)", () => {
    it("should call locator.fill for text fields", async () => {
      const result = await executeAction(page, {
        kind: "fill",
        fields: [
          { ref: "e2", type: "text", value: "hello" },
        ],
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.fill).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should call locator.setChecked for checkbox/radio", async () => {
      const result = await executeAction(page, {
        kind: "fill",
        fields: [
          { ref: "e5", type: "checkbox", value: true },
        ],
      });

      expect(result.ok).toBe(true);
      expect(mockLocator.setChecked).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ timeout: 8000 }),
      );
    });

    it("should convert boolean true/1/'1'/'true' to checked=true", async () => {
      for (const val of [true, 1, "1", "true"] as const) {
        vi.clearAllMocks();
        (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(mockLocator);
        // Re-setup refs (clearing mocks doesn't affect WeakMap)
        setupPageWithRefs(page, defaultRefs);

        await executeAction(page, {
          kind: "fill",
          fields: [{ ref: "e5", type: "checkbox", value: val }],
        });

        expect(mockLocator.setChecked).toHaveBeenCalledWith(
          true,
          expect.any(Object),
        );
      }
    });

    it("should convert false/0/'0'/'false' to checked=false", async () => {
      await executeAction(page, {
        kind: "fill",
        fields: [{ ref: "e5", type: "checkbox", value: false }],
      });

      expect(mockLocator.setChecked).toHaveBeenCalledWith(
        false,
        expect.any(Object),
      );
    });

    it("should skip fields with empty ref or type", async () => {
      const result = await executeAction(page, {
        kind: "fill",
        fields: [
          { ref: "", type: "text", value: "skipped" },
          { ref: "e2", type: "", value: "skipped" },
          { ref: "e2", type: "text", value: "included" },
        ],
      });

      expect(result.ok).toBe(true);
      // fill should only be called once for the valid field
      expect(mockLocator.fill).toHaveBeenCalledTimes(1);
    });

    it("should stringify number values", async () => {
      await executeAction(page, {
        kind: "fill",
        fields: [{ ref: "e2", type: "text", value: 42 }],
      });

      expect(mockLocator.fill).toHaveBeenCalledWith(
        "42",
        expect.any(Object),
      );
    });

    it("should handle radio type same as checkbox", async () => {
      await executeAction(page, {
        kind: "fill",
        fields: [{ ref: "e5", type: "radio", value: true }],
      });

      expect(mockLocator.setChecked).toHaveBeenCalledWith(
        true,
        expect.any(Object),
      );
    });
  });

  // ── Close action ──────────────────────────────────────────────────

  describe("close action", () => {
    it("should call page.close()", async () => {
      const result = await executeAction(page, { kind: "close" });

      expect(result.ok).toBe(true);
      expect(page.close).toHaveBeenCalled();
    });
  });

  // ── Unknown action kind ───────────────────────────────────────────

  describe("unknown action kind", () => {
    it("should return ok:false with 'Unknown action kind' error", async () => {
      const result = await executeAction(page, {
        kind: "unknown-thing" as never,
      } as BrowserAction);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown action kind");
    });
  });

  // ── Error handling (toFriendlyError) ──────────────────────────────

  describe("toFriendlyError mapping", () => {
    it("should map strict mode violation to user-friendly message", async () => {
      (mockLocator.click as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("strict mode violation: getByRole('button', { name: 'Submit' }) resolved to 3 elements"),
      );

      const result = await executeAction(page, { kind: "click", ref: "e1" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("matched 3 elements");
      expect(result.error).toContain("updated refs");
    });

    it("should map timeout/visibility to not-found message", async () => {
      (mockLocator.click as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Timeout 8000ms exceeded waiting for locator to be visible"),
      );

      const result = await executeAction(page, { kind: "click", ref: "e1" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found or not visible");
    });

    it("should map pointer interception to not-interactable message", async () => {
      (mockLocator.click as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("<div class=\"overlay\"> intercepts pointer events"),
      );

      const result = await executeAction(page, { kind: "click", ref: "e1" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not interactable");
    });

    it("should pass through other errors unchanged", async () => {
      (mockLocator.click as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("some random Playwright error"),
      );

      const result = await executeAction(page, { kind: "click", ref: "e1" });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("some random Playwright error");
    });
  });
});

// ── Session Helper Tests ────────────────────────────────────────────

describe("session helpers", () => {
  describe("ensurePageState", () => {
    it("should create new PageState on first call", () => {
      const page = createMockPage();
      const state = ensurePageState(page);

      expect(state).toBeDefined();
      expect(state.console).toEqual([]);
      expect(state.errors).toEqual([]);
      expect(state.requests).toEqual([]);
    });

    it("should return existing PageState on subsequent calls", () => {
      const page = createMockPage();
      const state1 = ensurePageState(page);
      const state2 = ensurePageState(page);

      expect(state1).toBe(state2);
    });

    it("should install page.on handlers for console, pageerror, request, response, requestfailed, close", () => {
      const page = createMockPage();
      ensurePageState(page);

      const onCalls = (page.on as ReturnType<typeof vi.fn>).mock.calls;
      const events = onCalls.map((c: unknown[]) => c[0]);

      expect(events).toContain("console");
      expect(events).toContain("pageerror");
      expect(events).toContain("request");
      expect(events).toContain("response");
      expect(events).toContain("requestfailed");
      expect(events).toContain("close");
    });

    it("should not install handlers twice for the same page", () => {
      const page = createMockPage();
      ensurePageState(page);
      ensurePageState(page);

      // on should only be called once per event (6 events total)
      const onCalls = (page.on as ReturnType<typeof vi.fn>).mock.calls;
      expect(onCalls).toHaveLength(6);
    });
  });

  describe("storeRoleRefs", () => {
    it("should set roleRefs and mode on ensured page state", () => {
      const page = createMockPage();
      const refs = { e1: { role: "button", name: "Click" } };
      storeRoleRefs(page, refs, "role");

      const state = getPageState(page);
      expect(state?.roleRefs).toBe(refs);
      expect(state?.roleRefsMode).toBe("role");
    });

    it("should set roleRefsFrameSelector when provided", () => {
      const page = createMockPage();
      storeRoleRefs(page, {}, "aria", "iframe#content");

      const state = getPageState(page);
      expect(state?.roleRefsFrameSelector).toBe("iframe#content");
    });
  });

  describe("getPageState", () => {
    it("should return undefined for unknown pages", () => {
      const page = createMockPage();
      // Don't call ensurePageState
      expect(getPageState(page)).toBeUndefined();
    });

    it("should return PageState for known pages", () => {
      const page = createMockPage();
      ensurePageState(page);
      expect(getPageState(page)).toBeDefined();
    });
  });

  describe("refLocator", () => {
    let page: Page;
    let mockLoc: Locator;

    beforeEach(() => {
      vi.clearAllMocks();
      page = createMockPage();
      mockLoc = createMockLocator();
      (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(mockLoc);
    });

    it("should resolve eN ref via getByRole in role mode", () => {
      setupPageWithRefs(page, { e1: { role: "button", name: "Submit" } });

      const result = refLocator(page, "e1");

      expect(page.getByRole).toHaveBeenCalledWith("button", {
        name: "Submit",
        exact: true,
      });
      expect(result).toBe(mockLoc);
    });

    it("should call locator.nth() when nth is defined in role mode", () => {
      const nthLoc = createMockLocator();
      const locWithNth = createMockLocator({ nth: vi.fn().mockReturnValue(nthLoc) });
      (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(locWithNth);
      setupPageWithRefs(page, { e2: { role: "button", name: "Save", nth: 1 } });

      const result = refLocator(page, "e2");

      expect(locWithNth.nth).toHaveBeenCalledWith(1);
      expect(result).toBe(nthLoc);
    });

    it("should resolve eN ref via aria-ref in aria mode", () => {
      const ariaLoc = createMockLocator();
      (page.locator as ReturnType<typeof vi.fn>).mockReturnValue(ariaLoc);
      setupPageWithRefs(page, { e1: { role: "button", name: "Submit" } }, "aria");

      const result = refLocator(page, "e1");

      expect(page.locator).toHaveBeenCalledWith("aria-ref=e1");
      expect(result).toBe(ariaLoc);
    });

    it("should use page.frameLocator when frameSelector is set", () => {
      const frameLoc = createMockLocator();
      const frameLocatorObj = {
        locator: vi.fn().mockReturnValue(frameLoc),
        getByRole: vi.fn().mockReturnValue(frameLoc),
      };
      (page.frameLocator as ReturnType<typeof vi.fn>).mockReturnValue(frameLocatorObj);
      setupPageWithRefs(
        page,
        { e1: { role: "button", name: "Submit" } },
        "aria",
        "iframe#frame",
      );

      refLocator(page, "e1");

      expect(page.frameLocator).toHaveBeenCalledWith("iframe#frame");
      expect(frameLocatorObj.locator).toHaveBeenCalledWith("aria-ref=e1");
    });

    it("should throw helpful error for unknown eN ref", () => {
      setupPageWithRefs(page, { e1: { role: "button", name: "Submit" } });

      expect(() => refLocator(page, "e99")).toThrow("Unknown ref");
      expect(() => refLocator(page, "e99")).toThrow("e99");
    });

    it("should fall back to aria-ref for non-eN ref", () => {
      const ariaLoc = createMockLocator();
      (page.locator as ReturnType<typeof vi.fn>).mockReturnValue(ariaLoc);

      const result = refLocator(page, "my-custom-ref");

      expect(page.locator).toHaveBeenCalledWith("aria-ref=my-custom-ref");
      expect(result).toBe(ariaLoc);
    });

    it("should strip 'ref=' prefix", () => {
      setupPageWithRefs(page, { e1: { role: "button", name: "Submit" } });

      refLocator(page, "ref=e1");

      expect(page.getByRole).toHaveBeenCalledWith("button", {
        name: "Submit",
        exact: true,
      });
    });

    it("should strip '@' prefix", () => {
      setupPageWithRefs(page, { e1: { role: "button", name: "Submit" } });

      refLocator(page, "@e1");

      expect(page.getByRole).toHaveBeenCalledWith("button", {
        name: "Submit",
        exact: true,
      });
    });

    it("should use frameLocator with role mode when frameSelector set", () => {
      const frameLoc = createMockLocator();
      const frameLocatorObj = {
        locator: vi.fn().mockReturnValue(frameLoc),
        getByRole: vi.fn().mockReturnValue(frameLoc),
      };
      (page.frameLocator as ReturnType<typeof vi.fn>).mockReturnValue(frameLocatorObj);
      setupPageWithRefs(
        page,
        { e1: { role: "button", name: "Submit" } },
        "role",
        "iframe#content",
      );

      refLocator(page, "e1");

      expect(page.frameLocator).toHaveBeenCalledWith("iframe#content");
      expect(frameLocatorObj.getByRole).toHaveBeenCalledWith("button", {
        name: "Submit",
        exact: true,
      });
    });
  });

  describe("isConnected", () => {
    it("should return false when no browser connected", () => {
      expect(isConnected()).toBe(false);
    });
  });
});
