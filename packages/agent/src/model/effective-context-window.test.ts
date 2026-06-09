// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveEffectiveContextWindow } from "./effective-context-window.js";

describe("resolveEffectiveContextWindow", () => {
  // ---------------------------------------------------------------------------
  // CWF-03-A: concrete input matrix
  // ---------------------------------------------------------------------------

  it("CWF-03-A-1: configured only, Infinity cap → configured wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, capabilityCap: Infinity });
    expect(r.effectiveWindow).toBe(131072);
    expect(r.source).toBe("configured");
  });

  it("CWF-03-A-2: configured only, finite cap → capability wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });

  it("CWF-03-A-3: served smaller than Infinity cap → served wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 32768, capabilityCap: Infinity });
    expect(r.effectiveWindow).toBe(32768);
    expect(r.source).toBe("served");
  });

  it("CWF-03-A-4: capability smallest (served > cap) → capability wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 32768, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });

  it("CWF-03-A-5: served smallest (served < cap) → served wins", () => {
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 8192, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(8192);
    expect(r.source).toBe("served");
  });

  it("CWF-03-A-6: configured ties served, cap larger → configured wins (earlier candidate)", () => {
    const r = resolveEffectiveContextWindow({ configured: 8192, served: 8192, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(8192);
    expect(r.source).toBe("configured");
  });

  it("CWF-03-A-7: three-way tie → configured wins (first/earliest candidate)", () => {
    const r = resolveEffectiveContextWindow({ configured: 32000, served: 32000, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("configured");
  });

  it("CWF-03-A-8: incident case — configured=131072 served=32768 cap=32000 → 32000 capability", () => {
    // Confirms Phase 167 resolves the incident: Ollama served 32768 < configured 131072,
    // but capability cap 32000 is even smaller — capability wins.
    const r = resolveEffectiveContextWindow({ configured: 131072, served: 32768, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });

  // ---------------------------------------------------------------------------
  // CWF-03-B: property/source-tag matrix
  // ---------------------------------------------------------------------------

  it("CWF-03-B-1: source=served when served is strictly smallest", () => {
    const r = resolveEffectiveContextWindow({ configured: 100000, served: 1000, capabilityCap: 50000 });
    expect(r.source).toBe("served");
    expect(r.effectiveWindow).toBe(1000);
  });

  it("CWF-03-B-2: source=capability when capabilityCap is strictly smallest and finite", () => {
    const r = resolveEffectiveContextWindow({ configured: 100000, served: 50000, capabilityCap: 10000 });
    expect(r.source).toBe("capability");
    expect(r.effectiveWindow).toBe(10000);
  });

  it("CWF-03-B-3: source=configured when configured is smallest", () => {
    const r = resolveEffectiveContextWindow({ configured: 1000, served: 50000, capabilityCap: 32000 });
    expect(r.source).toBe("configured");
    expect(r.effectiveWindow).toBe(1000);
  });

  it("CWF-03-B-4: Infinity capabilityCap is excluded from the min race (configured wins)", () => {
    // Infinity cap must NOT constrain the window — frontier/mid models use Infinity
    // to signal "no capability upper bound from class".
    const r = resolveEffectiveContextWindow({ configured: 131072, capabilityCap: Infinity });
    expect(r.effectiveWindow).toBe(131072);
    expect(r.source).toBe("configured");
    // Verify cap did not drag the result down
    expect(r.effectiveWindow).not.toBe(Infinity);
  });

  it("CWF-03-B-5: served=undefined is excluded from the race (capability or configured wins)", () => {
    // When served is absent, the resolver must not error and must pick the min of the others.
    const r = resolveEffectiveContextWindow({ configured: 131072, served: undefined, capabilityCap: 32000 });
    expect(r.effectiveWindow).toBe(32000);
    expect(r.source).toBe("capability");
  });
});
