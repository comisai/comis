import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { RequestContext } from "./context.js";
import { RequestContextSchema, getContext, tryGetContext, runWithContext } from "./context.js";

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    sessionKey: "tenant-1:user-1:chan-1",
    traceId: randomUUID(),
    startedAt: Date.now(),
    trustLevel: "user",
    ...overrides,
  };
}

describe("RequestContext", () => {
  describe("runWithContext + getContext", () => {
    it("returns context within scope", () => {
      const ctx = makeContext();
      const result = runWithContext(ctx, () => getContext());
      expect(result).toEqual(ctx);
    });

    it("returns the exact same context object", () => {
      const ctx = makeContext();
      runWithContext(ctx, () => {
        const retrieved = getContext();
        expect(retrieved).toBe(ctx);
      });
    });
  });

  describe("getContext outside scope", () => {
    it("throws descriptive error", () => {
      expect(() => getContext()).toThrow("getContext() called outside of a request context scope");
    });

    it("error message mentions runWithContext", () => {
      expect(() => getContext()).toThrow("runWithContext()");
    });

    it("error message mentions tryGetContext alternative", () => {
      expect(() => getContext()).toThrow("tryGetContext()");
    });
  });

  describe("tryGetContext", () => {
    it("returns undefined outside scope", () => {
      expect(tryGetContext()).toBeUndefined();
    });

    it("returns context within scope", () => {
      const ctx = makeContext();
      runWithContext(ctx, () => {
        expect(tryGetContext()).toEqual(ctx);
      });
    });
  });

  describe("async propagation", () => {
    it("context propagates through async/await", async () => {
      const ctx = makeContext();

      const result = await runWithContext(ctx, async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getContext();
      });

      expect(result).toEqual(ctx);
    });

    it("context propagates through multiple async hops", async () => {
      const ctx = makeContext();

      async function innerAsync(): Promise<RequestContext> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getContext();
      }

      const result = await runWithContext(ctx, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return innerAsync();
      });

      expect(result.traceId).toBe(ctx.traceId);
    });
  });

  describe("nested scopes", () => {
    it("nested runWithContext creates independent scopes", () => {
      const outerCtx = makeContext({ tenantId: "outer" });
      const innerCtx = makeContext({ tenantId: "inner" });

      runWithContext(outerCtx, () => {
        expect(getContext().tenantId).toBe("outer");

        runWithContext(innerCtx, () => {
          expect(getContext().tenantId).toBe("inner");
        });

        // Outer context restored after inner scope exits
        expect(getContext().tenantId).toBe("outer");
      });
    });
  });

  describe("concurrent isolation", () => {
    it("concurrent contexts maintain isolation via Promise.all", async () => {
      const ctx1 = makeContext({ tenantId: "tenant-A", userId: "user-A" });
      const ctx2 = makeContext({ tenantId: "tenant-B", userId: "user-B" });
      const ctx3 = makeContext({ tenantId: "tenant-C", userId: "user-C" });

      const [result1, result2, result3] = await Promise.all([
        runWithContext(ctx1, async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return getContext().tenantId;
        }),
        runWithContext(ctx2, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return getContext().tenantId;
        }),
        runWithContext(ctx3, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return getContext().tenantId;
        }),
      ]);

      expect(result1).toBe("tenant-A");
      expect(result2).toBe("tenant-B");
      expect(result3).toBe("tenant-C");
    });
  });

  describe("RequestContextSchema", () => {
    it("validates correct context", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
    });

    it("tenantId defaults to 'default'", () => {
      const result = RequestContextSchema.parse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.tenantId).toBe("default");
    });

    it("rejects missing required fields", () => {
      const result = RequestContextSchema.safeParse({
        tenantId: "t1",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid traceId format", () => {
      const result = RequestContextSchema.safeParse({
        tenantId: "t1",
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: "not-a-uuid",
        startedAt: Date.now(),
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown fields (strict mode)", () => {
      const result = RequestContextSchema.safeParse({
        tenantId: "t1",
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        extraField: "should-fail",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("trustLevel", () => {
    it("trustLevel defaults to 'admin'", () => {
      const result = RequestContextSchema.parse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.trustLevel).toBe("admin");
    });

    it("accepts admin trustLevel", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        trustLevel: "admin",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trustLevel).toBe("admin");
      }
    });

    it("accepts guest trustLevel", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        trustLevel: "guest",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trustLevel).toBe("guest");
      }
    });

    it("rejects invalid trustLevel", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        trustLevel: "superadmin",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("contentDelimiter", () => {
    it("accepts optional contentDelimiter field", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        contentDelimiter: "abcdef0123456789abcdef01",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contentDelimiter).toBe("abcdef0123456789abcdef01");
      }
    });

    it("context without contentDelimiter still parses (backward compat)", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contentDelimiter).toBeUndefined();
      }
    });

    it("rejects contentDelimiter shorter than 16 chars", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        contentDelimiter: "short",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("channelType", () => {
    it("accepts optional channelType field", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        channelType: "telegram",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.channelType).toBe("telegram");
      }
    });

    it("context without channelType still parses (backward compat)", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.channelType).toBeUndefined();
      }
    });

    it("channelType propagates through runWithContext", () => {
      const ctx = makeContext({ channelType: "discord" });
      const result = runWithContext(ctx, () => getContext());
      expect(result.channelType).toBe("discord");
    });
  });
});
