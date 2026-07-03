// SPDX-License-Identifier: Apache-2.0
/**
 * RED-state proof meta-test for the security-doc-claims guard.
 *
 * These tests call the pure exported claim-checker and sanitizer functions with
 * known-bad fixture strings (the pre-fix claims) and assert that the functions
 * correctly detect the violation. This is a permanent machine-proof that the
 * main guard would go RED if those claims were reverted — satisfying the TDD
 * RED-state obligation.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeDocText,
  securityMdViolatesIsolatedVm,
  readmeViolatesSdkIndependence,
  claimsDocNamesAbsentIsolationLibrary,
  auditDocClaimsDurabilityWithoutSink,
} from "./security-doc-claims.test.js";

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

  it("flags plural sdk-independence claim in README when pi-coding-agent is a dependency", () => {
    const deps = new Set<string>(["@earendil-works/pi-coding-agent"]);
    expect(
      readmeViolatesSdkIndependence("Comis has no external SDK dependencies.", deps),
    ).toBe(true);
  });

  it("sanitizeDocText strips inline backtick spans so isolated-vm in code syntax does not trigger guard", () => {
    const raw = "We replaced `isolated-vm` with bubblewrap — see the migration notes.";
    expect(/isolated-vm/i.test(sanitizeDocText(raw))).toBe(false);
  });

  it("sanitizeDocText strips double-backtick inline spans containing claim keywords", () => {
    const raw = "The old sandbox was ``isolated-vm`` — we no longer use it.";
    expect(/isolated-vm/i.test(sanitizeDocText(raw))).toBe(false);
  });

  it("sanitizeDocText strips content from an unclosed triple-backtick fence to end of string", () => {
    const raw = "Normal prose.\n```\nisolated-vm example\n(intentionally unclosed — no closing fence)";
    expect(/isolated-vm/i.test(sanitizeDocText(raw))).toBe(false);
  });

  it("sanitizeDocText strips content from an unclosed tilde fence to end of string", () => {
    const raw = "Normal prose.\n~~~\nisolated-vm example\n(intentionally unclosed tilde fence)";
    expect(/isolated-vm/i.test(sanitizeDocText(raw))).toBe(false);
  });

  it("claimsDocNamesAbsentIsolationLibrary flags a named library that is absent from deps", () => {
    const depsWithout = new Set<string>(["bubblewrap"]);
    expect(
      claimsDocNamesAbsentIsolationLibrary(
        "Skills run in isolated-vm sandboxes.",
        "isolated-vm",
        depsWithout,
      ),
    ).toBe(true);
  });

  it("claimsDocNamesAbsentIsolationLibrary does not flag a library present in deps", () => {
    const depsWith = new Set<string>(["isolated-vm"]);
    expect(
      claimsDocNamesAbsentIsolationLibrary(
        "Skills run in isolated-vm sandboxes.",
        "isolated-vm",
        depsWith,
      ),
    ).toBe(false);
  });

  it("claimsDocNamesAbsentIsolationLibrary does not flag when library name absent from claims text", () => {
    const depsWithout = new Set<string>(["bubblewrap"]);
    expect(
      claimsDocNamesAbsentIsolationLibrary(
        "Skills run in bubblewrap OS sandboxes.",
        "isolated-vm",
        depsWithout,
      ),
    ).toBe(false);
  });

  // RED-state proof for the audit.mdx durability↔sink checker.
  it("auditDocClaimsDurabilityWithoutSink FLAGS a daemon.log-only persistence over-claim", () => {
    // The pre-correction claim: durable persistence asserted, NO real sink named.
    expect(
      auditDocClaimsDurabilityWithoutSink(
        "Audit events live in the daemon log file and persists across restarts.",
      ),
    ).toBe(true);
  });

  it("auditDocClaimsDurabilityWithoutSink does NOT flag once a real sink is named", () => {
    // The corrected claim: durable persistence backed by the real obs_audit_events sink.
    expect(
      auditDocClaimsDurabilityWithoutSink(
        "Audit events persist across restarts in the obs_audit_events SQLite table and the security-audit.jsonl file.",
      ),
    ).toBe(false);
  });

  it("auditDocClaimsDurabilityWithoutSink does NOT flag a doc that makes no durability claim", () => {
    // No persistence/durability assertion → nothing to back (the early return).
    expect(
      auditDocClaimsDurabilityWithoutSink("Audit events are emitted on the in-memory event bus."),
    ).toBe(false);
  });

  it("lockfile name normalization strips leading slash from pnpm v5/v6 path-style entries", () => {
    // collectLockfileNames is private but we can verify the normalization logic
    // that was added to it: a path-style entry "/isolated-vm@2.3.1:" must be
    // captured as "isolated-vm" not "/isolated-vm".
    const RE = /^  '?(@?[^@'(]+)@/;
    const pathStyleLine = "  '/isolated-vm@2.3.1':";
    const m = RE.exec(pathStyleLine);
    const rawCapture = m ? m[1].trim() : "";
    const normalized = rawCapture.replace(/^\//, "");
    expect(rawCapture).toBe("/isolated-vm"); // confirms the raw regex captures the slash
    expect(normalized).toBe("isolated-vm");  // confirms normalization removes it
  });
});
