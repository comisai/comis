// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveEffectiveContextWindow } from "./effective-context-window.js";

describe("resolveEffectiveContextWindow", () => {
  // ---------------------------------------------------------------------------
  // Concrete input matrix
  // ---------------------------------------------------------------------------

  it("configured only, Infinity cap → configured wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, capabilityCap: Infinity });
    expect(r.effectiveWindow).toBe(131072);
    expect(r.source).toBe("configured");
  });

  it("configured only, finite cap → capability wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });

  it("served smaller than Infinity cap → served wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 32768, capabilityCap: Infinity });
    expect(r.effectiveWindow).toBe(32768);
    expect(r.source).toBe("served");
  });

  it("capability smallest (served > cap) → capability wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 32768, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });

  it("served smallest (served < cap) → served wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 8192, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(8192);
    expect(r.source).toBe("served");
  });

  it("configured ties served, cap larger → configured wins (earlier candidate)", () => {
    const r = resolveEffectiveContextWindow({ configured: 8192, served: 8192, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(8192);
    expect(r.source).toBe("configured");
  });

  it("three-way tie → configured wins (first/earliest candidate)", () => {
    const r = resolveEffectiveContextWindow({ configured: 32000, served: 32000, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("configured");
  });

  it("incident case — configured=131072 served=32768 cap=32000 → 32000 capability", () => {
    // Confirms the resolver handles the live incident: Ollama served 32768 < configured 131072,
    // but capability cap 32000 is even smaller — capability wins.
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 32768, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });

  // ---------------------------------------------------------------------------
  // Property/source-tag matrix
  // ---------------------------------------------------------------------------

  it("source=served when served is strictly smallest", () => {
    const r = resolveEffectiveContextWindow({ configured: 100000, served: 1000, capabilityCap: 50000 });
    expect(r.source).toBe("served");
    expect(r.effectiveWindow).toBe(1000);
  });

  it("source=capability when capabilityCap is strictly smallest and finite", () => {
    const r = resolveEffectiveContextWindow({ configured: 100000, served: 50000, capabilityCap: 10000 });
    expect(r.source).toBe("capability");
    expect(r.effectiveWindow).toBe(10000);
  });

  it("source=configured when configured is smallest", () => {
    const r = resolveEffectiveContextWindow({ configured: 1000, served: 50000, capabilityCap: 32000 });
    expect(r.source).toBe("configured");
    expect(r.effectiveWindow).toBe(1000);
  });

  it("Infinity capabilityCap is excluded from the min race (configured wins)", () => {
    // Infinity cap must NOT constrain the window — frontier/mid models use Infinity
    // to signal "no capability upper bound from class".
    const r = resolveEffectiveContextWindow({ configured: 131072, capabilityCap: Infinity });
    expect(r.effectiveWindow).toBe(131072);
    expect(r.source).toBe("configured");
    // Verify cap did not drag the result down
    expect(r.effectiveWindow).not.toBe(Infinity);
  });

  it("served=undefined is excluded from the race (capability or configured wins)", () => {
    // When served is absent, the resolver must not error and must pick the min of the others.
    const r = resolveEffectiveContextWindow({ configured: 131072, served: undefined, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });
});
