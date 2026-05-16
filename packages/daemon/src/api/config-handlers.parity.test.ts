// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { stableStringify } from "../../../../test/support/stable-stringify.js";
import {
  createConfigHandlers,
  coerceConfigValue,
  resolveSchemaForPath,
  unwrapSchema,
  type ConfigHandlerDeps,
} from "./config-handlers.js";

/**
 * Phase 43 parity protection (FILE-SPLIT-03).
 *
 * These snapshots lock the byte-identical output of config-handlers.ts's
 * public-API surface BEFORE the Phase 43 split refactor lands.
 *
 * The post-refactor behavior MUST match these snapshots exactly. Any byte
 * change FAILS this test, which fails `pnpm test`, which fails the
 * per-commit gate.
 *
 * Captured: in Phase 43 Wave 7 sub-plan 43-07a Task 2. Subsequent split
 * commits in 43-07b must keep this test green. Per FILE-SPLIT-17 + OQ-5
 * (progressive deletion), this file is DELETED at the end of 43-07b's
 * config-handlers split commit once each new structure has at least one
 * independent behavior test per extracted module.
 *
 * Source-symbol surface as of capture (config-handlers.ts at the merge
 * base):
 *   value: createConfigHandlers, unwrapSchema, resolveSchemaForPath,
 *          coerceConfigValue
 *   type:  ConfigHandlerDeps (re-exported from api/types.ts)
 *
 * The behavior matrix targets:
 *   1. Public API surface (createConfigHandlers handler-map keys +
 *      the 3 pure helper exports).
 *   2. Representative pure-helper invocations (coerceConfigValue) and a
 *      representative handler invocation (config.history degraded shape +
 *      missing-admin guard message).
 *
 * Methods chosen for behavior snapshots:
 *   coerceConfigValue       (pure helper; 4-case behavior table)
 *   resolveSchemaForPath    (pure helper; returns concrete vs undefined)
 *   unwrapSchema            (pure helper; identity on plain types)
 *   config.history          (degraded path: no configGitManager wired)
 *   config.read             (admin-trust guard error message)
 */

// ---------------------------------------------------------------------------
// Minimal deps factory: vi.fn() stubs only; no IO and no `vi.useFakeTimers()`
//
// createConfigHandlers does not dereference deps at construction time (apart
// from the rate-limiter constant). The handler closures read from deps only
// when invoked. For handler-key snapshots we can therefore pass a structural
// stub; for method-invocation snapshots we wire just the fields the chosen
// methods touch (config.history reads deps.configGitManager + deps.logger;
// config.read reads deps.container + deps.logger BUT only after the admin
// guard short-circuits, so for our chosen "no admin" error path no container
// is needed).
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ConfigHandlerDeps>): ConfigHandlerDeps {
  const noopLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child() {
      return noopLogger;
    },
    bindings: () => ({}),
    isLevelEnabled: () => false,
    flush: vi.fn(),
  };
  return {
    container: { config: {}, secretManager: undefined },
    configPaths: ["/tmp/comis-parity/config.yaml"],
    defaultConfigPaths: ["/tmp/comis-parity/config.yaml"],
    envFilePath: "/tmp/comis-parity/.env",
    logger: noopLogger,
    ...overrides,
  } as unknown as ConfigHandlerDeps;
}

// ---------------------------------------------------------------------------
// Parity describe: sorted by (a) public-API surface (b) behavior matrix
// ---------------------------------------------------------------------------

describe("config-handlers parity (FILE-SPLIT-03)", () => {
  describe("public API surface", () => {
    it("createConfigHandlers: returned handler map has expected method names", () => {
      const handlers = createConfigHandlers(makeDeps());
      expect(stableStringify(Object.keys(handlers).sort())).toMatchSnapshot();
    });
  });

  describe("behavior matrix: representative inputs", () => {
    it("coerceConfigValue: covers boolean, number, string, and unknown-schema fallback", () => {
      const cases = {
        boolTrue: coerceConfigValue("true", z.boolean()),
        boolFalse: coerceConfigValue("false", z.boolean()),
        boolPassThrough: coerceConfigValue("maybe", z.boolean()),
        numberValid: coerceConfigValue("42", z.number()),
        numberEmpty: coerceConfigValue("", z.number()),
        numberNonNumeric: coerceConfigValue("abc", z.number()),
        stringPassThrough: coerceConfigValue("hello", z.string()),
        undefinedSchemaBool: coerceConfigValue("true", undefined),
        undefinedSchemaNumber: coerceConfigValue("3.14", undefined),
        nonStringPassThrough: coerceConfigValue(true, z.boolean()),
      };
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("resolveSchemaForPath: returns concrete schema for known path and undefined for unknown", () => {
      const root = z.object({
        agents: z.object({
          default: z.object({
            model: z.string(),
            budget: z.object({ maxTokens: z.number() }),
          }),
        }),
      });
      const cases = {
        knownDeep: resolveSchemaForPath(root, "agents", "default.budget.maxTokens") instanceof z.ZodNumber,
        knownLeafString: resolveSchemaForPath(root, "agents", "default.model") instanceof z.ZodString,
        unknownSection: resolveSchemaForPath(root, "missing", "x") === undefined,
        unknownKey: resolveSchemaForPath(root, "agents", "missing.path") === undefined,
        nonObjectRoot: resolveSchemaForPath(z.string(), "agents", undefined) === undefined,
      };
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("unwrapSchema: identity on plain types and unwraps optional, nullable, and default", () => {
      const cases = {
        identityString: unwrapSchema(z.string()) instanceof z.ZodString,
        identityNumber: unwrapSchema(z.number()) instanceof z.ZodNumber,
        optionalString: unwrapSchema(z.string().optional()) instanceof z.ZodString,
        nullableString: unwrapSchema(z.string().nullable()) instanceof z.ZodString,
        defaultString: unwrapSchema(z.string().default("x")) instanceof z.ZodString,
        undefinedPassThrough: unwrapSchema(undefined) === undefined,
      };
      expect(stableStringify(cases)).toMatchSnapshot();
    });

    it("config.history: returns expected degraded envelope when configGitManager is absent (admin trust)", async () => {
      const handlers = createConfigHandlers(makeDeps());
      const result = await handlers["config.history"]!({ _trustLevel: "admin" });
      expect(stableStringify(result)).toMatchSnapshot();
    });

    it("config.read: rejects with admin-trust guard message when trust is missing", async () => {
      const handlers = createConfigHandlers(makeDeps());
      let captured: unknown;
      try {
        await handlers["config.read"]!({});
      } catch (e) {
        captured = (e as Error).message;
      }
      expect(stableStringify({ error: captured })).toMatchSnapshot();
    });
  });
});
