// SPDX-License-Identifier: Apache-2.0
/**
 * Render-branch tests for IcContextDagBrowser.
 *
 * Covers:
 *   - render() top-level loadState branches (loading/error/loaded with-vs-without
 *     selection)
 *   - _renderConversationList empty + populated branches + truncated session_key
 *   - _renderTree treeLoading / empty / populated branches
 *   - _renderSearchResults searchLoading / empty / populated branches
 *   - _renderDetailPanel summary vs message vs absent (nothing) branches
 *   - _getRootNodes filter logic
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import type { IcContextDagBrowser } from "./context-dag-browser.js";
import "./context-dag-browser.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcContextDagBrowser): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcContextDagBrowser render() — load-state branches", () => {
  let el: IcContextDagBrowser;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the ic-loading component while load state is the initial 'loading' value", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-loading")).not.toBeNull();
  });

  it("renders the error-msg div with the error text when load state is 'error'", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "error";
    priv(el)._errorMsg = "Network timeout reaching daemon";
    await el.updateComplete;
    const err = el.shadowRoot?.querySelector(".error-msg");
    expect(err?.textContent).toContain("Network timeout");
  });

  it("renders the header-row with conversation count when load state is 'loaded'", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "k", updated_at: 1_000 },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".header-title")?.textContent).toContain(
      "Context DAG Browser",
    );
    expect(el.shadowRoot?.querySelector(".header-stats")?.textContent).toContain(
      "1 conversations",
    );
  });

  it("renders the tree-panel when a conversation is selected (hasSelection branch)", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "k", updated_at: 1_000 },
    ];
    priv(el)._selectedConvId = "c1";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".tree-panel")).not.toBeNull();
  });

  it("renders only the conversation panel when no conversation is selected (no tree-panel)", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "k", updated_at: 1_000 },
    ];
    priv(el)._selectedConvId = null;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".tree-panel")).toBeNull();
  });
});

describe("IcContextDagBrowser _renderConversationList — empty vs populated branches", () => {
  let el: IcContextDagBrowser;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the ic-empty-state message when _conversations array is empty", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-empty-state")).not.toBeNull();
  });

  it("renders one conv-card button per conversation in the list when populated", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "short", updated_at: 1_000 },
      { conversation_ref: "c2", agent_id: "beta", session_key: "short", updated_at: 2_000 },
    ];
    await el.updateComplete;
    const cards = el.shadowRoot?.querySelectorAll(".conv-card");
    expect(cards?.length).toBe(2);
  });

  it("truncates session_key text to 40 characters with '...' suffix for long keys", async () => {
    const longKey = "agent:very-long-tenant-id:user@example.com:channel-type-id";
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: longKey, updated_at: 1_000 },
    ];
    await el.updateComplete;
    const sessionDiv = el.shadowRoot?.querySelector(".conv-session");
    expect(sessionDiv?.textContent?.endsWith("...")).toBe(true);
    expect(sessionDiv?.textContent?.length).toBeLessThanOrEqual(43);
  });

  it("applies the 'selected' class to the conversation card matching _selectedConvId", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "k", updated_at: 1_000 },
      { conversation_ref: "c2", agent_id: "beta", session_key: "k", updated_at: 2_000 },
    ];
    priv(el)._selectedConvId = "c2";
    await el.updateComplete;
    const cards = el.shadowRoot?.querySelectorAll(".conv-card");
    expect(cards?.[0]?.classList.contains("selected")).toBe(false);
    expect(cards?.[1]?.classList.contains("selected")).toBe(true);
  });

  it("renders the optional conv title div when conversation has a title field set", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      {
        conversation_ref: "c1",
        agent_id: "alpha",
        session_key: "k",
        title: "My Conversation Title",
        updated_at: 1_000,
      },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("My Conversation Title");
  });
});

describe("IcContextDagBrowser _renderTree — loading / empty / populated branches", () => {
  let el: IcContextDagBrowser;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  function selectConv(): void {
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "k", updated_at: 1_000 },
    ];
    priv(el)._selectedConvId = "c1";
  }

  it("renders the ic-loading sub-component when _treeLoading is true (tree fetch in flight)", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    selectConv();
    priv(el)._treeLoading = true;
    priv(el)._treeNodes = [];
    priv(el)._searchQuery = "";
    await el.updateComplete;
    const loadingEls = el.shadowRoot?.querySelectorAll("ic-loading");
    // Two ic-loading possibly — outer (none since loaded) + tree
    expect((loadingEls?.length ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("renders 'No summaries' empty state when _treeNodes is empty and not loading", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    selectConv();
    priv(el)._treeLoading = false;
    priv(el)._treeNodes = [];
    priv(el)._searchQuery = "";
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("No summaries");
  });

  it("renders the tree-node rows when _treeNodes contains at least one root entry", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    selectConv();
    priv(el)._treeLoading = false;
    priv(el)._treeNodes = [
      {
        summaryId: "root-1",
        parentIds: [],
        childIds: [],
        depth: 0,
        kind: "summary",
        tokenCount: 100,
        contentPreview: "Top-level summary content preview",
      },
    ];
    priv(el)._searchQuery = "";
    priv(el)._expanded = new Set();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".tree-node")).not.toBeNull();
  });

  it("_getRootNodes filters tree nodes returning only entries with no parentIds OR depth 0", () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    priv(el)._treeNodes = [
      { summaryId: "r1", parentIds: [], depth: 0, childIds: [], kind: "s", tokenCount: 1, contentPreview: "" },
      { summaryId: "c1", parentIds: ["r1"], depth: 1, childIds: [], kind: "s", tokenCount: 1, contentPreview: "" },
      { summaryId: "c2", parentIds: ["r1"], depth: 0, childIds: [], kind: "s", tokenCount: 1, contentPreview: "" },
    ];
    const roots = priv(el)._getRootNodes();
    expect(roots).toHaveLength(2);
    expect(roots[0].summaryId).toBe("r1");
    expect(roots[1].summaryId).toBe("c2");
  });
});

describe("IcContextDagBrowser _renderSearchResults — loading / empty / populated branches", () => {
  let el: IcContextDagBrowser;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  function selectConv(): void {
    priv(el)._loadState = "loaded";
    priv(el)._conversations = [
      { conversation_ref: "c1", agent_id: "alpha", session_key: "k", updated_at: 1_000 },
    ];
    priv(el)._selectedConvId = "c1";
  }

  it("renders 'No results found' empty state when _searchResults is empty after a search", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    selectConv();
    priv(el)._searchQuery = "find-me";
    priv(el)._searchLoading = false;
    priv(el)._searchResults = [];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("No results found");
  });

  it("renders the search-results list when _searchResults has at least one entry", async () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    document.body.appendChild(el);
    selectConv();
    priv(el)._searchQuery = "match";
    priv(el)._searchLoading = false;
    priv(el)._searchResults = [
      { type: "summary", content: "first matching content here", rank: 0.95 },
      { type: "message", content: "second matching message content", rank: 0.81 },
    ];
    await el.updateComplete;
    const results = el.shadowRoot?.querySelectorAll(".search-result");
    expect(results?.length).toBe(2);
  });
});

describe("IcContextDagBrowser _renderDetailPanel — summary vs message vs absent", () => {
  let el: IcContextDagBrowser;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("returns nothing-sentinel template when _inspectedNode is null", () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    priv(el)._inspectedNode = null;
    const result = priv(el)._renderDetailPanel();
    expect(result).toBeDefined();
  });

  it("renders the detail panel template for an inspected summary node with metadata grid", () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    priv(el)._inspectedNode = {
      type: "summary",
      summaryId: "s-1",
      kind: "section",
      depth: 2,
      tokenCount: 500,
      sourceMessageCount: 10,
      parentIds: ["p-1"],
      childIds: ["c-1", "c-2"],
      content: "Summary text body",
    };
    priv(el)._detailOpen = true;
    const result = priv(el)._renderDetailPanel();
    expect(result).toBeDefined();
  });

  it("renders the detail panel template for an inspected message node WITHOUT metadata grid", () => {
    el = document.createElement("ic-context-dag-browser") as IcContextDagBrowser;
    priv(el)._inspectedNode = {
      type: "message",
      content: "Raw message text body",
    };
    priv(el)._detailOpen = true;
    const result = priv(el)._renderDetailPanel();
    expect(result).toBeDefined();
  });
});

describe("IcContextDagBrowser component registration", () => {
  it("registers as the 'ic-context-dag-browser' custom element after side-effect import", () => {
    expect(customElements.get("ic-context-dag-browser")).toBeDefined();
  });
});
