// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  catalogFromLocalePacks,
  createLocaleCatalog,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
  selectOutputStarvedAnnotation,
  selectPipelineTimeoutReply,
} from "./degraded-reply-i18n.js";

describe("extensible locale catalog", () => {
  it("uses an application-supplied locale pack for any canonical BCP-47 tag", () => {
    const catalog = createLocaleCatalog({
      "fr-CA": {
        context_exhausted: "localized base ",
        advice_default: "localized advice",
        output_starved: "localized output limit",
        loop_detected: "localized loop",
      },
    });
    expect(selectContextExhaustedReply("fr-CA", {}, catalog)).toBe(
      "localized base localized advice",
    );
    expect(selectOutputStarvedAnnotation("fr-CA", catalog)).toBe("localized output limit");
    expect(selectLoopDetectedReply("fr-CA", {}, catalog)).toBe("localized loop");
  });

  it("falls back from a locale variant to an injected language pack", () => {
    const catalog = createLocaleCatalog({ fr: { output_starved: "language fallback" } });
    expect(selectOutputStarvedAnnotation("fr-CA", catalog)).toBe("language fallback");
  });

  it("uses the English platform pack for unknown or malformed locales", () => {
    expect(selectOutputStarvedAnnotation("qaa-Zzzz")).toContain("output limit");
    expect(selectOutputStarvedAnnotation("not a locale")).toContain("output limit");
  });

  it("never exposes internal configuration paths in user-facing messages", () => {
    expect(selectContextExhaustedReply(undefined, { capabilityClass: "small" }))
      .not.toContain("contextEngine.");
  });
});

// The pipeline timeout is the LAST thing a user sees on a turn that ran to the
// wall-clock ceiling. It was a hard-coded English literal at the send site,
// outside this mechanism entirely — so a deployment answering in another
// language still got English, and no pack could ever reach it.
describe("pipeline timeout reply", () => {
  it("is a member of the localizable platform-reply set", () => {
    const catalog = createLocaleCatalog({ "fr-CA": { pipeline_timeout: "localized timeout" } });
    expect(selectPipelineTimeoutReply("fr-CA", {}, catalog)).toBe("localized timeout");
  });

  it("falls back to the English pack with no locale or no matching pack", () => {
    expect(selectPipelineTimeoutReply(undefined, {})).toContain("taking too long");
    expect(selectPipelineTimeoutReply("fr-CA", {}, createLocaleCatalog({}))).toContain(
      "taking too long",
    );
  });

  it("appends the incident ref so `comis explain` is one step from the chat", () => {
    expect(selectPipelineTimeoutReply(undefined, { traceId: "t-1" })).toContain("(incident t-1)");
  });
});

// Operator config carries packs as an open string->string record: core cannot
// own the message-id list without the runtime's reply vocabulary leaking into
// it. The runtime therefore validates the ids at the boundary.
describe("catalogFromLocalePacks", () => {
  it("builds a working catalog from raw operator config", () => {
    const catalog = catalogFromLocalePacks({ he: { pipeline_timeout: "בקשה ארכה מדי" } });
    expect(selectPipelineTimeoutReply("he", {}, catalog)).toBe("בקשה ארכה מדי");
  });

  it("returns the English-only default catalog for undefined or empty packs", () => {
    expect(selectPipelineTimeoutReply("he", {}, catalogFromLocalePacks(undefined)))
      .toContain("taking too long");
  });

  it("drops unknown message ids instead of silently carrying dead config", () => {
    const onUnknown: string[] = [];
    const catalog = catalogFromLocalePacks(
      { he: { pipeline_timeout: "ok", not_a_message_id: "dead" } },
      (locale, id) => onUnknown.push(`${locale}:${id}`),
    );
    expect(selectPipelineTimeoutReply("he", {}, catalog)).toBe("ok");
    expect(onUnknown).toEqual(["he:not_a_message_id"]);
  });
});

// ---------------------------------------------------------------------------
// Script-only response locales must be able to reach an operator pack.
//
// The runtime can resolve a response locale to a SCRIPT-only tag (`und-Hebr`),
// for which `new Intl.Locale("und-Hebr").language` is `undefined` — so the plain
// language-subtag fallback cannot match an operator's `he` pack, and every runtime
// banner fell through to English. Live: a fully-Hebrew answer carried an
// English-only "background task failed" notice, and another carried BOTH (the model
// wrote Hebrew, the runtime appended English).
//
// The fallback uses ICU likely-subtags via `maximize()`, so it is generic — no
// language is hardcoded — and it runs LAST, after exact and plain-language matches,
// because maximize is a probabilistic guess (`und-Cyrl` maximizes to `ru`, not `uk`).
// It can only select an operator-supplied pack; with no pack it still yields English.
// ---------------------------------------------------------------------------

describe("createLocaleCatalog — script-only locale fallback", () => {
  it("resolves und-Hebr to an operator he pack", () => {
    const catalog = createLocaleCatalog({ he: { output_starved: "תשובה בעברית" } });
    expect(catalog.resolve("und-Hebr", "output_starved")).toBe("תשובה בעברית");
  });

  it("resolves und-Arab to an operator ar pack", () => {
    const catalog = createLocaleCatalog({ ar: { output_starved: "arabic pack" } });
    expect(catalog.resolve("und-Arab", "output_starved")).toBe("arabic pack");
  });

  it("prefers an EXACT script-tag pack over the maximize fallback", () => {
    const catalog = createLocaleCatalog({
      "und-Hebr": { output_starved: "exact script pack" },
      he: { output_starved: "language pack" },
    });
    expect(catalog.resolve("und-Hebr", "output_starved")).toBe("exact script pack");
  });

  it("falls back to English when no pack matches the script", () => {
    const catalog = createLocaleCatalog({ fr: { output_starved: "french" } });
    const resolved = catalog.resolve("und-Hebr", "output_starved");
    expect(resolved).not.toBe("french");
    expect(typeof resolved).toBe("string");
  });

  it("still resolves a plain language tag exactly", () => {
    const catalog = createLocaleCatalog({ he: { output_starved: "hebrew" } });
    expect(catalog.resolve("he", "output_starved")).toBe("hebrew");
  });
});
