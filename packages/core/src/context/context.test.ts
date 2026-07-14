// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

    it("RequestContext carries agentId when provided; absent stays undefined", () => {
      // agentId is OPTIONAL (not known at channel ingress, like sessionKey)
      // and populated at the executor entry; the ctx_* tools read it
      // per-call to scope LCD reads by agent.
      const withAgent = RequestContextSchema.parse({
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        agentId: "agent-a",
      });
      expect(withAgent.agentId).toBe("agent-a");

      // Absent → undefined (no default, matching sessionKey).
      const withoutAgent = RequestContextSchema.parse({
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(withoutAgent.agentId).toBeUndefined();

      // An empty-string agentId is rejected (only undefined is the "not resolved" state).
      const empty = RequestContextSchema.safeParse({
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        agentId: "",
      });
      expect(empty.success).toBe(false);
    });

    it("RequestContext carries an authenticated gateway client identity when provided", () => {
      const withClient = RequestContextSchema.parse({
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        clientId: "dashboard-client",
      });
      expect(withClient.clientId).toBe("dashboard-client");

      const withoutClient = RequestContextSchema.parse({
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(withoutClient.clientId).toBeUndefined();

      const emptyClient = RequestContextSchema.safeParse({
        userId: "u1",
        sessionKey: "t1:u1:c1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        clientId: "",
      });
      expect(emptyClient.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // resolvedLanguage — ALS carrier (mirrors resolvedModel)
  // ---------------------------------------------------------------------------
  describe("resolvedLanguage (ALS carrier)", () => {
    it("RequestContext carries resolvedLanguage when provided (parses through strictObject)", () => {
      // z.strictObject REJECTS unknown keys, so the carrier field MUST be
      // modeled for the parent's ALS set-side mutation to survive a parse.
      // Mirrors how the resolvedModel field is modeled.
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
        resolvedLanguage: "he",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.resolvedLanguage).toBe("he");
      }
    });

    it("context without resolvedLanguage still parses (optional) and yields undefined", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "default:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.resolvedLanguage).toBeUndefined();
      }
    });

    it("resolvedLanguage set on the LIVE context is observable via tryGetContext within scope (sub-agent inheritance shape)", () => {
      // Mirrors the resolvedModel ALS mutation in pi-executor: the parent casts
      // through Record<string, unknown> and writes resolvedLanguage onto the live
      // context; sub-agent-leg reads see it via tryGetContext()?.resolvedLanguage.
      const ctx = makeContext();
      runWithContext(ctx, () => {
        (getContext() as Record<string, unknown>).resolvedLanguage = "ar";
        expect(tryGetContext()?.resolvedLanguage).toBe("ar");
      });
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

    it("context without contentDelimiter still parses (field is optional)", () => {
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

    it("context without channelType still parses (field is optional)", () => {
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

  // ---------------------------------------------------------------------------
  // Ingress-context without userId/sessionKey
  // ---------------------------------------------------------------------------
  describe("ingress context without userId/sessionKey", () => {
    it("runWithContext accepts ingress context with only traceId + channelType (no userId/sessionKey)", () => {
      // Validates that userId/sessionKey are optional on the schema.
      const traceId = randomUUID();
      const ctx = RequestContextSchema.parse({
        traceId,
        channelType: "telegram",
        startedAt: Date.now(),
      });
      const result = runWithContext(ctx, () => getContext());
      expect(result.traceId).toBe(traceId);
      expect(result.userId).toBeUndefined();
      expect(result.sessionKey).toBeUndefined();
      expect(result.channelType).toBe("telegram");
    });

    it("still rejects empty-string userId (z.string().min(1).optional() — only undefined is acceptable, not empty)", () => {
      // An empty string "" is NOT an acceptable userId — only omission (undefined) is.
      const result = RequestContextSchema.safeParse({
        traceId: randomUUID(),
        startedAt: Date.now(),
        userId: "",
      });
      expect(result.success).toBe(false);
    });

    it("still accepts full userId + sessionKey when both are present (post-queue callers unaffected)", () => {
      const result = RequestContextSchema.safeParse({
        userId: "user-1",
        sessionKey: "tenant-1:user-1:chan-1",
        traceId: randomUUID(),
        startedAt: Date.now(),
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userId).toBe("user-1");
        expect(result.data.sessionKey).toBe("tenant-1:user-1:chan-1");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Shrink-only audit — getContext().userId derefs
  // ---------------------------------------------------------------------------
  describe("getContext().userId/.sessionKey deref audit (shrink-only)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const REPO_ROOT = resolve(here, "../../../../..");
    const EXCLUDED_DIRS = new Set([
      "dist",
      "node_modules",
      "__tests__",
      "__test-helpers",
      "fixtures",
      "__snapshots__",
    ]);

    function walkTsFiles(rootDir: string): string[] {
      const out: string[] = [];
      function recur(dir: string): void {
        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          if (name.startsWith(".")) continue;
          if (EXCLUDED_DIRS.has(name)) continue;
          const p = join(dir, name);
          let stat;
          try {
            stat = statSync(p);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            recur(p);
          } else if (
            stat.isFile() &&
            p.endsWith(".ts") &&
            !name.endsWith(".test.ts") &&
            !name.endsWith(".test.tsx") &&
            !name.endsWith(".d.ts")
          ) {
            out.push(p);
          }
        }
      }
      recur(rootDir);
      return out;
    }

    it("zero production call sites dereference getContext().userId or getContext().sessionKey outside post-queue scope", () => {
      const packagesDir = resolve(REPO_ROOT, "packages");
      const files = walkTsFiles(packagesDir);
      const DEREF_RE = /getContext\(\)\s*\.\s*(userId|sessionKey)/;
      const violations: string[] = [];
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        if (DEREF_RE.test(content)) {
          violations.push(f.slice(REPO_ROOT.length + 1));
        }
      }
      expect(
        violations,
        `Found getContext().userId or getContext().sessionKey deref in production code. ` +
          `Use tryGetContext()?.userId ?? fallback — userId/sessionKey are .optional(). ` +
          `Violating files:\n${violations.map((v) => `  ${v}`).join("\n")}`,
      ).toEqual([]);
    });
  });
});
