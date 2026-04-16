import { describe, it, expect } from "vitest";
import { CSSResult } from "lit";
import { sharedStyles, focusStyles, srOnly, breakpoints } from "./shared.js";

describe("sharedStyles", () => {
  it("is a CSSResult", () => {
    expect(sharedStyles).toBeInstanceOf(CSSResult);
  });

  it("contains font-family rule", () => {
    const text = sharedStyles.cssText;
    expect(text).toContain("font-family");
  });

  it("contains box-sizing: border-box rule", () => {
    const text = sharedStyles.cssText;
    expect(text).toContain("box-sizing: border-box");
  });

  it("references --ic-text token for color", () => {
    const text = sharedStyles.cssText;
    expect(text).toContain("var(--ic-text)");
  });
});

describe("focusStyles", () => {
  it("is a CSSResult", () => {
    expect(focusStyles).toBeInstanceOf(CSSResult);
  });

  it("contains focus-visible selector", () => {
    const text = focusStyles.cssText;
    expect(text).toContain("focus-visible");
  });

  it("references --ic-accent for outline color", () => {
    const text = focusStyles.cssText;
    expect(text).toContain("var(--ic-accent)");
  });
});

describe("breakpoints", () => {
  it("is a plain object (not CSSResult)", () => {
    expect(breakpoints).not.toBeInstanceOf(CSSResult);
    expect(typeof breakpoints).toBe("object");
  });

  it("has exactly 7 keys", () => {
    expect(Object.keys(breakpoints)).toHaveLength(7);
  });

  it("mobile value contains max-width: 767px", () => {
    expect(breakpoints.mobile).toContain("max-width: 767px");
  });

  it("tablet value contains min-width: 768px", () => {
    expect(breakpoints.tablet).toContain("min-width: 768px");
  });

  it("desktop value contains min-width: 1024px", () => {
    expect(breakpoints.desktop).toContain("min-width: 1024px");
  });

  it("wide value contains min-width: 1440px", () => {
    expect(breakpoints.wide).toContain("min-width: 1440px");
  });
});

describe("srOnly", () => {
  it("is a CSSResult", () => {
    expect(srOnly).toBeInstanceOf(CSSResult);
  });

  it("contains position: absolute rule", () => {
    const text = srOnly.cssText;
    expect(text).toContain("position: absolute");
  });

  it("contains clip: rect(0", () => {
    const text = srOnly.cssText;
    expect(text).toContain("clip: rect(0");
  });
});
