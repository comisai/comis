// SPDX-License-Identifier: Apache-2.0
/**
 * RED-state proof meta-test for the security-doc-claims guard.
 *
 * These tests call the pure exported claim-checker and sanitizer functions with
 * known-bad fixture strings (the pre-fix claims) and assert that the functions
 * correctly detect the violation. This is a permanent machine-proof that the
 * main guard would go RED if those claims were reverted — satisfying the TDD
 * RED-state obligation from STATE.md and AGENTS.md §2.10.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeDocText,
  securityMdViolatesIsolatedVm,
  readmeViolatesSdkIndependence,
} from "./security-doc-claims.js";

describe("security-doc-claims guard detects reverted claims", () => {
  it("flags isolated-vm in SECURITY.md when isolated-vm is absent from the dependency graph", () => {
    const depsWithout = new Set<string>(["bubblewrap", "sandbox-exec"]);
    expect(
      securityMdViolatesIsolatedVm(
        "Skills run in isolated-vm sandboxes.",
        depsWithout,
      ),
    ).toBe(true);
  });

  it("does not flag isolated-vm claim when isolated-vm is present in the dependency graph", () => {
    const depsWith = new Set<string>(["isolated-vm"]);
    expect(
      securityMdViolatesIsolatedVm("Skills run in isolated-vm sandboxes.", depsWith),
    ).toBe(false);
  });

  it("flags no-external-sdk claim in README when pi-coding-agent is a dependency", () => {
    const deps = new Set<string>(["@earendil-works/pi-coding-agent"]);
    expect(
      readmeViolatesSdkIndependence("Comis has no external SDK dependency.", deps),
    ).toBe(true);
  });

  it("does not flag sdk-independence claim when pi-coding-agent is absent from deps", () => {
    const deps = new Set<string>(); // pi-coding-agent absent — no violation
    expect(
      readmeViolatesSdkIndependence("Comis has no external SDK dependency.", deps),
    ).toBe(false);
  });

  it("sanitizeDocText strips fenced code blocks so isolated-vm in an example does not trigger the guard", () => {
    const raw = "See the old approach:\n```\nisolated-vm example code\n```\nWe no longer use this.";
    expect(/isolated-vm/i.test(sanitizeDocText(raw))).toBe(false);
  });

  it("sanitizeDocText strips HTML comments so isolated-vm in a comment does not trigger the guard", () => {
    const raw = "<!-- old claim: skills ran in isolated-vm -->\nActual corrected prose follows.";
    expect(/isolated-vm/i.test(sanitizeDocText(raw))).toBe(false);
  });
});
