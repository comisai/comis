import { describe, it, expect } from "vitest";
import type { NotificationVisibility } from "./relevance-filter.js";
import {
  shouldNotify,
  classifyHeartbeatResult,
  DEFAULT_VISIBILITY,
  HEARTBEAT_OK_TOKEN,
} from "./relevance-filter.js";

describe("classifyHeartbeatResult", () => {
  it("classifies HEARTBEAT_OK_TOKEN as 'ok'", () => {
    expect(classifyHeartbeatResult(`All systems ${HEARTBEAT_OK_TOKEN}`)).toBe("ok");
  });

  it("classifies text containing CRITICAL as 'critical'", () => {
    expect(classifyHeartbeatResult("CRITICAL: disk full")).toBe("critical");
  });

  it("classifies text containing EMERGENCY as 'critical'", () => {
    expect(classifyHeartbeatResult("EMERGENCY: server down")).toBe("critical");
  });

  it("classifies case-insensitive CRITICAL as 'critical'", () => {
    expect(classifyHeartbeatResult("Critical error found")).toBe("critical");
  });

  it("classifies generic alert text as 'alert'", () => {
    expect(classifyHeartbeatResult("Warning: high CPU usage")).toBe("alert");
  });

  it("classifies empty string as 'alert'", () => {
    expect(classifyHeartbeatResult("")).toBe("alert");
  });

  it("prefers 'ok' when both OK token and CRITICAL are present", () => {
    // OK token check comes first
    expect(classifyHeartbeatResult(`${HEARTBEAT_OK_TOKEN} CRITICAL`)).toBe("ok");
  });
});

describe("shouldNotify", () => {
  const showAll: NotificationVisibility = { showOk: true, showAlerts: true };
  const showNone: NotificationVisibility = { showOk: false, showAlerts: false };
  const defaultVis = DEFAULT_VISIBILITY;

  // Critical + criticalBypass always notifies
  it("critical + criticalBypass -> true (normal hours)", () => {
    expect(
      shouldNotify({
        level: "critical",
        visibility: showNone,
        isQuietHours: false,
        criticalBypass: true,
      }),
    ).toBe(true);
  });

  it("critical + criticalBypass -> true (quiet hours)", () => {
    expect(
      shouldNotify({
        level: "critical",
        visibility: showNone,
        isQuietHours: true,
        criticalBypass: true,
      }),
    ).toBe(true);
  });

  // Critical without bypass respects quiet hours
  it("critical + no bypass + quiet hours -> false", () => {
    expect(
      shouldNotify({
        level: "critical",
        visibility: showAll,
        isQuietHours: true,
        criticalBypass: false,
      }),
    ).toBe(false);
  });

  it("critical + no bypass + normal hours -> true", () => {
    expect(
      shouldNotify({
        level: "critical",
        visibility: showAll,
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(true);
  });

  // Quiet hours suppress non-critical
  it("alert + quiet hours -> false", () => {
    expect(
      shouldNotify({
        level: "alert",
        visibility: showAll,
        isQuietHours: true,
        criticalBypass: true,
      }),
    ).toBe(false);
  });

  it("ok + quiet hours -> false", () => {
    expect(
      shouldNotify({
        level: "ok",
        visibility: showAll,
        isQuietHours: true,
        criticalBypass: true,
      }),
    ).toBe(false);
  });

  // OK respects visibility.showOk
  it("ok + showOk=true + normal hours -> true", () => {
    expect(
      shouldNotify({
        level: "ok",
        visibility: { showOk: true, showAlerts: false },
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(true);
  });

  it("ok + showOk=false + normal hours -> false", () => {
    expect(
      shouldNotify({
        level: "ok",
        visibility: { showOk: false, showAlerts: true },
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(false);
  });

  // Alert respects visibility.showAlerts
  it("alert + showAlerts=true + normal hours -> true", () => {
    expect(
      shouldNotify({
        level: "alert",
        visibility: { showOk: false, showAlerts: true },
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(true);
  });

  it("alert + showAlerts=false + normal hours -> false", () => {
    expect(
      shouldNotify({
        level: "alert",
        visibility: { showOk: true, showAlerts: false },
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(false);
  });

  // Default visibility: showOk=false, showAlerts=true
  it("default visibility: ok -> false", () => {
    expect(
      shouldNotify({
        level: "ok",
        visibility: defaultVis,
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(false);
  });

  it("default visibility: alert -> true", () => {
    expect(
      shouldNotify({
        level: "alert",
        visibility: defaultVis,
        isQuietHours: false,
        criticalBypass: false,
      }),
    ).toBe(true);
  });
});
