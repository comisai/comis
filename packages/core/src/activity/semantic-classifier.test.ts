// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for classifySemanticPhase — the pure tool-name → SemanticPhase mapping.
 * Prefix rules: mcp_* → tool, memory_* →
 * memory, web_search* → web, everything else → tool.
 */
import { describe, it, expect } from "vitest";
import { classifySemanticPhase } from "./semantic-classifier.js";

describe("classifySemanticPhase", () => {
  it("maps an mcp_-prefixed tool name to the tool semantic phase", () => {
    expect(classifySemanticPhase("mcp_manage")).toBe("tool");
    expect(classifySemanticPhase("mcp_resources_read")).toBe("tool");
  });

  it("maps a memory_-prefixed tool name to the memory semantic phase", () => {
    expect(classifySemanticPhase("memory_search")).toBe("memory");
    expect(classifySemanticPhase("memory_store")).toBe("memory");
  });

  it("maps a web_search-prefixed tool name to the web semantic phase", () => {
    expect(classifySemanticPhase("web_search")).toBe("web");
  });

  it("maps a web_search_news-prefixed tool name to web by prefix match", () => {
    // Prefix (not exact) — `web_search_news` and `web_searchx` both start with
    // `web_search` and resolve to web.
    expect(classifySemanticPhase("web_search_news")).toBe("web");
  });

  it("falls back to the tool semantic phase for any unrecognized tool name", () => {
    expect(classifySemanticPhase("anything_else")).toBe("tool");
    expect(classifySemanticPhase("agents_manage")).toBe("tool");
    expect(classifySemanticPhase("")).toBe("tool");
  });
});
