// SPDX-License-Identifier: Apache-2.0
/**
 * LAT-03 (option b): `providers.entries.<id>.timeoutMs` is config-echo only —
 * its sole consumer is the daemon provider-config echo (provider-handlers.ts),
 * so an operator-set value silently does nothing on completion calls. These
 * fixtures pin the one-time boot redirect WARN that points such operators at
 * the knob that actually governs completion deadlines
 * (`agents.<id>.promptTimeout.promptTimeoutMs`), using the
 * served-window-comparator latch + structural-logger shape.
 *
 * RED on pre-patch code: the module does not exist, and `@comis/core` exports
 * no `PROVIDER_TIMEOUT_MS_DEFAULT`.
 *
 * Acknowledged limitation (Critical Finding 5): an operator who explicitly
 * writes the default value (120000) gets no WARN — post-parse, a zod
 * `.default()` is indistinguishable from an explicit write, and their value
 * matches behavior-neutral reality anyway.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PROVIDER_TIMEOUT_MS_DEFAULT } from "@comis/core";
import {
  warnOnProviderTimeoutRedirect,
  resetProviderTimeoutRedirectWarnForTest,
} from "./provider-timeout-redirect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recording logger stub — captures every warn(obj, msg) call for assertions. */
function createRecordingLogger(): {
  warnCalls: Array<[Record<string, unknown>, string]>;
  logger: { warn(obj: object, msg: string): void };
} {
  const warnCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    warnCalls,
    logger: {
      warn(obj: object, msg: string): void {
        warnCalls.push([obj as Record<string, unknown>, msg]);
      },
    },
  };
}

/** WARN-obj field view for assertions (logger contract is structural). */
interface WarnFields {
  providerId?: unknown;
  configuredTimeoutMs?: unknown;
  defaultTimeoutMs?: unknown;
  errorKind?: unknown;
  submodule?: unknown;
  hint?: unknown;
}

// ---------------------------------------------------------------------------
// warnOnProviderTimeoutRedirect — LAT-03
// ---------------------------------------------------------------------------

describe("warnOnProviderTimeoutRedirect (LAT-03)", () => {
  beforeEach(() => {
    resetProviderTimeoutRedirectWarnForTest();
  });

  it("LAT-03-1: non-default timeoutMs 30000 → exactly ONE WARN carrying both numbers, errorKind config, and the real-knob hint", () => {
    const { warnCalls, logger } = createRecordingLogger();

    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: 30_000 } },
      logger,
    });

    expect(warnCalls).toHaveLength(1);
    const [obj, msg] = warnCalls[0]!;

    // The message names the redirect: dead knob → real knob.
    expect(msg).toBe(
      "providers.timeoutMs is config-echo only — completion deadline lives on agents.promptTimeout",
    );

    const fields = obj as WarnFields;
    expect(fields.providerId).toBe("local");
    expect(fields.configuredTimeoutMs).toBe(30_000);
    expect(fields.defaultTimeoutMs).toBe(120_000);
    expect(fields.errorKind).toBe("config");
    expect(fields.submodule).toBe("provider-timeout-redirect");

    // I7: hint names the exact dead key, says it is not enforced, and points
    // at the real knob — never at providers.* (D-11).
    const hint = String(fields.hint);
    expect(hint).toMatch(/providers\.entries\.local\.timeoutMs/);
    expect(hint).toMatch(/not enforced on completion calls/);
    expect(hint).toMatch(/agents\.<id>\.promptTimeout\.promptTimeoutMs/);
    expect(hint).toContain("30000");
  });

  it("LAT-03-2: per-provider once-per-boot latch — repeat calls silent; a second non-default provider gets its own single WARN; the test reset clears", () => {
    const { warnCalls, logger } = createRecordingLogger();

    // First call WARNs once for `local`.
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: 30_000 } },
      logger,
    });
    expect(warnCalls).toHaveLength(1);

    // Same provider again → latched, still ONE warn total.
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: 30_000 } },
      logger,
    });
    expect(warnCalls).toHaveLength(1);

    // A second non-default provider gets its own single WARN; `local` stays latched.
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: 30_000 }, remote: { timeoutMs: 60_000 } },
      logger,
    });
    expect(warnCalls).toHaveLength(2);
    expect((warnCalls[1]![0] as WarnFields).providerId).toBe("remote");
    expect((warnCalls[1]![0] as WarnFields).configuredTimeoutMs).toBe(60_000);

    // Latch reset (test-only) → the same provider WARNs again.
    resetProviderTimeoutRedirectWarnForTest();
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: 30_000 } },
      logger,
    });
    expect(warnCalls).toHaveLength(3);
  });

  it("LAT-03-3: default value, absent timeoutMs, and empty/undefined entries → ZERO warns, no throw", () => {
    const { warnCalls, logger } = createRecordingLogger();

    // Explicit default 120000 → silent (acknowledged limitation: post-parse a
    // zod default is indistinguishable from an operator writing the default —
    // and that value matches behavior-neutral reality).
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: 120_000 } },
      logger,
    });
    expect(warnCalls).toHaveLength(0);

    // timeoutMs absent (hand-built carrier) → silent.
    warnOnProviderTimeoutRedirect({ providerEntries: { local: {} }, logger });
    expect(warnCalls).toHaveLength(0);

    // Empty entries map → silent, no throw.
    expect(() => warnOnProviderTimeoutRedirect({ providerEntries: {}, logger })).not.toThrow();

    // Undefined-valued entry (defensive loop) → silent, no throw.
    expect(() =>
      warnOnProviderTimeoutRedirect({ providerEntries: { ghost: undefined }, logger }),
    ).not.toThrow();
    expect(warnCalls).toHaveLength(0);
  });

  it("LAT-03-4: single-sourcing — the ≠-default comparison uses PROVIDER_TIMEOUT_MS_DEFAULT imported from @comis/core", () => {
    const { warnCalls, logger } = createRecordingLogger();

    // The shared constant IS the schema default — docs, schema, and WARN agree.
    expect(PROVIDER_TIMEOUT_MS_DEFAULT).toBe(120_000);

    // A value equal to the imported constant is silent — proves the module
    // compares against the single-sourced constant, not a local literal copy.
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: PROVIDER_TIMEOUT_MS_DEFAULT } },
      logger,
    });
    expect(warnCalls).toHaveLength(0);

    // One off the constant → WARN, and defaultTimeoutMs renders the constant.
    warnOnProviderTimeoutRedirect({
      providerEntries: { local: { timeoutMs: PROVIDER_TIMEOUT_MS_DEFAULT + 1 } },
      logger,
    });
    expect(warnCalls).toHaveLength(1);
    expect((warnCalls[0]![0] as WarnFields).defaultTimeoutMs).toBe(PROVIDER_TIMEOUT_MS_DEFAULT);
  });
});
