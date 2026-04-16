import { describe, it, expect } from "vitest";
import type { Result } from "./result.js";
import { ok, err, tryCatch, fromPromise } from "./result.js";

describe("Result<T, E>", () => {
  describe("ok()", () => {
    it("returns { ok: true, value: T }", () => {
      const result = ok(42);
      expect(result).toEqual({ ok: true, value: 42 });
    });

    it("allows access to .value when narrowed via ok === true", () => {
      const result: Result<number> = ok(42);
      if (result.ok) {
        // TypeScript narrows to { ok: true, value: number }
        expect(result.value).toBe(42);
      } else {
        throw new Error("Should not reach here");
      }
    });

    it("works with complex types", () => {
      const result = ok({ name: "test", count: 3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("test");
        expect(result.value.count).toBe(3);
      }
    });
  });

  describe("err()", () => {
    it("returns { ok: false, error: E }", () => {
      const error = new Error("fail");
      const result = err(error);
      expect(result).toEqual({ ok: false, error });
    });

    it("allows access to .error when narrowed via ok === false", () => {
      const result: Result<number> = err(new Error("fail"));
      if (!result.ok) {
        // TypeScript narrows to { ok: false, error: Error }
        expect(result.error.message).toBe("fail");
      } else {
        throw new Error("Should not reach here");
      }
    });

    it("works with custom error types", () => {
      const result = err({ code: "NOT_FOUND", message: "not found" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("tryCatch()", () => {
    it("returns ok(value) when function succeeds", () => {
      const result = tryCatch(() => 42);
      expect(result).toEqual({ ok: true, value: 42 });
    });

    it("returns err(Error) when function throws Error", () => {
      const result = tryCatch(() => {
        throw new Error("boom");
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("boom");
      }
    });

    it("wraps non-Error thrown values in Error", () => {
      const result = tryCatch(() => {
        throw "string error";
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("string error");
      }
    });

    it("wraps thrown numbers in Error", () => {
      const result = tryCatch(() => {
        throw 404;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("404");
      }
    });

    it("handles malicious object with toString() that throws", () => {
      const malicious = {
        toString() {
          throw new Error("toString attack");
        },
      };
      const result = tryCatch(() => {
        throw malicious;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("[non-stringifiable value]");
      }
    });
  });

  describe("fromPromise()", () => {
    it("returns ok(value) when promise resolves", async () => {
      const result = await fromPromise(Promise.resolve(42));
      expect(result).toEqual({ ok: true, value: 42 });
    });

    it("returns err(Error) when promise rejects with Error", async () => {
      const result = await fromPromise(Promise.reject(new Error("boom")));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("boom");
      }
    });

    it("wraps non-Error rejection in Error", async () => {
      const result = await fromPromise(Promise.reject("string"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("string");
      }
    });

    it("wraps null rejection in Error", async () => {
      const result = await fromPromise(Promise.reject(null));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("null");
      }
    });

    it("handles malicious object with toString() that throws", async () => {
      const malicious = {
        toString() {
          throw new Error("toString attack");
        },
      };
      const result = await fromPromise(Promise.reject(malicious));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("[non-stringifiable value]");
      }
    });

    it("wraps undefined rejection in Error", async () => {
      const result = await fromPromise(Promise.reject(undefined));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("undefined");
      }
    });
  });

  describe("tryCatch() - undefined edge cases", () => {
    it("wraps thrown undefined in Error", () => {
      const result = tryCatch(() => {
        throw undefined;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("undefined");
      }
    });

    it("wraps thrown void (undefined) in Error", () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      const result = tryCatch(() => {
        // This explicitly tests the edge case of a void throw
        throw void 0;
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("undefined");
      }
    });
  });
});
