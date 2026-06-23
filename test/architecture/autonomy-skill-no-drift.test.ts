// SPDX-License-Identifier: Apache-2.0
/**
 * SKILL-03 no-drift gate (Phase 214) — the bundled `autonomy` SKILL.md may name
 * ONLY capabilities and tools that exist in the runtime closed sets. The skill
 * teaches the model what the 210–213 orchestration surface lets it do; if the
 * doc names a cap/tool the gate doesn't have, it misleads the model (wasted
 * turns / 404s / confused operators — T-214-01/T-214-03). This test fails the
 * build on any such drift.
 *
 * The truth is IMPORTED, never hardcoded — `AGENT_CAPABILITIES` +
 * `TOOL_CAPABILITY_MAP` + `HANDLER_CAPABILITY_MAP` from the COMPILED `@comis/core`
 * (vitest alias → core/dist). A hardcoded cap/tool list in this file would
 * reintroduce the very drift it exists to prevent. Same fs-read-of-source +
 * `@comis/core`-dist discipline as `gated-handlers-require-capability.test.ts`
 * and `tool-invoke-cap-map.test.ts`; same "doc artifact pinned to the cap-map"
 * shape as `orchestrate-sdk-drift.test.ts`.
 *
 * THREE vocabularies, each with a non-vacuity guard (a future body rewrite that
 * drops all of a vocabulary must FAIL, not silently pass — the discipline
 * `gated-handlers-require-capability.test.ts:313-326` uses):
 *
 *   Test 1 (caps): every `\borch:[a-z]+\b` token in the body is a member of
 *     `AGENT_CAPABILITIES`. (`orch:browse` is in the union but OFF in every
 *     default profile — the skill must not teach it; if it ever names it the
 *     token is still a real member so Test 1 passes, but the contract review +
 *     the manual grep in the plan's verification catch it.)
 *
 *   Test 2 (in-script tools): every `comis_tools.<name>` token names a real key
 *     of `TOOL_CAPABILITY_MAP` (the §3.6 read/web in-script SDK surface).
 *
 *   Test 3 (model-facing tools — the Pitfall-1 / `tool.invoke` guard): the
 *     orchestration tools the skill teaches the model to CALL (`orchestrate`,
 *     `sessions_spawn`, `pipeline`, `cron`, `message`) are all real, AND the body
 *     never frames `tool.invoke` / `tool_invoke` as a model-facing call (it is
 *     the in-script socket dispatch verb, NOT an agent tool). The real set is
 *     derived from `HANDLER_CAPABILITY_MAP` namespaces (the orchestration RPC
 *     methods → their registered tool names) PLUS the literal `orchestrate`
 *     (which is the wrapper tool — it is in NEITHER cap-map).
 *
 * RED-provable: with no SKILL.md, `readFileSync` throws at describe scope → the
 * whole suite fails (the pre-patch failing state). Inserting a fake `orch:bogus`
 * token fails Test 1; a mistyped `comis_tools.web_serch` fails Test 2; a
 * `tool_invoke(` call-form fails Test 3.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_CAPABILITIES,
  TOOL_CAPABILITY_MAP,
  HANDLER_CAPABILITY_MAP,
} from "@comis/core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SKILL_PATH = resolve(
  REPO_ROOT,
  "packages/daemon/bundled-skills/autonomy/SKILL.md",
);

/** The closed `orch:*` cap union as a runtime Set (no typo'd-cap lookups). */
const CAP_SET: ReadonlySet<string> = new Set<string>(AGENT_CAPABILITIES);
/** The §3.6 read/web in-script tool names (the `comis_tools.*` SDK surface). */
const TOOL_SET: ReadonlySet<string> = new Set<string>(
  Object.keys(TOOL_CAPABILITY_MAP),
);

/**
 * The model-facing orchestration tool names that are REAL, derived from the
 * runtime closed sets (never hardcoded vs the value under test). The wrapper
 * `orchestrate` is in NEITHER cap-map (it runs the jailed script), so it is the
 * one literal added on top of the `HANDLER_CAPABILITY_MAP`-namespace derivation.
 *
 * Mapping the gated orchestration RPC namespaces → their registered model-facing
 * tool names (verified in source: orchestrate-tool.ts:289, sessions-spawn-tool.ts:94,
 * pipeline-tool.ts:388, cron-tool.ts:144, message-tool.ts:147):
 *   session.*  → sessions_spawn   (cap orch:spawn)
 *   graph.*    → pipeline         (cap orch:graph)
 *   cron.*     → cron             (cap orch:cron)
 *   message.*  → message          (cap orch:message)
 */
const NAMESPACE_TO_TOOL: Readonly<Record<string, string>> = {
  session: "sessions_spawn",
  graph: "pipeline",
  cron: "cron",
  message: "message",
};

function deriveRealModelFacingTools(): ReadonlySet<string> {
  const tools = new Set<string>(["orchestrate"]); // the wrapper tool — not cap-mapped
  for (const method of Object.keys(HANDLER_CAPABILITY_MAP)) {
    const namespace = method.split(".")[0];
    const tool = NAMESPACE_TO_TOOL[namespace];
    if (tool !== undefined) tools.add(tool);
  }
  return tools;
}

/** The orchestration tools the skill is expected to TEACH (it covers the full surface). */
const TAUGHT_MODEL_FACING_TOOLS = [
  "orchestrate",
  "sessions_spawn",
  "pipeline",
  "cron",
  "message",
] as const;

describe("autonomy SKILL.md names only real caps + tools (SKILL-03 — no drift)", () => {
  // RED before the SKILL.md exists: readFileSync throws here → the whole suite fails.
  const body = readFileSync(SKILL_PATH, "utf8");

  it("every orch:* token in the skill is a real AgentCapability", () => {
    const tokens = [...body.matchAll(/\borch:[a-z]+\b/g)].map((m) => m[0]);
    expect(
      tokens.length,
      "the skill must actually name caps (non-vacuous) — a rewrite that drops all caps must fail, not pass",
    ).toBeGreaterThan(0);
    const unknown = [...new Set(tokens)].filter((t) => !CAP_SET.has(t));
    expect(
      unknown,
      `skill names caps not in AGENT_CAPABILITIES: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("every comis_tools.<name> the skill names is a real cap-mapped tool", () => {
    // Match only the METHOD-CALL form `comis_tools.<name>(` — the trailing `(`
    // excludes the SDK IMPORT path `"./comis_tools.js"` (which would otherwise
    // capture `js` as a bogus tool name). The optional `?` allows `.read?.(` etc.
    const tokens = [...body.matchAll(/comis_tools\.([a-z_]+)\s*\??\(/g)].map(
      (m) => m[1],
    );
    expect(
      tokens.length,
      "the skill must actually name in-script comis_tools.*(...) calls (non-vacuous)",
    ).toBeGreaterThan(0);
    const unknown = [...new Set(tokens)].filter((t) => !TOOL_SET.has(t));
    expect(
      unknown,
      `skill names in-script tools not in TOOL_CAPABILITY_MAP: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("teaches only real model-facing orchestration tools, and never frames tool.invoke as a model call (Pitfall-1)", () => {
    const real = deriveRealModelFacingTools();

    // Non-vacuity: the derivation actually produced the orchestration tools (a
    // HANDLER_CAPABILITY_MAP refactor that drops the namespaces must not make
    // this assertion empty).
    expect(
      real.size,
      "derived model-facing tool set is empty — HANDLER_CAPABILITY_MAP namespaces regressed",
    ).toBeGreaterThan(1);

    // Every orchestration tool the skill teaches must be a real registered tool.
    const taughtButFake = TAUGHT_MODEL_FACING_TOOLS.filter((t) => !real.has(t));
    expect(
      taughtButFake,
      `skill teaches model-facing tools that are not real: ${taughtButFake.join(", ")}`,
    ).toEqual([]);

    // And each one the skill is meant to teach must actually appear in the body
    // (the skill teaches the FULL surface — a dropped tool is a coverage gap).
    const missingFromBody = TAUGHT_MODEL_FACING_TOOLS.filter(
      (t) => !new RegExp(`\\b${t}\\b`).test(body),
    );
    expect(
      missingFromBody,
      `skill does not mention these orchestration tools it should teach: ${missingFromBody.join(", ")}`,
    ).toEqual([]);

    // THE load-bearing assertion (Pitfall-1): the body must NOT present a
    // model-facing `tool_invoke(...)` CALL. Model-facing tools are snake_case
    // (`sessions_spawn`, `web_search`), so the UNDERSCORE call-form `tool_invoke(`
    // is precisely the mistyped fake-tool class to catch. The DOTTED `tool.invoke`
    // is the real in-script socket dispatch verb — the skill legitimately names it
    // to EXPLAIN (and forbid) it, so it must NOT trip this guard. Hence we forbid
    // only `tool_invoke(`, not `tool.invoke`.
    expect(
      /\btool_invoke\s*\??\(/.test(body),
      "the skill frames tool_invoke(...) as a model-facing CALL — model tools are snake_case but tool.invoke is the in-script socket dispatch verb, not an agent tool (Pitfall-1)",
    ).toBe(false);
  });
});
