// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { interpolateTaskText, buildContextEnvelope } from "./template-interpolation.js";

// ---------------------------------------------------------------------------
// interpolateTaskText
// ---------------------------------------------------------------------------

describe("interpolateTaskText", () => {
  it("returns task text unchanged when dependsOn is empty", () => {
    const text = "Do the thing with {{analyzer.result}}";
    const result = interpolateTaskText(text, [], new Map());
    expect(result).toBe(text);
  });

  it("replaces single template variable with upstream output", () => {
    const result = interpolateTaskText(
      "Summarize: {{analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", "The analysis shows high correlation"]]),
    );
    expect(result).toBe("Summarize: The analysis shows high correlation");
  });

  it("replaces multiple template variables from different upstream nodes", () => {
    const result = interpolateTaskText(
      "Compare {{nodeA.result}} with {{nodeB.result}}",
      ["nodeA", "nodeB"],
      new Map([
        ["nodeA", "Result from A"],
        ["nodeB", "Result from B"],
      ]),
    );
    expect(result).toBe("Compare Result from A with Result from B");
  });

  it("replaces multiple occurrences of the same variable", () => {
    const result = interpolateTaskText(
      "First: {{analyzer.result}} and again: {{analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", "duplicated output"]]),
    );
    expect(result).toBe("First: duplicated output and again: duplicated output");
  });

  it("uses unavailable placeholder for undefined output (node did not complete)", () => {
    const result = interpolateTaskText(
      "Use: {{analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", undefined]]),
    );
    expect(result).toBe('Use: [unavailable: node "analyzer" did not complete]');
  });

  it("uses empty string for empty output (empty is valid)", () => {
    const result = interpolateTaskText(
      "Result: {{fetch.result}} end",
      ["fetch"],
      new Map([["fetch", ""]]),
    );
    expect(result).toBe("Result:  end");
  });

  it("truncates output exceeding maxResultLength", () => {
    const longOutput = "x".repeat(5000);
    const result = interpolateTaskText(
      "Here: {{src.result}}",
      ["src"],
      new Map([["src", longOutput]]),
      100,
    );
    expect(result).toBe("Here: " + "x".repeat(100) + "... [truncated]");
    // Must not contain characters beyond position 100 of the original
    expect(result).not.toContain("x".repeat(101));
  });

  it("uses default maxResultLength of 12000", () => {
    const longOutput = "y".repeat(13000);
    const result = interpolateTaskText(
      "{{src.result}}",
      ["src"],
      new Map([["src", longOutput]]),
    );
    expect(result).toBe("y".repeat(12000) + "... [truncated]");
  });

  it("does not truncate output at exactly maxResultLength", () => {
    const exactOutput = "z".repeat(100);
    const result = interpolateTaskText(
      "{{src.result}}",
      ["src"],
      new Map([["src", exactOutput]]),
      100,
    );
    expect(result).toBe("z".repeat(100));
    expect(result).not.toContain("[truncated]");
  });

  it("handles special regex characters in variable names", () => {
    const result = interpolateTaskText(
      "Use: {{node$1.result}}",
      ["node$1"],
      new Map([["node$1", "special output"]]),
    );
    expect(result).toBe("Use: special output");
  });

  it("does not re-expand templates in node outputs", () => {
    // Node A's output itself contains a template pattern
    const result = interpolateTaskText(
      "A says: {{nodeA.result}} and B says: {{nodeB.result}}",
      ["nodeA", "nodeB"],
      new Map([
        ["nodeA", "A output contains {{nodeB.result}} literally"],
        ["nodeB", "B output"],
      ]),
    );
    // The {{nodeB.result}} inside A's output should NOT be expanded further
    expect(result).toBe(
      "A says: A output contains {{nodeB.result}} literally and B says: B output",
    );
  });

  it("leaves unmatched template patterns intact", () => {
    const result = interpolateTaskText(
      "Known: {{analyzer.result}} Unknown: {{unknown.result}}",
      ["analyzer"],
      new Map([["analyzer", "known value"]]),
    );
    expect(result).toBe("Known: known value Unknown: {{unknown.result}}");
  });

  it("is case-sensitive for variable names", () => {
    const result = interpolateTaskText(
      "Lower: {{analyzer.result}} Upper: {{Analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", "matched"]]),
    );
    // Only lowercase should match
    expect(result).toBe("Lower: matched Upper: {{Analyzer.result}}");
  });

  it("includes file reference in truncation when sharedDir is provided", () => {
    const longOutput = "x".repeat(200);
    const result = interpolateTaskText(
      "Here: {{src.result}}",
      ["src"],
      new Map([["src", longOutput]]),
      100,
      "/tmp/graph-runs/abc123",
    );
    expect(result).toBe(
      "Here: " + "x".repeat(100) + "... [truncated -- full output: /tmp/graph-runs/abc123/src-output.md]"
    );
  });

  it("uses plain truncation suffix when sharedDir is not provided", () => {
    const longOutput = "x".repeat(200);
    const result = interpolateTaskText(
      "Here: {{src.result}}",
      ["src"],
      new Map([["src", longOutput]]),
      100,
    );
    expect(result).toBe("Here: " + "x".repeat(100) + "... [truncated]");
    expect(result).not.toContain("full output:");
  });

  it("handles nodeIds with hyphens", () => {
    const result = interpolateTaskText(
      "Use: {{data-fetcher.result}}",
      ["data-fetcher"],
      new Map([["data-fetcher", "fetched data"]]),
    );
    expect(result).toBe("Use: fetched data");
  });

  // --- contextMode="refs" tests ---

  it("contextMode refs with sharedDir replaces template with file reference", () => {
    const result = interpolateTaskText(
      "Use: {{analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", "Some long analysis output"]]),
      12000,
      "/tmp/graph-runs/abc123",
      "refs",
    );
    expect(result).toBe("Use: [See: /tmp/graph-runs/abc123/analyzer-output.md]");
  });

  it("contextMode refs without sharedDir uses fallback text", () => {
    const result = interpolateTaskText(
      "Use: {{analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", "Some output"]]),
      12000,
      undefined,
      "refs",
    );
    expect(result).toBe('Use: [See upstream output for "analyzer" in shared pipeline folder]');
  });

  it("contextMode refs with undefined output uses unavailable placeholder", () => {
    const result = interpolateTaskText(
      "Use: {{analyzer.result}}",
      ["analyzer"],
      new Map([["analyzer", undefined]]),
      12000,
      "/tmp/graph-runs/abc123",
      "refs",
    );
    expect(result).toBe('Use: [unavailable: node "analyzer" did not complete]');
  });

  it("contextMode full or omitted behaves identically to current behavior", () => {
    const outputs = new Map([["analyzer", "The analysis shows correlation"]]);

    // Omitted (backward compat)
    const resultOmitted = interpolateTaskText(
      "Summarize: {{analyzer.result}}",
      ["analyzer"],
      outputs,
    );
    expect(resultOmitted).toBe("Summarize: The analysis shows correlation");

    // Explicit full
    const resultFull = interpolateTaskText(
      "Summarize: {{analyzer.result}}",
      ["analyzer"],
      outputs,
      12000,
      undefined,
      "full",
    );
    expect(resultFull).toBe("Summarize: The analysis shows correlation");
  });
});

// ---------------------------------------------------------------------------
// buildContextEnvelope
// ---------------------------------------------------------------------------

describe("buildContextEnvelope", () => {
  it("shows root node text when no dependencies", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test Graph",
      nodeId: "root",
      task: "Do the first thing",
      originalTask: "Do the first thing",
      dependsOn: [],
      nodeOutputs: new Map(),
      totalNodeCount: 3,
    });

    expect(result).toContain("## Graph Context");
    expect(result).toContain('You are node "root" in a 3-node execution graph.');
    expect(result).toContain("root node (no upstream dependencies)");
    expect(result).toContain("## Your Task");
    expect(result).toContain("Do the first thing");
    // Root nodes should NOT have upstream outputs section
    expect(result).not.toContain("Output from");
  });

  it("includes upstream output from a single dependency", () => {
    const result = buildContextEnvelope({
      graphLabel: "Pipeline",
      nodeId: "B",
      task: "Summarize the findings",
      originalTask: "Summarize the findings",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", "Findings from node A"]]),
      totalNodeCount: 2,
    });

    expect(result).toContain('### Output from "A"');
    expect(result).toContain("Findings from node A");
    expect(result).toContain("Upstream dependencies: A");
    expect(result).toContain("## Your Task");
    expect(result).toContain("Summarize the findings");
  });

  it("shows available outputs and placeholder for missing ones", () => {
    const result = buildContextEnvelope({
      graphLabel: "Multi-dep",
      nodeId: "C",
      task: "Merge everything",
      originalTask: "Merge everything",
      dependsOn: ["A", "B", "D"],
      nodeOutputs: new Map<string, string | undefined>([
        ["A", "Output from A"],
        ["B", undefined],
        // D not in map at all
      ]),
      totalNodeCount: 4,
    });

    expect(result).toContain('### Output from "A"');
    expect(result).toContain("Output from A");
    expect(result).toContain('### Output from "B"');
    expect(result).toContain("[no output available]");
    expect(result).toContain('### Output from "D"');
    // D is not in the map -- should also show no output available
    const dSection = result.split('### Output from "D"')[1]!;
    expect(dSection).toContain("[no output available]");
  });

  it('shows "Unnamed Graph" when graphLabel is undefined', () => {
    const result = buildContextEnvelope({
      graphLabel: undefined,
      nodeId: "X",
      task: "Do something",
      originalTask: "Do something",
      dependsOn: [],
      nodeOutputs: new Map(),
      totalNodeCount: 1,
    });

    expect(result).toContain("Unnamed Graph");
  });

  it("shows the provided graph label", () => {
    const result = buildContextEnvelope({
      graphLabel: "My Pipeline",
      nodeId: "X",
      task: "Do something",
      originalTask: "Do something",
      dependsOn: [],
      nodeOutputs: new Map(),
      totalNodeCount: 1,
    });

    expect(result).toContain("My Pipeline");
    expect(result).not.toContain("Unnamed Graph");
  });

  it("truncates long upstream output with suffix", () => {
    const longOutput = "a".repeat(5000);
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Summarize",
      originalTask: "Summarize",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", longOutput]]),
      totalNodeCount: 2,
      maxResultLength: 100,
    });

    expect(result).toContain("a".repeat(100) + "... [truncated]");
    expect(result).not.toContain("a".repeat(101));
  });

  it("includes file reference in truncation when sharedDir is provided", () => {
    const longOutput = "a".repeat(5000);
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Summarize",
      originalTask: "Summarize",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", longOutput]]),
      totalNodeCount: 2,
      maxResultLength: 100,
      sharedDir: "/tmp/graph-runs/abc123",
    });

    expect(result).toContain("a".repeat(100) + "... [truncated -- full output: /tmp/graph-runs/abc123/A-output.md]");
    expect(result).not.toContain("a".repeat(101));
  });

  it("uses plain truncation suffix when sharedDir is not provided", () => {
    const longOutput = "a".repeat(5000);
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Summarize",
      originalTask: "Summarize",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", longOutput]]),
      totalNodeCount: 2,
      maxResultLength: 100,
    });

    expect(result).toContain("a".repeat(100) + "... [truncated]");
    expect(result).not.toContain("full output:");
  });

  it("includes task text verbatim under Your Task heading", () => {
    const taskText = "This is a multi-line task.\nWith detailed instructions.\nDo it well.";
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "N1",
      task: taskText,
      originalTask: taskText,
      dependsOn: [],
      nodeOutputs: new Map(),
      totalNodeCount: 1,
    });

    const taskSection = result.split("## Your Task\n")[1]!;
    expect(taskSection).toContain(taskText);
  });

  // --- New dedup tests ---

  it("skips Output from section for deps already referenced inline via template", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Summarize: The analysis result here",
      originalTask: "Summarize: {{A.result}}",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", "The analysis result here"]]),
      totalNodeCount: 2,
    });

    // The Output from section should be skipped since A was referenced inline
    expect(result).not.toContain('### Output from "A"');
    expect(result).toContain("## Your Task");
    expect(result).toContain("Summarize: The analysis result here");
  });

  it("includes Output from section for deps NOT referenced inline", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Do something",
      originalTask: "Do something",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", "Upstream output"]]),
      totalNodeCount: 2,
    });

    // A was not referenced inline, so its output section should be included
    expect(result).toContain('### Output from "A"');
    expect(result).toContain("Upstream output");
  });

  it("mixed case: some deps referenced inline, some not", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "C",
      task: "Analyze: inline result. Also consider other context.",
      originalTask: "Analyze: {{A.result}}. Also consider other context.",
      dependsOn: ["A", "B"],
      nodeOutputs: new Map([
        ["A", "inline result"],
        ["B", "context from B"],
      ]),
      totalNodeCount: 3,
    });

    // A was referenced inline -- skip its output section
    expect(result).not.toContain('### Output from "A"');
    // B was NOT referenced inline -- include its output section
    expect(result).toContain('### Output from "B"');
    expect(result).toContain("context from B");
  });

  // --- Shared pipeline folder hint tests ---

  it("includes upstream file hint in shared pipeline folder section", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Summarize",
      originalTask: "Summarize",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", "Some output"]]),
      totalNodeCount: 2,
      sharedDir: "/tmp/graph-runs/abc123",
    });

    expect(result).toContain("## Shared Pipeline Folder");
    expect(result).toContain("Path: /tmp/graph-runs/abc123");
    expect(result).toContain("Your output is captured automatically");
    expect(result).toContain("Check this folder for additional context");
  });

  it("does not include pipeline folder hint when sharedDir is not provided", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "B",
      task: "Summarize",
      originalTask: "Summarize",
      dependsOn: ["A"],
      nodeOutputs: new Map([["A", "Some output"]]),
      totalNodeCount: 2,
    });

    expect(result).not.toContain("Shared Pipeline Folder");
    expect(result).not.toContain("Your output is captured automatically");
  });

  // --- contextMode tests ---

  describe("buildContextEnvelope contextMode", () => {
    it("full mode (default) includes complete upstream outputs", () => {
      const longOutput = "x".repeat(2000);
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", longOutput]]),
        totalNodeCount: 2,
        maxResultLength: 12000,
      });

      expect(result).toContain('### Output from "A"');
      expect(result).toContain(longOutput);
      expect(result).not.toContain("[truncated]");
    });

    it("summary mode truncates upstream outputs to 500 chars with shared dir reference", () => {
      const longOutput = "y".repeat(1000);
      const shortOutput = "short";
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Merge results",
        originalTask: "Merge results",
        dependsOn: ["A", "B"],
        nodeOutputs: new Map([
          ["A", longOutput],
          ["B", shortOutput],
        ]),
        totalNodeCount: 3,
        maxResultLength: 12000,
        sharedDir: "/tmp/graph-runs/abc123",
        contextMode: "summary",
      });

      // Long output should be truncated to 500 chars
      expect(result).toContain('### Output from "A"');
      expect(result).toContain("y".repeat(500));
      expect(result).not.toContain("y".repeat(501));
      expect(result).toContain("truncated -- full output: /tmp/graph-runs/abc123/A-output.md");

      // Short output under 500 chars should NOT be truncated
      expect(result).toContain('### Output from "B"');
      expect(result).toContain("short");
      expect(result).not.toContain("B-output.md");
    });

    it("none mode skips upstream output sections entirely", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Do something independently",
        originalTask: "Do something independently",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Upstream data that should be hidden"]]),
        totalNodeCount: 2,
        contextMode: "none",
      });

      // No output sections
      expect(result).not.toContain('### Output from "A"');
      expect(result).not.toContain("Upstream data that should be hidden");

      // Graph context header still present
      expect(result).toContain("## Graph Context");

      // DAG position info still present
      expect(result).toContain("Upstream dependencies: A");

      // Task section still present
      expect(result).toContain("## Your Task");
      expect(result).toContain("Do something independently");
    });
  });

  // --- Degradation notice tests ---

  describe("buildContextEnvelope degradation notice", () => {
    it("renders degradation notice for failed upstream nodes", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Do the merge",
        originalTask: "Do the merge",
        dependsOn: ["A", "B"],
        nodeOutputs: new Map([["A", "Output A"]]),
        totalNodeCount: 3,
        failedUpstream: ["nodeA"],
        skippedUpstream: [],
      });

      expect(result).toContain("## Degraded Input");
      expect(result).toContain("**nodeA**: FAILED");
      expect(result).toContain("Proceed with the data available");
    });

    it("renders degradation notice for skipped upstream nodes", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Do the merge",
        originalTask: "Do the merge",
        dependsOn: ["A", "B"],
        nodeOutputs: new Map([["A", "Output A"]]),
        totalNodeCount: 3,
        failedUpstream: [],
        skippedUpstream: ["nodeB"],
      });

      expect(result).toContain("## Degraded Input");
      expect(result).toContain("**nodeB**: SKIPPED");
    });

    it("renders both failed and skipped upstream nodes", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Do the merge",
        originalTask: "Do the merge",
        dependsOn: ["A", "B"],
        nodeOutputs: new Map([["A", "Output A"]]),
        totalNodeCount: 3,
        failedUpstream: ["A"],
        skippedUpstream: ["B"],
      });

      expect(result).toContain("**A**: FAILED");
      expect(result).toContain("**B**: SKIPPED");
    });

    it("omits degradation section when no failed or skipped upstream (backward compatible)", () => {
      // Without params
      const result1 = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Output A"]]),
        totalNodeCount: 2,
      });
      expect(result1).not.toContain("## Degraded Input");

      // With empty arrays
      const result2 = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Output A"]]),
        totalNodeCount: 2,
        failedUpstream: [],
        skippedUpstream: [],
      });
      expect(result2).not.toContain("## Degraded Input");
    });

    it("degradation section appears before Your Task section", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Do the merge",
        originalTask: "Do the merge",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Output A"]]),
        totalNodeCount: 2,
        failedUpstream: ["X"],
      });

      expect(result.indexOf("## Degraded Input")).toBeLessThan(result.indexOf("## Your Task"));
    });
  });

  // --- contextMode refs tests ---

  describe("buildContextEnvelope contextMode refs", () => {
    it("refs mode with sharedDir emits file references instead of inline content", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Long upstream output that should not appear inline"]]),
        totalNodeCount: 2,
        sharedDir: "/tmp/graph-runs/abc123",
        contextMode: "refs",
      });

      expect(result).toContain('### Output from "A"');
      expect(result).toContain("See: /tmp/graph-runs/abc123/A-output.md");
      expect(result).not.toContain("Long upstream output that should not appear inline");
    });

    it("refs mode without sharedDir emits fallback text", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Some output"]]),
        totalNodeCount: 2,
        contextMode: "refs",
      });

      expect(result).toContain('### Output from "A"');
      expect(result).toContain("[See upstream output in shared pipeline folder]");
      expect(result).not.toContain("Some output");
    });

    it("refs mode still includes Graph Context header and DAG position", () => {
      const result = buildContextEnvelope({
        graphLabel: "My Pipeline",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Output"]]),
        totalNodeCount: 3,
        sharedDir: "/tmp/shared",
        contextMode: "refs",
      });

      expect(result).toContain("## Graph Context");
      expect(result).toContain("**Graph:** My Pipeline");
      expect(result).toContain('You are node "B" in a 3-node execution graph.');
      expect(result).toContain("Upstream dependencies: A");
    });

    it("refs mode still includes Shared Pipeline Folder section", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map([["A", "Output"]]),
        totalNodeCount: 2,
        sharedDir: "/tmp/graph-runs/abc123",
        contextMode: "refs",
      });

      expect(result).toContain("## Shared Pipeline Folder");
      expect(result).toContain("Path: /tmp/graph-runs/abc123");
    });

    it("refs mode skips deps already referenced inline via template", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize: inline content here",
        originalTask: "Summarize: {{A.result}}",
        dependsOn: ["A", "C"],
        nodeOutputs: new Map([
          ["A", "inline content here"],
          ["C", "Other output"],
        ]),
        totalNodeCount: 3,
        sharedDir: "/tmp/shared",
        contextMode: "refs",
      });

      // A was referenced inline -- skip
      expect(result).not.toContain('### Output from "A"');
      // C was NOT referenced inline -- include as ref
      expect(result).toContain('### Output from "C"');
      expect(result).toContain("See: /tmp/shared/C-output.md");
    });

    it("refs mode with undefined output shows no-output placeholder", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "B",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A"],
        nodeOutputs: new Map<string, string | undefined>([["A", undefined]]),
        totalNodeCount: 2,
        sharedDir: "/tmp/shared",
        contextMode: "refs",
      });

      expect(result).toContain('### Output from "A"');
      expect(result).toContain("[no output available]");
    });

    it("refs mode still includes degradation notices (failedUpstream/skippedUpstream)", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Summarize",
        originalTask: "Summarize",
        dependsOn: ["A", "B"],
        nodeOutputs: new Map([
          ["A", "Output A"],
          ["B", "Output B"],
        ]),
        totalNodeCount: 3,
        sharedDir: "/tmp/shared",
        contextMode: "refs",
        failedUpstream: ["X"],
        skippedUpstream: ["Y"],
      });

      expect(result).toContain("See: /tmp/shared/A-output.md");
      expect(result).toContain("See: /tmp/shared/B-output.md");
    });
  });

  // --- Visible-text output instruction test ---

  it("includes visible-text output instruction after task section", () => {
    const result = buildContextEnvelope({
      graphLabel: "Test",
      nodeId: "A",
      task: "Analyze the data",
      originalTask: "Analyze the data",
      dependsOn: [],
      nodeOutputs: new Map(),
      totalNodeCount: 1,
    });

    expect(result).toContain("IMPORTANT: Your final response MUST contain visible text content");
    // Instruction appears AFTER the task text
    const taskIdx = result.indexOf("## Your Task");
    const instructionIdx = result.indexOf("IMPORTANT: Your final response MUST");
    expect(instructionIdx).toBeGreaterThan(taskIdx);
  });

  // --- Deterministic dependsOn ordering tests ---

  describe("deterministic dependsOn ordering", () => {
    it("produces output sections in alphabetical order regardless of input order", () => {
      const result = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Merge results",
        originalTask: "Merge results",
        dependsOn: ["z_node", "a_node"],
        nodeOutputs: new Map([
          ["z_node", "Z output"],
          ["a_node", "A output"],
        ]),
        totalNodeCount: 3,
      });

      const aIdx = result.indexOf('### Output from "a_node"');
      const zIdx = result.indexOf('### Output from "z_node"');
      expect(aIdx).toBeGreaterThan(-1);
      expect(zIdx).toBeGreaterThan(-1);
      expect(aIdx).toBeLessThan(zIdx);
    });

    it("sibling nodes with reversed dependsOn produce identical output strings", () => {
      const outputs = new Map([
        ["z_node", "Z output"],
        ["a_node", "A output"],
      ]);

      const result1 = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Merge results",
        originalTask: "Merge results",
        dependsOn: ["z_node", "a_node"],
        nodeOutputs: outputs,
        totalNodeCount: 3,
      });

      const result2 = buildContextEnvelope({
        graphLabel: "Test",
        nodeId: "C",
        task: "Merge results",
        originalTask: "Merge results",
        dependsOn: ["a_node", "z_node"],
        nodeOutputs: outputs,
        totalNodeCount: 3,
      });

      expect(result1).toBe(result2);
    });

    it("interpolateTaskText applies replacements correctly regardless of dependsOn order", () => {
      const outputs = new Map([
        ["z_node", "Z result"],
        ["a_node", "A result"],
      ]);

      const result1 = interpolateTaskText(
        "Use {{a_node.result}} and {{z_node.result}}",
        ["z_node", "a_node"],
        outputs,
      );

      const result2 = interpolateTaskText(
        "Use {{a_node.result}} and {{z_node.result}}",
        ["a_node", "z_node"],
        outputs,
      );

      expect(result1).toBe("Use A result and Z result");
      expect(result2).toBe("Use A result and Z result");
    });
  });
});
