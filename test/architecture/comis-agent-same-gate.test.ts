// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture gate: the `comis-agent` CLI surface reaches the SAME capability
 * gate the typed tools and the `orchestrate(script)` surface reach — no weaker
 * path, no advertised-but-denied verb.
 *
 * Surface 3 (the in-jail `comis-agent` CLI) is shell fluency over the SAME
 * handlers + the SAME `requireCapability` gate as Surface 1 (typed tools) and
 * Surface 2 (the orchestrate script). `CLI_SUBCOMMAND_MAP` adds no `cap` field —
 * the cap is DERIVED from the existing cap-maps. The success criterion "same
 * gate, no weaker path" is true BY CONSTRUCTION (the module-load assertion in
 * `cli-subcommand-map.ts` already aborts import on a non-cap / non-orch /
 * deny-by-origin target), but a regression-proof TEST is demanded — and there is
 * a real hole the module-load assertion deliberately leaves to
 * THIS test: a denylisted `orch:skill` target like `skills.create` is `orch:*`
 * (so it passes the orch check) yet the cap socket's denylist pre-check throws
 * BEFORE `validate()` — i.e. it is a CLOSED DOOR, not a same gate. The
 * @comis/core assertion cannot see the daemon's denylist (importing it would be a
 * package cycle), so the denylist cross-check lives HERE.
 *
 * This test pins, against the COMPILED runtime values (the actual
 * `CLI_SUBCOMMAND_MAP`/`TOOL_CAPABILITY_MAP`/`TOOL_ROUTE_MAP`/
 * `HANDLER_CAPABILITY_MAP`/`SELF_SCOPED_AGENT_READS` from `@comis/core` + the
 * `DENYLISTED_RPC_METHODS` from `@comis/daemon`, NOT source AST — same rationale
 * as `tool-invoke-cap-map.test.ts`):
 *
 *   (1) every `CLI_SUBCOMMAND_MAP` target resolves to the SAME cap-map gate the
 *       typed tools use AND is NOT a denylisted closed door.
 *   (2) every `{kind:"tool"}` subcommand reaches the `tool.invoke` gate via a
 *       real `TOOL_ROUTE_MAP` route (and is not in `SUB_AGENT_TOOL_DENYLIST`).
 *   (3) every `{kind:"method"}` subcommand is `orch:*`-gated or a self-scoped
 *       read, never denylisted / deny-by-origin / ungated-foreign.
 *   (4) the predicate DISCRIMINATES — negative fixtures (incl. the
 *       `skills.create` denylisted CLOSED DOOR the un-hardened predicate would
 *       have falsely passed) make the SAME predicate return `ok:false`.
 *
 * The denylist is DERIVED from the daemon export (not a hand-copied literal), so
 * a new denylisted method is covered automatically. A future subcommand that
 * reaches a weaker / denylisted / deny-by-origin path becomes a
 * `pnpm test:architecture` BUILD failure.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  CLI_SUBCOMMAND_MAP,
  TOOL_CAPABILITY_MAP,
  TOOL_ROUTE_MAP,
  SUB_AGENT_TOOL_DENYLIST,
  HANDLER_CAPABILITY_MAP,
  SELF_SCOPED_AGENT_READS,
  type CliCallTarget,
} from "@comis/core";
// DERIVED denylist source — the SAME closed-door set the cap socket's pre-check
// uses (re-exported from the @comis/daemon top-level barrel). Importing
// it here keeps the denylist check from drifting into a hand-maintained literal.
import { DENYLISTED_RPC_METHODS } from "@comis/daemon";

const SELF_SCOPED_READ_SET: ReadonlySet<string> = new Set<string>(SELF_SCOPED_AGENT_READS);
const DENYLISTED_METHOD_SET: ReadonlySet<string> = new Set<string>(
  Object.keys(DENYLISTED_RPC_METHODS),
);

/** The verdict shape — `ok:false` carries a `reason` so a failure names WHY. */
interface GateVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * The HARDENED same-gate predicate, factored as a PURE function over the entry +
 * the cap-maps + the denylist so it runs identically against the real
 * `CLI_SUBCOMMAND_MAP` AND the poisoned negative fixtures (the
 * discriminating power is proven, not asserted).
 *
 * A target "resolves to the same gate" iff:
 *   - `{kind:"tool"}`: tool ∈ TOOL_CAPABILITY_MAP (cap-mapped) AND ∈ TOOL_ROUTE_MAP
 *     (a real dispatch route) AND ∉ SUB_AGENT_TOOL_DENYLIST.
 *   - `{kind:"method"}`: method ∈ HANDLER_CAPABILITY_MAP AND its classification is
 *     `orch:*` OR a SELF_SCOPED_AGENT_READS member, AND ∉ DENYLISTED_RPC_METHODS
 *     (the keystone closed-door check), AND NOT `deny-by-origin`, AND NOT an
 *     `ungated` method outside the self-scoped set.
 *
 * NOTE the `orch:*` branch INCLUDES `orch:skill` deliberately: the denylist is
 * the SOLE thing that closes the `skills.*` door (every `orch:skill` method is a
 * DENYLISTED_RPC_METHODS key — pinned by its own invariant test below). Special-
 * casing `orch:skill` here would mask the denylist's load-bearing role and make
 * the "remove the denylist → skills.create passes" counter-proof vacuous. The
 * denylist DOES the work; this predicate trusts it (and proves it discriminates).
 */
function resolvesToSameGate(
  entry: CliCallTarget,
  capMaps: {
    readonly toolMap: Readonly<Record<string, unknown>>;
    readonly toolRouteMap: Readonly<Record<string, unknown>>;
    readonly toolDenylist: ReadonlySet<string>;
    readonly handlerMap: Readonly<Record<string, string>>;
    readonly selfScopedReads: ReadonlySet<string>;
  },
  denylist: ReadonlySet<string>,
): GateVerdict {
  if (entry.kind === "tool") {
    if (!(entry.tool in capMaps.toolMap)) {
      return { ok: false, reason: `tool "${entry.tool}" is not a TOOL_CAPABILITY_MAP key` };
    }
    if (!(entry.tool in capMaps.toolRouteMap)) {
      return { ok: false, reason: `tool "${entry.tool}" has no TOOL_ROUTE_MAP route` };
    }
    if (capMaps.toolDenylist.has(entry.tool)) {
      return { ok: false, reason: `tool "${entry.tool}" is in SUB_AGENT_TOOL_DENYLIST` };
    }
    return { ok: true };
  }
  // entry.kind === "method"
  const classification = capMaps.handlerMap[entry.method];
  if (classification === undefined) {
    return { ok: false, reason: `method "${entry.method}" is not a HANDLER_CAPABILITY_MAP key` };
  }
  if (classification === "deny-by-origin") {
    return { ok: false, reason: `method "${entry.method}" is deny-by-origin (admin/control-plane)` };
  }
  // The keystone: a denylisted target (e.g. skills.create) is a CLOSED DOOR the
  // cap socket throws on BEFORE validate() — NOT the same gate the typed tools
  // reach. This is the check the un-hardened (orch:*-only) predicate omitted.
  if (denylist.has(entry.method)) {
    return { ok: false, reason: `method "${entry.method}" is in DENYLISTED_RPC_METHODS (closed door)` };
  }
  const isOrchCap = classification.startsWith("orch:");
  const isSelfScoped = capMaps.selfScopedReads.has(entry.method);
  if (!isOrchCap && !isSelfScoped) {
    return {
      ok: false,
      reason: `method "${entry.method}" is classified "${classification}" — not orch:* nor a self-scoped read`,
    };
  }
  return { ok: true };
}

/** The real cap-maps bundle (the compiled @comis/core runtime values). */
const REAL_CAP_MAPS = {
  toolMap: TOOL_CAPABILITY_MAP as Readonly<Record<string, unknown>>,
  toolRouteMap: TOOL_ROUTE_MAP as Readonly<Record<string, unknown>>,
  toolDenylist: SUB_AGENT_TOOL_DENYLIST,
  handlerMap: HANDLER_CAPABILITY_MAP as Readonly<Record<string, string>>,
  selfScopedReads: SELF_SCOPED_READ_SET,
} as const;

const CLI_ENTRIES: ReadonlyArray<readonly [string, CliCallTarget]> = Object.entries(
  CLI_SUBCOMMAND_MAP,
) as ReadonlyArray<readonly [string, CliCallTarget]>;

describe("comis-agent CLI surface reaches the same capability gate (no weaker path)", () => {
  it("derives the denylisted-method set from the @comis/daemon export (not a drifting literal)", () => {
    // Soundness anchor: the import resolved to the REAL daemon denylist (so the
    // proof can never silently empty). skills.create (the keystone closed door)
    // MUST be present in the derived set — if it is not, the export drifted.
    expect(DENYLISTED_METHOD_SET.size).toBeGreaterThan(0);
    expect(
      DENYLISTED_METHOD_SET.has("skills.create"),
      "DENYLISTED_RPC_METHODS (the @comis/daemon export) must contain skills.create — the orch:skill closed door",
    ).toBe(true);
  });

  it("denylists every orch:skill method so the denylist alone soundly closes the skill door", () => {
    // The predicate trusts the denylist (not a special-case) to close skills.*.
    // That is only sound if EVERY orch:skill method is denylisted — pin it, so a
    // future un-denylisted orch:skill method (which the predicate would then admit
    // as a same-gate orch:* target) fails the build HERE.
    const orchSkillMethods = Object.entries(
      HANDLER_CAPABILITY_MAP as Readonly<Record<string, string>>,
    )
      .filter(([, classification]) => classification === "orch:skill")
      .map(([method]) => method);
    const notDenied = orchSkillMethods.filter((m) => !DENYLISTED_METHOD_SET.has(m));
    expect(
      notDenied,
      `orch:skill methods NOT in DENYLISTED_RPC_METHODS (would leak through the same-gate predicate): ${JSON.stringify(notDenied)}`,
    ).toEqual([]);
    expect(orchSkillMethods.length).toBeGreaterThan(0);
  });

  it("resolves every comis-agent subcommand target to the same capability gate as the typed tools", () => {
    const violations = CLI_ENTRIES.map(([sub, target]) => ({
      sub,
      verdict: resolvesToSameGate(target, REAL_CAP_MAPS, DENYLISTED_METHOD_SET),
    })).filter((r) => !r.verdict.ok);
    expect(
      violations,
      `subcommands NOT resolving to the same cap-map gate: ${JSON.stringify(
        violations.map((v) => `${v.sub}: ${v.verdict.reason}`),
      )}`,
    ).toEqual([]);
    // Belt-and-suspenders: assert the table is non-empty so a future accidental
    // empty table cannot vacuously pass.
    expect(CLI_ENTRIES.length).toBeGreaterThan(0);
  });

  it("routes every tool-kind subcommand to the tool.invoke gate via a real cap-map route", () => {
    const toolEntries = CLI_ENTRIES.filter(([, t]) => t.kind === "tool");
    const offenders = toolEntries.filter(([, t]) => {
      const tool = (t as Extract<CliCallTarget, { kind: "tool" }>).tool;
      return (
        !(tool in TOOL_CAPABILITY_MAP) ||
        !(tool in TOOL_ROUTE_MAP) ||
        SUB_AGENT_TOOL_DENYLIST.has(tool)
      );
    });
    expect(
      offenders.map(([sub]) => sub),
      "every {kind:'tool'} subcommand must be a cap-mapped + routed + non-denylisted tool",
    ).toEqual([]);
    expect(toolEntries.length).toBeGreaterThan(0);
  });

  it("gates every method-kind subcommand as orch:* or a self-scoped read, never denylisted/deny-by-origin/ungated-foreign", () => {
    const methodEntries = CLI_ENTRIES.filter(([, t]) => t.kind === "method");
    const offenders = methodEntries
      .map(([sub, t]) => ({
        sub,
        verdict: resolvesToSameGate(t, REAL_CAP_MAPS, DENYLISTED_METHOD_SET),
      }))
      .filter((r) => !r.verdict.ok);
    expect(
      offenders.map((o) => `${o.sub}: ${o.verdict.reason}`),
      "every {kind:'method'} subcommand must be orch:*-or-self-scoped, not denylisted/deny-by-origin/ungated-foreign",
    ).toEqual([]);
    expect(methodEntries.length).toBeGreaterThan(0);
  });

  it("rejects a weaker-path, unmapped, deny-by-origin, OR denylisted target (the predicate discriminates)", () => {
    // NEGATIVE FIXTURES — the SAME predicate MUST return ok:false on each.
    // These are the exact cases a non-discriminating "green-anyway" test would
    // miss; skills.create is the keystone closed-door case.
    const poisoned: ReadonlyArray<readonly [string, CliCallTarget]> = [
      // unmapped admin/persistence method (not even a HANDLER_CAPABILITY_MAP key)
      ["config.apply", { kind: "method", method: "config.apply" as never }],
      // unmapped tool — a fabricated subcommand pointing at no tool
      ["definitely_not_a_tool", { kind: "tool", tool: "definitely_not_a_tool" as never }],
      // deny-by-origin method (admin/control-plane an agent origin cannot reach)
      ["message.edit", { kind: "method", method: "message.edit" as never }],
      // THE KEYSTONE: orch:skill in the cap-map BUT denylisted = the CLOSED DOOR
      // the original orch:*-only predicate would have falsely PASSED.
      ["skills.create", { kind: "method", method: "skills.create" as never }],
    ];
    const verdicts = poisoned.map(([label, target]) => ({
      label,
      verdict: resolvesToSameGate(target, REAL_CAP_MAPS, DENYLISTED_METHOD_SET),
    }));
    // Each poisoned target FAILS — proving the predicate would have failed the
    // originally-proposed `skill` subcommand (and any weaker/unmapped path).
    for (const { label, verdict } of verdicts) {
      expect(verdict.ok, `negative fixture "${label}" must be rejected, got ok:true`).toBe(false);
      expect(verdict.reason, `negative fixture "${label}" must carry a reason`).toBeDefined();
    }
    // Specifically pin the keystone's REASON to the denylist branch (not some
    // incidental other failure) — this is what proves the HARDENING is load-bearing.
    const keystone = verdicts.find((v) => v.label === "skills.create");
    expect(keystone?.verdict.reason).toContain("DENYLISTED_RPC_METHODS");
  });

  it("would PASS a denylisted target if the denylist check were removed (proves the hardening is load-bearing)", () => {
    // Counter-proof: run the predicate with an EMPTY denylist and
    // confirm skills.create then PASSES — i.e. the ONLY thing failing it in the
    // real run is the derived denylist (the keystone hardening), not luck.
    const skillsCreate: CliCallTarget = { kind: "method", method: "skills.create" as never };
    const withDenylist = resolvesToSameGate(skillsCreate, REAL_CAP_MAPS, DENYLISTED_METHOD_SET);
    const withoutDenylist = resolvesToSameGate(skillsCreate, REAL_CAP_MAPS, new Set<string>());
    expect(withDenylist.ok, "skills.create must FAIL with the real denylist").toBe(false);
    expect(
      withoutDenylist.ok,
      "skills.create must PASS without the denylist (it is orch:skill = orch:*) — so the denylist is what closes the door",
    ).toBe(true);
  });
});
