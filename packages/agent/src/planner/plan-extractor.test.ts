import { describe, it, expect } from "vitest";
import { extractPlanFromResponse } from "./plan-extractor.js";

describe("extractPlanFromResponse", () => {
  // ---------------------------------------------------------------------------
  // Strategy 1: Numbered lists
  // ---------------------------------------------------------------------------

  it("extracts numbered list with dot separator", () => {
    const text = "I'll help you set up monitoring.\n\n1. Create the config file\n2. Set up webhooks\n3. Configure thresholds";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(3);
    expect(steps![0]).toEqual({ index: 1, description: "Create the config file", status: "pending" });
    expect(steps![1]).toEqual({ index: 2, description: "Set up webhooks", status: "pending" });
    expect(steps![2]).toEqual({ index: 3, description: "Configure thresholds", status: "pending" });
  });

  it("extracts numbered list with parenthesis separator", () => {
    const text = "1) First thing\n2) Second thing";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(2);
    expect(steps![0]!.description).toBe("First thing");
    expect(steps![1]!.description).toBe("Second thing");
  });

  // ---------------------------------------------------------------------------
  // Strategy 2: Markdown bullets
  // ---------------------------------------------------------------------------

  it("extracts markdown bullet list with dashes", () => {
    const text = "Here's what I need to do:\n- Read the configuration\n- Update the settings";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(2);
    expect(steps![0]!.description).toBe("Read the configuration");
    expect(steps![1]!.description).toBe("Update the settings");
  });

  it("extracts markdown bullet list with asterisks", () => {
    const text = "* Check dependencies\n* Install packages\n* Run tests";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Strategy 3: Sequential markers
  // ---------------------------------------------------------------------------

  it("extracts sequential marker patterns", () => {
    const text = "First, I'll check the logs. Then, I'll identify the error. Finally, I'll apply the fix.";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(3);
    expect(steps![0]!.description).toBe("I'll check the logs");
    expect(steps![1]!.description).toBe("I'll identify the error");
    expect(steps![2]!.description).toBe("I'll apply the fix");
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("returns undefined for single-step response", () => {
    const text = "I'll just check the logs for you.";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractPlanFromResponse("", 15)).toBeUndefined();
  });

  it("returns undefined when maxSteps is less than 2", () => {
    const text = "1. First\n2. Second";
    expect(extractPlanFromResponse(text, 1)).toBeUndefined();
  });

  it("truncates to maxSteps when more items found", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n");
    const steps = extractPlanFromResponse(lines, 5);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(5);
    expect(steps![4]!.description).toBe("Step 5");
  });

  it("extracts numbered list embedded in prose paragraphs", () => {
    const text = [
      "Let me help you with that complex request. I'll need to do several things.",
      "",
      "1. Read the current configuration file",
      "2. Identify the settings that need updating",
      "3. Apply the changes",
      "4. Verify everything works",
      "",
      "Let me start with the first step.",
    ].join("\n");
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(4);
    expect(steps![0]!.description).toBe("Read the current configuration file");
    expect(steps![3]!.description).toBe("Verify everything works");
  });

  it("numbered lists take priority over bullets", () => {
    const text = "Plan:\n1. First step\n2. Second step\n\nDetails:\n- Detail A\n- Detail B";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    // Should match numbered list first (strategy 1 priority)
    expect(steps![0]!.description).toBe("First step");
    expect(steps![1]!.description).toBe("Second step");
  });

  it("assigns 1-based indexes", () => {
    const text = "- Alpha\n- Beta\n- Gamma";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    expect(steps![0]!.index).toBe(1);
    expect(steps![1]!.index).toBe(2);
    expect(steps![2]!.index).toBe(3);
  });

  it("all steps start with pending status", () => {
    const text = "1. Do X\n2. Do Y\n3. Do Z";
    const steps = extractPlanFromResponse(text, 15);
    expect(steps).toBeDefined();
    for (const step of steps!) {
      expect(step.status).toBe("pending");
    }
  });

  it("matches conversational bullet summaries (call-site guards against this)", () => {
    // This documents WHY the call-site in executor-prompt-runner.ts gates
    // on stepsExecuted > 0: the regex happily matches non-plan bullets.
    const text = "Got it! Here's what I understand about your preferences:\n- **Super honest**\n- **Accuracy-first**\n- **Short replies**";
    const steps = extractPlanFromResponse(text, 15);
    // The extractor DOES match these — the gate is at the call site
    expect(steps).toBeDefined();
    expect(steps).toHaveLength(3);
  });
});
