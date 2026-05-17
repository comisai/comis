// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for domain/poll-input.ts.
 *
 * Covers the six branch paths in this file:
 *   - normalizePollDurationHours undefined branch + clamp lower/upper
 *   - validatePollInput safeParse !success branch
 *   - validatePollInput maxSelections > options.length branch
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  normalizePollDurationHours,
  validatePollInput,
} from "./poll-input.js";

describe("normalizePollDurationHours()", () => {
  it("returns the default 24 hours when input is undefined", () => {
    expect(normalizePollDurationHours(undefined)).toBe(24);
  });

  it("clamps hours below the lower bound up to 1", () => {
    expect(normalizePollDurationHours(0)).toBe(1);
    expect(normalizePollDurationHours(-5)).toBe(1);
  });

  it("clamps hours above the upper bound down to 168", () => {
    expect(normalizePollDurationHours(200)).toBe(168);
    expect(normalizePollDurationHours(1000)).toBe(168);
  });

  it("returns the input unchanged when within the 1-168 bounds", () => {
    expect(normalizePollDurationHours(24)).toBe(24);
    expect(normalizePollDurationHours(1)).toBe(1);
    expect(normalizePollDurationHours(168)).toBe(168);
  });
});

describe("validatePollInput()", () => {
  it("returns ok result for a valid minimal poll with two options", () => {
    const result = validatePollInput({
      question: "Pick one",
      options: ["A", "B"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.question).toBe("Pick one");
      expect(result.value.maxSelections).toBe(1); // default
    }
  });

  it("returns err result when schema validation fails (missing question)", () => {
    const result = validatePollInput({ options: ["A", "B"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Zod 4 emits "Invalid input: expected string, received undefined" for
      // missing required string fields.
      expect(result.error.message).toMatch(/invalid input|expected string|required/i);
    }
  });

  it("returns err result when options array has fewer than two entries", () => {
    const result = validatePollInput({
      question: "Pick",
      options: ["only-one"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/at least 2 options/);
    }
  });

  it("returns err result when maxSelections exceeds the number of options", () => {
    const result = validatePollInput({
      question: "Pick",
      options: ["A", "B"],
      maxSelections: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/maxSelections.*must not exceed/);
    }
  });

  it("returns ok result when maxSelections exactly equals options.length", () => {
    const result = validatePollInput({
      question: "Pick any",
      options: ["A", "B", "C"],
      maxSelections: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxSelections).toBe(3);
    }
  });
});
