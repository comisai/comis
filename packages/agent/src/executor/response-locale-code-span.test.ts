// SPDX-License-Identifier: Apache-2.0
/**
 * Locale enforcement must not read a data table as the response's language.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { evaluateResponseLocale } from "./resolve-response-locale-policy.js";

const hebrewPolicy = {
  enforceLocale: true,
  locale: "und-Hebr",
  localeSource: "request",
} as unknown as Parameters<typeof evaluateResponseLocale>[0];

describe("evaluateResponseLocale — protected spans carry no language signal", () => {
  it("accepts Hebrew prose wrapped around an HTML code table", () => {
    // The live failure: a Hebrew answer whose body is a monospaced table of
    // plate numbers and English channel names was classified Latn against an
    // enforced und-Hebr, and every repair attempt failed the same way, so the
    // user received "I could not produce a response in the requested language"
    // instead of a correct answer.
    const response = [
      "<b>סטטוס אירועים פתוחים:</b>",
      "<pre><code>event                 count  vehicles",
      "--------------------  -----  ------------------------",
      "drowsiness                2  87694702, 84370202",
      "phone_use                 1  70875802",
      "smoking                   0  -",
      "</code></pre>",
      "שני רכבים דורשים טיפול מיידי.",
    ].join("\n");

    expect(evaluateResponseLocale(hebrewPolicy, response)).toBeUndefined();
  });

  it("accepts the same shape with a markdown fence", () => {
    const response = [
      "<b>סטטוס:</b>",
      "```",
      "plate      status   last_report",
      "87694702   parked   2026-08-06T08:00Z",
      "84370202   driving  2026-08-06T08:02Z",
      "```",
      "שני רכבים מדווחים כרגיל.",
    ].join("\n");

    expect(evaluateResponseLocale(hebrewPolicy, response)).toBeUndefined();
  });

  it("still rejects a response whose PROSE is in the wrong script", () => {
    // The guard must not become a blanket exemption: real Latin prose against an
    // enforced Hebrew locale is the case enforcement exists for.
    const response = [
      "<b>Open event status:</b>",
      "<pre><code>event      count",
      "drowsiness     2",
      "</code></pre>",
      "Two vehicles need immediate attention, and I have listed them above for review.",
    ].join("\n");

    expect(evaluateResponseLocale(hebrewPolicy, response)).toBeDefined();
  });

  it("exempts a response that is nothing but a code table", () => {
    // No prose at all means no script-bearing prose to judge; enforcing a script
    // here can only discard a correct answer.
    const response = "<pre><code>plate      km\n87694702  120\n</code></pre>";
    expect(evaluateResponseLocale(hebrewPolicy, response)).toBeUndefined();
  });

  it("keeps enforcing when the table is absent", () => {
    expect(
      evaluateResponseLocale(hebrewPolicy, "All twelve vehicles are currently parked at the depot."),
    ).toBeDefined();
    expect(
      evaluateResponseLocale(hebrewPolicy, "כל שנים עשר הרכבים חונים כרגע במחסן."),
    ).toBeUndefined();
  });
});
