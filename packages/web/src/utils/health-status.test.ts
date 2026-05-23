// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for shared health-status utility module.
 *
 * Covers normalize/getHealthVisual/showUptime + the HEALTH_STATUS map. Pure logic — no
 * DOM dependencies. Every branch in normalizeChannelStatus is exercised: valid state
 * pass-through (case-insensitive, trimmed) and unknown-string fallback.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  HEALTH_STATUS,
  normalizeChannelStatus,
  getHealthVisual,
  showUptime,
  type ChannelHealthState,
} from "./health-status.js";

describe("health-status — HEALTH_STATUS map", () => {
  it("declares exactly 8 canonical channel health states matching the backend health machine", () => {
    expect(Object.keys(HEALTH_STATUS).sort()).toEqual(
      [
        "disconnected",
        "errored",
        "healthy",
        "idle",
        "startup-grace",
        "stale",
        "stuck",
        "unknown",
      ].sort(),
    );
  });

  it("groups healthy and idle states under the green severity for visual rendering", () => {
    expect(HEALTH_STATUS.healthy.severity).toBe("green");
    expect(HEALTH_STATUS.idle.severity).toBe("green");
  });

  it("groups stale and startup-grace states under the yellow severity bucket", () => {
    expect(HEALTH_STATUS.stale.severity).toBe("yellow");
    expect(HEALTH_STATUS["startup-grace"].severity).toBe("yellow");
  });

  it("groups stuck and errored states under the red severity for breakage indication", () => {
    expect(HEALTH_STATUS.stuck.severity).toBe("red");
    expect(HEALTH_STATUS.errored.severity).toBe("red");
  });

  it("groups disconnected and unknown states under the gray severity for indeterminate visuals", () => {
    expect(HEALTH_STATUS.disconnected.severity).toBe("gray");
    expect(HEALTH_STATUS.unknown.severity).toBe("gray");
  });

  it("flags only startup-grace as pulse-animated to indicate active starting state", () => {
    const pulsing = (Object.keys(HEALTH_STATUS) as ChannelHealthState[]).filter(
      (k) => HEALTH_STATUS[k].pulse,
    );
    expect(pulsing).toEqual(["startup-grace"]);
  });

  it("supplies an icon name string for every health state in the map", () => {
    for (const state of Object.keys(HEALTH_STATUS) as ChannelHealthState[]) {
      expect(typeof HEALTH_STATUS[state].icon).toBe("string");
      expect(HEALTH_STATUS[state].icon.length).toBeGreaterThan(0);
    }
  });

  it("supplies a human-readable label string for every health state in the map", () => {
    for (const state of Object.keys(HEALTH_STATUS) as ChannelHealthState[]) {
      expect(typeof HEALTH_STATUS[state].label).toBe("string");
      expect(HEALTH_STATUS[state].label.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeChannelStatus", () => {
  it("returns the input unchanged when raw is already a canonical lowercase state", () => {
    expect(normalizeChannelStatus("healthy")).toBe("healthy");
    expect(normalizeChannelStatus("idle")).toBe("idle");
    expect(normalizeChannelStatus("stale")).toBe("stale");
    expect(normalizeChannelStatus("startup-grace")).toBe("startup-grace");
    expect(normalizeChannelStatus("stuck")).toBe("stuck");
    expect(normalizeChannelStatus("errored")).toBe("errored");
    expect(normalizeChannelStatus("disconnected")).toBe("disconnected");
    expect(normalizeChannelStatus("unknown")).toBe("unknown");
  });

  it("lowercases mixed-case canonical states to satisfy case-insensitive matching", () => {
    expect(normalizeChannelStatus("HEALTHY")).toBe("healthy");
    expect(normalizeChannelStatus("Errored")).toBe("errored");
  });

  it("trims surrounding whitespace from raw status string before lookup", () => {
    expect(normalizeChannelStatus("  healthy  ")).toBe("healthy");
    expect(normalizeChannelStatus("\nidle\n")).toBe("idle");
  });

  it("returns 'unknown' for former legacy alias strings that are no longer remapped", () => {
    // The LEGACY_ALIASES dictionary was deleted. Backends emit canonical
    // states only; the prior aliases (connected / running / error / stopped /
    // reconnecting) now fall through to "unknown" — the documented safe state.
    expect(normalizeChannelStatus("connected")).toBe("unknown");
    expect(normalizeChannelStatus("running")).toBe("unknown");
    expect(normalizeChannelStatus("error")).toBe("unknown");
    expect(normalizeChannelStatus("stopped")).toBe("unknown");
    expect(normalizeChannelStatus("reconnecting")).toBe("unknown");
  });

  it("returns 'unknown' for arbitrary unrecognized status strings as safe fallback", () => {
    expect(normalizeChannelStatus("foobar")).toBe("unknown");
    expect(normalizeChannelStatus("")).toBe("unknown");
    expect(normalizeChannelStatus("INVALID_STATE")).toBe("unknown");
  });
});

describe("getHealthVisual", () => {
  it("returns the full HealthVisual object including label/icon/color for a canonical state", () => {
    const visual = getHealthVisual("healthy");
    expect(visual.label).toBe("Healthy");
    expect(visual.severity).toBe("green");
    expect(visual.pulse).toBe(false);
    expect(visual.icon).toBe("check-circle");
  });

  it("returns the unknown HealthVisual for former legacy alias inputs (aliases removed)", () => {
    // LEGACY_ALIASES was deleted — "connected" no longer maps to "healthy".
    const visual = getHealthVisual("connected");
    expect(visual.severity).toBe("gray");
    expect(visual.label).toBe("Unknown");
  });

  it("returns the unknown HealthVisual when raw status is unrecognized", () => {
    const visual = getHealthVisual("invalid-status-string");
    expect(visual.label).toBe("Unknown");
    expect(visual.severity).toBe("gray");
  });
});

describe("showUptime", () => {
  it("returns true for healthy state since uptime is meaningful when connected", () => {
    expect(showUptime("healthy")).toBe(true);
  });

  it("returns true for idle state since uptime continues during inactivity", () => {
    expect(showUptime("idle")).toBe(true);
  });

  it("returns false for stale state since stale uptime is misleading", () => {
    expect(showUptime("stale")).toBe(false);
  });

  it("returns false for startup-grace state since uptime is not yet meaningful", () => {
    expect(showUptime("startup-grace")).toBe(false);
  });

  it("returns false for stuck/errored/disconnected/unknown non-green states", () => {
    expect(showUptime("stuck")).toBe(false);
    expect(showUptime("errored")).toBe(false);
    expect(showUptime("disconnected")).toBe(false);
    expect(showUptime("unknown")).toBe(false);
  });
});
