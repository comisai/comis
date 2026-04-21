// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveBrowserConfig } from "./config.js";
import {
  DEFAULT_CDP_PORT,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_SCREENSHOT_QUALITY,
  DEFAULT_BROWSER_PROFILE,
  DEFAULT_SCREENSHOT_MAX_SIDE,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";

describe("resolveBrowserConfig", () => {
  it("returns all defaults when no partial provided", () => {
    const config = resolveBrowserConfig();
    expect(config.enabled).toBe(true);
    expect(config.chromePath).toBeUndefined();
    expect(config.cdpPort).toBe(DEFAULT_CDP_PORT);
    expect(config.defaultProfile).toBe(DEFAULT_BROWSER_PROFILE);
    expect(config.viewport).toEqual({
      width: DEFAULT_VIEWPORT_WIDTH,
      height: DEFAULT_VIEWPORT_HEIGHT,
    });
    expect(config.headless).toBe(true);
    expect(config.noSandbox).toBe(false);
    expect(config.screenshotMaxSide).toBe(DEFAULT_SCREENSHOT_MAX_SIDE);
    expect(config.screenshotQuality).toBe(DEFAULT_SCREENSHOT_QUALITY);
    expect(config.snapshotMaxChars).toBe(DEFAULT_AI_SNAPSHOT_MAX_CHARS);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("overrides enabled=false", () => {
    const config = resolveBrowserConfig({ enabled: false });
    expect(config.enabled).toBe(false);
  });

  it("passes through chromePath override", () => {
    const config = resolveBrowserConfig({ chromePath: "/usr/bin/chromium" });
    expect(config.chromePath).toBe("/usr/bin/chromium");
  });

  it("falls back to default for port=0", () => {
    const config = resolveBrowserConfig({ cdpPort: 0 });
    expect(config.cdpPort).toBe(DEFAULT_CDP_PORT);
  });

  it("falls back to default for negative port", () => {
    const config = resolveBrowserConfig({ cdpPort: -1 });
    expect(config.cdpPort).toBe(DEFAULT_CDP_PORT);
  });

  it("falls back to default for port > 65535", () => {
    const config = resolveBrowserConfig({ cdpPort: 99999 });
    expect(config.cdpPort).toBe(DEFAULT_CDP_PORT);
  });

  it("accepts valid port", () => {
    const config = resolveBrowserConfig({ cdpPort: 9333 });
    expect(config.cdpPort).toBe(9333);
  });

  it("falls back to default for negative viewport dimensions", () => {
    const config = resolveBrowserConfig({
      viewport: { width: -100, height: -50 },
    });
    expect(config.viewport!.width).toBe(DEFAULT_VIEWPORT_WIDTH);
    expect(config.viewport!.height).toBe(DEFAULT_VIEWPORT_HEIGHT);
  });

  it("falls back to default for zero viewport dimensions", () => {
    const config = resolveBrowserConfig({
      viewport: { width: 0, height: 0 },
    });
    expect(config.viewport!.width).toBe(DEFAULT_VIEWPORT_WIDTH);
    expect(config.viewport!.height).toBe(DEFAULT_VIEWPORT_HEIGHT);
  });

  it("accepts valid viewport dimensions", () => {
    const config = resolveBrowserConfig({
      viewport: { width: 1920, height: 1080 },
    });
    expect(config.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("clamps screenshotQuality to 1-100 range (low)", () => {
    const config = resolveBrowserConfig({ screenshotQuality: -10 });
    expect(config.screenshotQuality).toBe(1);
  });

  it("clamps screenshotQuality to 1-100 range (high)", () => {
    const config = resolveBrowserConfig({ screenshotQuality: 200 });
    expect(config.screenshotQuality).toBe(100);
  });

  it("accepts valid screenshotQuality within range", () => {
    const config = resolveBrowserConfig({ screenshotQuality: 50 });
    expect(config.screenshotQuality).toBe(50);
  });

  it("falls back to default for NaN screenshotQuality", () => {
    const config = resolveBrowserConfig({ screenshotQuality: NaN });
    expect(config.screenshotQuality).toBe(DEFAULT_SCREENSHOT_QUALITY);
  });

  it("falls back to default for Infinity screenshotQuality", () => {
    const config = resolveBrowserConfig({ screenshotQuality: Infinity });
    expect(config.screenshotQuality).toBe(DEFAULT_SCREENSHOT_QUALITY);
  });

  it("overrides headless", () => {
    const config = resolveBrowserConfig({ headless: false });
    expect(config.headless).toBe(false);
  });

  it("overrides noSandbox", () => {
    const config = resolveBrowserConfig({ noSandbox: true });
    expect(config.noSandbox).toBe(true);
  });
});
