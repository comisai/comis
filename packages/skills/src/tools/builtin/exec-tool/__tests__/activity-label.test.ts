// SPDX-License-Identifier: Apache-2.0
/**
 * exec-tool activity-label integration.
 *
 * Pins the contract that the `exec` builtin tool registers a LabelSpec whose
 * `transform` hook wires `parseShellCommand` (the deterministic
 * shell summarizer). The hook lives on the spec
 * at registration time (the `transform?` field was added to
 * `RegisteredLabelSpec`); this test asserts the full RESOLVE → APPLY pipeline
 * produces a rendered label that begins with the `parseShellCommand` output for
 * a realistic shell command, and falls through to the substituted "running
 * command" literal when the command is empty.
 *
 * The fourth case is the belt-and-braces redaction lock: a command that
 * embeds a secret-looking token must render as `<redacted>` because BOTH
 * defenses fire:
 *   1) `parseShellCommand` self-redacts via `redactValue` at
 *      shell-label-parser.ts:53.
 *   2) `applyTemplate` step 4 pipes the transform output through
 *      `redactValue` defense-in-depth.
 *
 * Why side-effect import of the exec-tool module in `beforeAll`: the
 * `registerActivityLabelSpec("exec", ...)` call lives at module top and runs on
 * first import. Same idiom as `builtin-tools-label-coverage.test.ts`.
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { resolveLabelSpec, applyTemplate } from "@comis/core";
import { parseShellCommand } from "@comis/observability";

describe("exec-tool activity label", () => {
  beforeAll(async () => {
    // Side-effect import: the exec-tool module's co-located
    // `registerActivityLabelSpec("exec", ...)` call runs on first import,
    // populating the singleton registry. No `_clearActivityLabelSpecsForTest`
    // shim here — the helper is test-only and intentionally not exported
    // through the `@comis/core` barrel (its docstring forbids it), and
    // vitest's default per-file worker isolation prevents cross-file
    // registration contamination anyway.
    await import("../index.js");
  });

  it("Case A — registers a LabelSpec for exec with a transform hook present", () => {
    // Resolving "exec" with no action / no theme must return a spec carrying
    // BOTH the fallback label ("running command", which the transform falls
    // through to when it returns "") AND a defined transform function (the
    // parseShellCommand bridge).
    const resolved = resolveLabelSpec("exec", { action: undefined, theme: undefined });
    expect(resolved).toBeDefined();
    expect(resolved.label).toBe("running command");
    expect(typeof resolved.transform).toBe("function");
  });

  it("Case B — applyTemplate for {command: 'npx tsc'} renders the parseShellCommand output verbatim", () => {
    // The exec transform delegates to parseShellCommand when the command is
    // non-empty; `applyTemplate` then re-runs the transform output through
    // redactValue defense-in-depth. For a redaction-clean input the output of
    // both layers is identical to `parseShellCommand("npx tsc")` — this is
    // the live equality check (runtime gate).
    const resolved = resolveLabelSpec("exec");
    const result = applyTemplate(resolved, { command: "npx tsc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toBe(parseShellCommand("npx tsc"));
  });

  it("Case C — empty command falls through to the substituted 'running command' literal", () => {
    // The exec transform returns "" for an empty command (see the `cmd.length
    // > 0` guard in the registration); applyTemplate's transform step then
    // skips the override and uses the substituted label result, which for a
    // static "running command" template (no detailKeys, no placeholders) is
    // the literal string.
    const resolved = resolveLabelSpec("exec");
    const result = applyTemplate(resolved, { command: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toBe("running command");
  });

  it("Case D — belt-and-braces: a secret-shape token in the command renders as <redacted>", () => {
    // The command embeds a synthetic API-key shape that BOTH layers must mask:
    //   1) parseShellCommand → redactValue on the produced "search for `…`"
    //      label (shell-label-parser.ts:53),
    //   2) applyTemplate transform step → redactValue on the transform output
    //      (template-engine.ts:155, defense-in-depth).
    // The synthetic key never lives in production source — the regex it
    // triggers is `redact-value.ts`'s secret-shape detector.
    const resolved = resolveLabelSpec("exec");
    const result = applyTemplate(resolved, {
      command: "grep sk-test-1234567890ABCDEF1234567890ABCDEF /tmp/log",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLabel).toContain("<redacted>");
  });
});
