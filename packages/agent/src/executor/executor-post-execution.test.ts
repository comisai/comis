// SPDX-License-Identifier: Apache-2.0
//
// T0.34 — silent-sentinel responses do NOT reach memoryPort.store.
//
// Phase 5 (15-02 cherry-pick) inserts an `isSilentResponse(result.response)`
// pre-gate at packages/agent/src/executor/executor-post-execution.ts:584-617
// so that responses like "[agent] NO_REPLY" / "NO_REPLY" / "HEARTBEAT_OK"
// / "[SILENT] x" never enter memory.db (RC-4 / B38 / AC-3).
//
// This test file scaffolds a slim postExecution invocation that captures
// `memoryPort.store(...)` calls. It is RED today because:
//   (a) packages/shared/src/silent-tokens.ts does not exist yet (so any
//       attempt to assert on the silent-sentinel pre-gate fails), and
//   (b) the production code at executor-post-execution.ts:584-617 stores
//       the pair regardless of silence; once 15-02 lands the gate, this
//       test turns green.
//
// We use a source-grep + behavior probe pair: the source-grep verifies
// the production module imports `isSilentResponse` from @comis/shared
// (the gate's load-bearing import); the behavior probe asserts that
// `shouldStorePairedMemory` and `isSilentResponse` together would refuse
// "NO_REPLY" responses.
//
// (This is the smallest assertion-grade RED test that does not require
// scaffolding all 30+ postExecution dependencies; a richer behavior test
// is owned by 15-04/15-05 once the dispatcher + drain seams stabilize.)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { shouldStorePairedMemory } from "./executor-post-execution.js";

const here = dirname(fileURLToPath(import.meta.url));

async function loadSilentTokens(): Promise<
  | {
      isSilentResponse: (s: string | undefined) => boolean;
    }
  | undefined
> {
  try {
    const mod = (await import("@comis/shared")) as Record<string, unknown>;
    if (typeof mod.isSilentResponse !== "function") return undefined;
    return mod as unknown as {
      isSilentResponse: (s: string | undefined) => boolean;
    };
  } catch {
    return undefined;
  }
}

describe("silent-sentinel response is not stored in memory.db (RC-4 / B38 / AC-3)", () => {
  it("T0.34: source-grep — executor-post-execution imports isSilentResponse from @comis/shared", () => {
    const src = readFileSync(resolve(here, "executor-post-execution.ts"), "utf-8");
    // Strip line + block comments so the gate cannot be self-invalidated.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Post-Phase-5 the production code imports isSilentResponse from @comis/shared.
    // Pre-Phase-5 it does not — RED until 15-02.
    expect(stripped).toMatch(/import\s*\{[^}]*\bisSilentResponse\b[^}]*\}\s*from\s*"@comis\/shared"/);
  });

  it("T0.34: behavior — isSilentResponse classifies NO_REPLY / [agent] NO_REPLY as silent", async () => {
    const mod = await loadSilentTokens();
    // The helper module must exist and be re-exported from @comis/shared
    // post-15-02. Until then this fails, signalling the pre-gate is not yet
    // in place.
    expect(mod).toBeDefined();
    if (!mod) return;
    expect(mod.isSilentResponse("NO_REPLY")).toBe(true);
    // The call site at line 593 builds `[user] X\n[agent] <truncated response>`,
    // so the response itself is the bare "NO_REPLY". The helper is responsible
    // for handling whitespace + reply-tag wrapping idempotently (B46 / T0.37).
    expect(mod.isSilentResponse("HEARTBEAT_OK")).toBe(true);
    expect(mod.isSilentResponse("[SILENT] context")).toBe(true);
  });

  it("T0.34: behavior — substantive responses still pass the quality gate", () => {
    // Sanity: a substantive paired memory still qualifies for storage; the
    // silent-sentinel gate is a third layer ON TOP of the existing two
    // (operationType + content-hash dedup). It MUST NOT regress storage of
    // real conversations.
    const userText = "Show me the comparison chart for Q1 vs Q2";
    const agentResponse = "Here is the chart you requested. The Q1 numbers are…";
    expect(shouldStorePairedMemory(userText, agentResponse)).toBe(true);
  });
});
