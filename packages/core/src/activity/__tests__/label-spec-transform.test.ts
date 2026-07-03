// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the optional LabelSpec.transform hook. The hook is an additive
 * override that runs inside applyTemplate AFTER the redacted-substitution
 * pipeline and BEFORE the length
 * cap — its non-empty return wins, an empty return falls through to the
 * substituted label. The transform is also defended in depth by a post-hoc
 * redactValue call (see the defense-in-depth regression-lock test in
 * template-engine.test.ts).
 *
 * This file covers the REGISTRY + RESOLVER concerns:
 *   - the transform field is carried from registration through resolveLabelSpec
 *     onto the resolved LabelSpec,
 *   - mergeActionFields uses the same `next ?? base` precedence as
 *     label/detail/detailKeys (action override wins over tool-level),
 *   - theme-override of transform uses the same precedence (theme wins; when
 *     theme transform is undefined, the registered transform survives).
 *
 * Pure unit tests — no logger, no I/O. The registry is cleared in beforeEach to
 * keep the singleton clean between cases (same pattern as label-spec.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerActivityLabelSpec,
  resolveLabelSpec,
  _clearActivityLabelSpecsForTest,
  type ActivityTheme,
} from "../label-spec.js";

beforeEach(() => {
  _clearActivityLabelSpecsForTest();
});

describe("LabelSpec transform hook", () => {
  it("carries the registered transform through resolveLabelSpec onto the resolved LabelSpec", () => {
    registerActivityLabelSpec("test_tool", {
      semanticPhase: "tool",
      label: "fallback",
      transform: () => "from-transform",
    });

    const resolved = resolveLabelSpec("test_tool");

    expect(resolved.transform).toBeDefined();
    expect(typeof resolved.transform).toBe("function");
    expect(resolved.transform?.({})).toBe("from-transform");
  });

  it("respects mergeActionFields precedence — per-action transform wins over the tool-level transform", () => {
    registerActivityLabelSpec("test_tool", {
      semanticPhase: "tool",
      label: "fallback",
      transform: () => "tool-level",
      actions: {
        run: { transform: () => "action-level" },
      },
    });

    const withAction = resolveLabelSpec("test_tool", { action: "run" });
    const noAction = resolveLabelSpec("test_tool");

    expect(withAction.transform?.({})).toBe("action-level");
    expect(noAction.transform?.({})).toBe("tool-level");
  });

  it("falls through to the tool-level transform when the action has no transform of its own", () => {
    // Asserts mergeActionFields uses `next.transform ?? base.transform` — when
    // the action spec leaves transform undefined, the base (tool-level) survives.
    registerActivityLabelSpec("test_tool", {
      semanticPhase: "tool",
      label: "fallback",
      transform: () => "tool-level",
      actions: {
        run: { label: "running with no transform" },
      },
    });

    const resolved = resolveLabelSpec("test_tool", { action: "run" });

    expect(resolved.label).toBe("running with no transform");
    expect(resolved.transform?.({})).toBe("tool-level");
  });

  it("lets a theme override the registered transform via the same precedence as label/detail", () => {
    registerActivityLabelSpec("test_tool", {
      semanticPhase: "tool",
      label: "fallback",
      transform: () => "registered",
    });
    const theme: ActivityTheme = {
      tools: { test_tool: { transform: () => "theme-override" } },
    };

    const resolved = resolveLabelSpec("test_tool", { theme });

    expect(resolved.transform?.({})).toBe("theme-override");
  });

  it("preserves the registered transform when the theme override leaves transform undefined", () => {
    // Theme overrides ONLY the label — the registered transform must survive
    // (deep-merge per field, never wholesale replacement). Mirrors the
    // existing `deep-merges a theme override of one field while inheriting the
    // registered others` test in label-spec.test.ts.
    registerActivityLabelSpec("test_tool", {
      semanticPhase: "tool",
      label: "registered-label",
      transform: () => "registered-transform",
    });
    const theme: ActivityTheme = {
      tools: { test_tool: { label: "[theme]" } },
    };

    const resolved = resolveLabelSpec("test_tool", { theme });

    expect(resolved.label).toBe("[theme]");
    expect(resolved.transform?.({})).toBe("registered-transform");
  });
});
