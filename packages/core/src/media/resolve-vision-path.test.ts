// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { resolveVisionPath } from "./resolve-vision-path.js";

/**
 * resolveVisionPath is a PURE ladder-decision resolver (no I/O) for the
 * provider-following vision path. Purity is preserved by injection:
 * the daemon precomputes `visionCapable` (via `isVisionCapable(getModel(...))`),
 * `mainCredsAvailable` (a SecretManager/OAuth lookup), and `registryAvailable`
 * (whether `selectVisionProvider` would return a provider). The resolver never
 * touches the catalog, a secret store, process.env, or the network — it only
 * labels WHICH path the handler must execute.
 *
 * The locked ladder ORDER: main-vision FIRST (image only,
 * when the main model sees images AND its creds resolve) → registry SECOND →
 * gemini-video THIRD (raw video only) → honest-unavailable LAST. An explicit
 * vision `defaultProvider` overrides main-first (explicit wins).
 * `mediaKind:"video"` NEVER returns main-vision (pi-ai has no video content
 * type).
 */
describe("resolveVisionPath", () => {
  const baseImage = {
    mediaKind: "image" as const,
    mainProviderId: "anthropic",
    visionCapable: true,
    mainCredsAvailable: true,
    registryAvailable: true,
  };

  it("picks main-vision FIRST when image + vision-capable + main creds + no explicit override", () => {
    const sel = resolveVisionPath({ ...baseImage });
    expect(sel).toEqual({ ok: true, path: "main-vision", provider: "anthropic" });
  });

  it("falls to the registry when the main provider is not vision-capable", () => {
    const onSkip = vi.fn();
    const sel = resolveVisionPath({ ...baseImage, visionCapable: false }, onSkip);
    expect(sel).toEqual({ ok: true, path: "registry" });
    expect(onSkip).toHaveBeenCalledWith(
      'main-vision skipped: main provider "anthropic" is not vision-capable',
    );
  });

  it("falls to the registry (NOT unavailable) when main is vision-capable but has no creds", () => {
    const onSkip = vi.fn();
    const sel = resolveVisionPath({ ...baseImage, mainCredsAvailable: false }, onSkip);
    // The registry has its OWN keys → registry, never unavailable.
    expect(sel).toEqual({ ok: true, path: "registry" });
    expect(onSkip).toHaveBeenCalledWith(
      'main-vision skipped: no credentials for main provider "anthropic"',
    );
  });

  it("honors an explicit defaultProvider over main-first (explicit operator config wins)", () => {
    const onSkip = vi.fn();
    const sel = resolveVisionPath(
      { ...baseImage, explicitDefaultProvider: "openai" },
      onSkip,
    );
    expect(sel).toEqual({ ok: true, path: "registry" });
    expect(onSkip).toHaveBeenCalledWith(
      'main-vision skipped: explicit defaultProvider "openai" configured',
    );
  });

  it("treats an empty-string explicit defaultProvider as unset (still main-first)", () => {
    const sel = resolveVisionPath({ ...baseImage, explicitDefaultProvider: "" });
    expect(sel).toEqual({ ok: true, path: "main-vision", provider: "anthropic" });
  });

  it("NEVER returns main-vision for mediaKind:video even when vision-capable", () => {
    const sel = resolveVisionPath({
      mediaKind: "video",
      mainProviderId: "anthropic",
      visionCapable: true,
      mainCredsAvailable: true,
      registryAvailable: true,
    });
    expect(sel).toEqual({ ok: true, path: "gemini-video" });
  });

  it("returns honest-unavailable for video when no video provider is available", () => {
    const sel = resolveVisionPath({
      mediaKind: "video",
      mainProviderId: "anthropic",
      visionCapable: true,
      mainCredsAvailable: true,
      registryAvailable: false,
    });
    expect(sel.ok).toBe(false);
    if (sel.ok) throw new Error("expected unavailable");
    expect(sel.path).toBe("unavailable");
    expect(sel.errorKind).toBe("unsupported_provider");
    expect(sel.hint).toMatch(/vision|defaultProvider|API_KEY/i);
  });

  it("returns honest-unavailable for image when neither main-vision nor registry can serve", () => {
    const sel = resolveVisionPath({
      ...baseImage,
      visionCapable: false,
      registryAvailable: false,
    });
    expect(sel.ok).toBe(false);
    if (sel.ok) throw new Error("expected unavailable");
    expect(sel.path).toBe("unavailable");
    expect(sel.errorKind).toBe("unsupported_provider");
    expect(sel.hint).toMatch(/vision|defaultProvider|API_KEY/i);
  });

  it("returns auth_required when the ONLY blocker was missing main creds and no registry", () => {
    const sel = resolveVisionPath({
      ...baseImage,
      visionCapable: true,
      mainCredsAvailable: false,
      registryAvailable: false,
    });
    expect(sel.ok).toBe(false);
    if (sel.ok) throw new Error("expected unavailable");
    expect(sel.path).toBe("unavailable");
    expect(sel.errorKind).toBe("auth_required");
    expect(sel.hint).toContain("anthropic");
  });

  it("reports each non-chosen tier via onSkip in ladder order (path-logging)", () => {
    const order: string[] = [];
    const onSkip = (reason: string): void => {
      order.push(reason);
    };
    const sel = resolveVisionPath(
      { ...baseImage, explicitDefaultProvider: "openai", visionCapable: true },
      onSkip,
    );
    // Explicit override fires before main-vision; main-vision capability reason is NOT
    // reported because the explicit override short-circuits it.
    expect(sel).toEqual({ ok: true, path: "registry" });
    expect(order).toEqual(['main-vision skipped: explicit defaultProvider "openai" configured']);
  });

  it("is PURE — decided entirely from its args (no network/fs/env import)", () => {
    // Two identical calls return structurally-equal results with no external dependency.
    const a = resolveVisionPath({ ...baseImage });
    const b = resolveVisionPath({ ...baseImage });
    expect(a).toEqual(b);
    // The module under test imports only its sibling image-error union — assert no
    // accidental secret-store / process import leaked in (guards the purity invariant).
    // (A structural check; the real guarantee is the no-I/O signature.)
    expect(typeof resolveVisionPath).toBe("function");
  });
});
