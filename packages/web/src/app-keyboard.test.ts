// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for IcApp keyboard handling, command-palette wiring, skeleton-variant
 * mapping, and view-decision branches.
 *
 * Targets the previously-uncovered range in app.ts:
 *   - _isInputTarget (INPUT/TEXTAREA/SELECT/contentEditable branches)
 *   - _handleGlobalKeydown (Ctrl+K, Escape with palette / shortcuts / sidebar
 *     stack, ?-key, g+letter sequence)
 *   - _handleCommand dispatch table
 *   - _getSkeletonVariant view-tag bucketing
 *   - _renderView happy-path for already-loaded views
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./app.js";
import type { IcApp } from "./app.js";

// Mock sessionStorage so app construction doesn't blow up.
const mockStorage: Record<string, string> = {};
vi.stubGlobal("sessionStorage", {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
});

vi.stubGlobal("fetch", vi.fn());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcApp): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcApp._isInputTarget", () => {
  let el: IcApp;
  beforeEach(() => {
    el = document.createElement("ic-app") as IcApp;
  });
  afterEach(() => {
    if (el.isConnected) document.body.removeChild(el);
  });

  it("returns true when keyboard event target is an INPUT element to skip global shortcuts", () => {
    const input = document.createElement("input");
    const ev = { target: input } as unknown as KeyboardEvent;
    expect(priv(el)._isInputTarget(ev)).toBe(true);
  });

  it("returns true when keyboard event target is a TEXTAREA element to skip global shortcuts", () => {
    const ta = document.createElement("textarea");
    const ev = { target: ta } as unknown as KeyboardEvent;
    expect(priv(el)._isInputTarget(ev)).toBe(true);
  });

  it("returns true when keyboard event target is a SELECT element to skip global shortcuts", () => {
    const sel = document.createElement("select");
    const ev = { target: sel } as unknown as KeyboardEvent;
    expect(priv(el)._isInputTarget(ev)).toBe(true);
  });

  it("returns true when keyboard event target has isContentEditable set true", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true, configurable: true });
    const ev = { target: div } as unknown as KeyboardEvent;
    expect(priv(el)._isInputTarget(ev)).toBe(true);
  });

  it("returns false for regular DIV element so global shortcuts proceed", () => {
    const div = document.createElement("div");
    const ev = { target: div } as unknown as KeyboardEvent;
    expect(priv(el)._isInputTarget(ev)).toBe(false);
  });
});

describe("IcApp._handleGlobalKeydown", () => {
  let el: IcApp;
  beforeEach(() => {
    el = document.createElement("ic-app") as IcApp;
  });
  afterEach(() => {
    if (el.isConnected) document.body.removeChild(el);
  });

  it("toggles command palette on Ctrl+K keydown event preventing default", () => {
    const preventDefault = vi.fn();
    const ev = {
      ctrlKey: true,
      metaKey: false,
      key: "k",
      target: document.body,
      preventDefault,
    } as unknown as KeyboardEvent;
    expect(priv(el)._commandPaletteOpen).toBe(false);
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._commandPaletteOpen).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("toggles command palette on Meta+K keydown event (Mac shortcut)", () => {
    const ev = {
      ctrlKey: false,
      metaKey: true,
      key: "k",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._commandPaletteOpen).toBe(true);
  });

  it("closes the command palette first when Escape is pressed and palette is open", () => {
    priv(el)._commandPaletteOpen = true;
    const ev = {
      key: "Escape",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._commandPaletteOpen).toBe(false);
  });

  it("closes the shortcuts help dialog on Escape when palette is not open", () => {
    priv(el)._shortcutsHelpOpen = true;
    const ev = {
      key: "Escape",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._shortcutsHelpOpen).toBe(false);
  });

  it("closes the sidebar drawer on Escape when neither palette nor shortcuts are open", () => {
    priv(el)._sidebarOpen = true;
    priv(el)._commandPaletteOpen = false;
    priv(el)._shortcutsHelpOpen = false;
    const ev = {
      key: "Escape",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._sidebarOpen).toBe(false);
  });

  it("toggles shortcuts help dialog when ? is pressed without modifier keys", () => {
    const ev = {
      key: "?",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(priv(el)._shortcutsHelpOpen).toBe(false);
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._shortcutsHelpOpen).toBe(true);
  });

  it("does NOT trigger shortcuts when ? is pressed with Ctrl modifier (browser shortcut)", () => {
    const ev = {
      key: "?",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._shortcutsHelpOpen).toBe(false);
  });

  it("starts the G+letter two-key sequence by setting _gotoWaiting on g keydown", () => {
    const ev = {
      key: "g",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(priv(el)._gotoWaiting).toBe(false);
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._gotoWaiting).toBe(true);
  });

  it("ignores key events targeting an INPUT element so typing does not trigger global shortcuts", () => {
    const input = document.createElement("input");
    const ev = {
      key: "?",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: input,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(priv(el)._shortcutsHelpOpen).toBe(false);
  });

  it("ignores ?/g key events when command palette is open since palette handles its own keys", () => {
    priv(el)._commandPaletteOpen = true;
    const ev = {
      key: "?",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    // ? must NOT have toggled shortcuts help because palette consumes the key
    expect(priv(el)._shortcutsHelpOpen).toBe(false);
  });

  it("invokes router.navigate when waiting-for-goto and key 'd' is pressed (dashboard)", () => {
    const navigate = vi.fn();
    priv(el)._router = { navigate };
    priv(el)._gotoWaiting = true;
    const ev = {
      key: "d",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(navigate).toHaveBeenCalledWith("dashboard");
    expect(priv(el)._gotoWaiting).toBe(false);
  });

  it("invokes router.navigate('agents') when waiting-for-goto and key 'a' is pressed", () => {
    const navigate = vi.fn();
    priv(el)._router = { navigate };
    priv(el)._gotoWaiting = true;
    const ev = {
      key: "A", // uppercase tolerated via toLowerCase()
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(navigate).toHaveBeenCalledWith("agents");
  });

  it("invokes router.navigate('chat') when waiting-for-goto and key 'c' is pressed", () => {
    const navigate = vi.fn();
    priv(el)._router = { navigate };
    priv(el)._gotoWaiting = true;
    const ev = {
      key: "c",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(navigate).toHaveBeenCalledWith("chat");
  });

  it("invokes router.navigate('sessions') when waiting-for-goto and key 's' is pressed", () => {
    const navigate = vi.fn();
    priv(el)._router = { navigate };
    priv(el)._gotoWaiting = true;
    const ev = {
      key: "s",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(navigate).toHaveBeenCalledWith("sessions");
  });

  it("invokes router.navigate('observe/overview') when waiting-for-goto and 'o' is pressed", () => {
    const navigate = vi.fn();
    priv(el)._router = { navigate };
    priv(el)._gotoWaiting = true;
    const ev = {
      key: "o",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(navigate).toHaveBeenCalledWith("observe/overview");
  });

  it("resets _gotoWaiting and returns early for unknown letter following g sequence", () => {
    const navigate = vi.fn();
    priv(el)._router = { navigate };
    priv(el)._gotoWaiting = true;
    const ev = {
      key: "z",
      target: document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    priv(el)._handleGlobalKeydown(ev);
    expect(navigate).not.toHaveBeenCalled();
    expect(priv(el)._gotoWaiting).toBe(false);
  });
});

describe("IcApp._handleCommand dispatch table", () => {
  let el: IcApp;
  beforeEach(() => {
    el = document.createElement("ic-app") as IcApp;
  });
  afterEach(() => {
    if (el.isConnected) document.body.removeChild(el);
  });

  it("toggles sidebar open state when command id is 'toggle-sidebar'", () => {
    expect(priv(el)._sidebarOpen).toBe(false);
    priv(el)._handleCommand("toggle-sidebar");
    expect(priv(el)._sidebarOpen).toBe(true);
  });

  it("opens the shortcuts help dialog when command id is 'show-shortcuts'", () => {
    priv(el)._handleCommand("show-shortcuts");
    expect(priv(el)._shortcutsHelpOpen).toBe(true);
  });

  it("ignores unknown command ids without throwing or mutating state", () => {
    const before = JSON.stringify({
      sidebar: priv(el)._sidebarOpen,
      shortcuts: priv(el)._shortcutsHelpOpen,
    });
    expect(() => priv(el)._handleCommand("unrecognized-command")).not.toThrow();
    const after = JSON.stringify({
      sidebar: priv(el)._sidebarOpen,
      shortcuts: priv(el)._shortcutsHelpOpen,
    });
    expect(after).toBe(before);
  });
});

describe("IcApp._getSkeletonVariant view-tag bucketing", () => {
  let el: IcApp;
  beforeEach(() => {
    el = document.createElement("ic-app") as IcApp;
  });
  afterEach(() => {
    if (el.isConnected) document.body.removeChild(el);
  });

  it("returns 'dashboard' variant for ic-dashboard view tag", () => {
    priv(el)._currentView = "ic-dashboard";
    expect(priv(el)._getSkeletonVariant()).toBe("dashboard");
  });

  it("returns 'detail' variant for ic-agent-detail view tag (detail bucket)", () => {
    priv(el)._currentView = "ic-agent-detail";
    expect(priv(el)._getSkeletonVariant()).toBe("detail");
  });

  it("returns 'detail' variant for ic-session-detail view tag (detail bucket)", () => {
    priv(el)._currentView = "ic-session-detail";
    expect(priv(el)._getSkeletonVariant()).toBe("detail");
  });

  it("returns 'detail' variant for ic-channel-detail view tag (detail bucket)", () => {
    priv(el)._currentView = "ic-channel-detail";
    expect(priv(el)._getSkeletonVariant()).toBe("detail");
  });

  it("returns 'detail' variant for ic-chat-console view tag (detail bucket)", () => {
    priv(el)._currentView = "ic-chat-console";
    expect(priv(el)._getSkeletonVariant()).toBe("detail");
  });

  it("returns 'detail' variant for ic-message-center view tag (detail bucket)", () => {
    priv(el)._currentView = "ic-message-center";
    expect(priv(el)._getSkeletonVariant()).toBe("detail");
  });

  it("returns 'editor' variant for ic-config-editor view tag (editor bucket)", () => {
    priv(el)._currentView = "ic-config-editor";
    expect(priv(el)._getSkeletonVariant()).toBe("editor");
  });

  it("returns 'editor' variant for ic-pipeline-builder view tag (editor bucket)", () => {
    priv(el)._currentView = "ic-pipeline-builder";
    expect(priv(el)._getSkeletonVariant()).toBe("editor");
  });

  it("returns 'editor' variant for ic-workspace-manager view tag (editor bucket)", () => {
    priv(el)._currentView = "ic-workspace-manager";
    expect(priv(el)._getSkeletonVariant()).toBe("editor");
  });

  it("returns 'table' variant for ic-billing-view view tag (table bucket)", () => {
    priv(el)._currentView = "ic-billing-view";
    expect(priv(el)._getSkeletonVariant()).toBe("table");
  });

  it("returns 'table' variant for ic-delivery-view view tag (table bucket)", () => {
    priv(el)._currentView = "ic-delivery-view";
    expect(priv(el)._getSkeletonVariant()).toBe("table");
  });

  it("returns 'table' variant for ic-memory-inspector view tag (table bucket)", () => {
    priv(el)._currentView = "ic-memory-inspector";
    expect(priv(el)._getSkeletonVariant()).toBe("table");
  });

  it("returns 'list' variant as default fallback for unrecognized view tags", () => {
    priv(el)._currentView = "ic-some-other-view";
    expect(priv(el)._getSkeletonVariant()).toBe("list");
  });
});

describe("IcApp._renderView happy-path after view-load completes", () => {
  let el: IcApp;
  beforeEach(() => {
    el = document.createElement("ic-app") as IcApp;
  });
  afterEach(() => {
    if (el.isConnected) document.body.removeChild(el);
  });

  // Pre-mark every lazy view as loaded so the switch hits the real branch.
  function preload(viewTag: string): void {
    priv(el)._loadedViews.add(viewTag);
    priv(el)._currentView = viewTag;
  }

  it("renders the agent-list view template after loading completes without throwing", () => {
    preload("ic-agent-list");
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the chat-console view template with a conversation reference", () => {
    preload("ic-chat-console");
    priv(el)._routeParams = { conversationRef: "conversation-a" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the agent-detail view template with the routeParams.id forwarded", () => {
    preload("ic-agent-detail");
    priv(el)._routeParams = { id: "alpha" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the channel-detail view template with routeParams.type forwarded", () => {
    preload("ic-channel-detail");
    priv(el)._routeParams = { type: "telegram" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the session-detail view template with its conversation reference", () => {
    preload("ic-session-detail");
    priv(el)._routeParams = { conversationRef: "session-k1" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the pipeline-builder view template with routeParams.graphId forwarded", () => {
    preload("ic-pipeline-builder");
    priv(el)._routeParams = { graphId: "g-7" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the observe-dashboard view template with default 'overview' tab", () => {
    preload("ic-observe-dashboard");
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the scheduler-view template with routeParams passthrough", () => {
    preload("ic-scheduler-view");
    priv(el)._routeParams = { jobId: "job-1" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });

  it("renders the message-center view template with routeParams.type forwarded", () => {
    preload("ic-message-center");
    priv(el)._routeParams = { type: "discord" };
    expect(() => priv(el)._renderView()).not.toThrow();
  });
});

describe("IcApp.renderShortcutsHelp", () => {
  let el: IcApp;
  beforeEach(() => {
    el = document.createElement("ic-app") as IcApp;
  });
  afterEach(() => {
    if (el.isConnected) document.body.removeChild(el);
  });

  it("renders a dialog with shortcuts table when _renderShortcutsHelp is invoked", () => {
    const result = priv(el)._renderShortcutsHelp();
    expect(result).toBeDefined();
  });
});
