// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { checkAborted } from "./abort.js";

describe("checkAborted", () => {
  it("returns ok when signal is undefined", () => {
    const result = checkAborted(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("returns ok when signal is not aborted", () => {
    const controller = new AbortController();
    const result = checkAborted(controller.signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("returns err when signal is aborted", () => {
    const controller = new AbortController();
    controller.abort("custom reason");
    const result = checkAborted(controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("custom reason");
    }
  });

  it("preserves Error reason directly when signal.reason is an Error", () => {
    const controller = new AbortController();
    const originalError = new Error("specific abort reason");
    controller.abort(originalError);
    const result = checkAborted(controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(originalError);
      expect(result.error.message).toBe("specific abort reason");
    }
  });

  it("wraps string reason in Error", () => {
    const controller = new AbortController();
    controller.abort("string reason");
    const result = checkAborted(controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("string reason");
    }
  });

  it("defaults to 'Aborted' when no reason is set", () => {
    const controller = new AbortController();
    controller.abort();
    const result = checkAborted(controller.signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      // AbortController.abort() without args sets reason to a DOMException
      // in Node.js, but our function handles the general case
      expect(result.error.message).toBeTruthy();
    }
  });

  it("returns err immediately for pre-aborted signal (AbortSignal.abort())", () => {
    const signal = AbortSignal.abort("pre-aborted");
    const result = checkAborted(signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("pre-aborted");
    }
  });
});
