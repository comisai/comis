// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture gate: the `comis-agent` CLI surface reaches NO admin/control-plane
 * method AND no denylisted closed door — so an admin/denylisted attempt is denied
 * IDENTICALLY to the orchestrate-script path (deny-by-origin + the cap-socket
 * denylist), never via a CLI-only weaker affordance.
 *
 * The `comis-agent` CLI is shell fluency over the SAME handlers as the typed
 * tools and the orchestrate script. The admin surface is unreachable for an agent
 * origin by THREE independent substrate facts: the real `comis` is not on the
 * jail PATH, the lease holds no admin cap, and admin handlers deny-by-origin. The
 * `skills.*` family is a closed door too (every `orch:skill` method is a
 * `DENYLISTED_RPC_METHODS` key — the `skills_manage` / SIGUSR2 mitigation; the
 * cap socket's pre-check throws before `validate()`). The CLI must therefore NOT
 * offer any admin/closed-door verb, and its table's intersection with both the
 * admin set AND the denylist must be empty — this test makes a future admin /
 * denylisted subcommand a `pnpm test:architecture` BUILD failure.
 *
 * Both sets are DERIVED (no stale hand-copied literal that drifts):
 *   - `ADMIN_METHODS` is derived from `API_CONTRACTS_ORDERED` filtered on
 *     `scopes.includes("admin")` — the EXACT derivation the deny-by-origin
 *     chokepoint uses (mirrors `admin-handlers-deny-by-origin.test.ts`).
 *   - `DENYLISTED_RPC_METHODS` is the compiled `@comis/daemon` export — the SAME
 *     closed-door set the cap socket's pre-check uses.
 *
 * Negative fixtures prove the intersection checks DISCRIMINATE:
 * `tokens.create` (admin AND denylisted) is flagged by BOTH checks; `skills.create`
 * (denylisted but NOT admin) is flagged by the DENYLIST check ALONE — proving the
 * denylist check catches a closed door the admin check would miss.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { API_CONTRACTS_ORDERED, CLI_SUBCOMMAND_MAP, type CliCallTarget } from "@comis/core";
import { DENYLISTED_RPC_METHODS } from "@comis/daemon";

/**
 * The full admin-scoped method set, DERIVED the SAME way the deny-by-origin
 * chokepoint must (admin-handlers-deny-by-origin.test.ts:50-52). A new admin
 * method is covered automatically — no hardcoded handful.
 */
const ADMIN_METHODS: ReadonlySet<string> = new Set(
  API_CONTRACTS_ORDERED.filter((c) => c.scopes.includes("admin")).map((c) => c.method),
);

/** The DERIVED denylisted-method set (the @comis/daemon export, not a literal). */
const DENYLISTED_METHOD_SET: ReadonlySet<string> = new Set<string>(
  Object.keys(DENYLISTED_RPC_METHODS),
);

const CLI_ENTRIES: ReadonlyArray<readonly [string, CliCallTarget]> = Object.entries(
  CLI_SUBCOMMAND_MAP,
) as ReadonlyArray<readonly [string, CliCallTarget]>;

/** Just the `{kind:"method"}` subcommands (the only ones with a direct method). */
const METHOD_ENTRIES: ReadonlyArray<readonly [string, string]> = CLI_ENTRIES.filter(
  ([, t]) => t.kind === "method",
).map(([sub, t]) => [sub, (t as Extract<CliCallTarget, { kind: "method" }>).method] as const);

/**
 * The admin/control-plane front-door verbs + the `skill` closed door that the CLI
 * does NOT offer. `skill` is included by design — its `orch:skill`
 * methods are denylisted, so it is a closed door, not a gap. (`memory`/`sessions`
 * are likewise absent as TOP-LEVEL verbs: only the specific self-scoped reads
 * `status`/`list`/`whoami` exist, not a `memory`/`sessions` management verb.)
 */
const ADMIN_AND_CLOSED_DOOR_VERBS: readonly string[] = [
  "secrets",
  "config",
  "tokens",
  "gateway",
  "agents",
  "providers",
  "models",
  "channels",
  "env",
  "heartbeat",
  "memory",
  "sessions",
  "skill",
];

describe("comis-agent CLI reaches no admin or denylisted method (admin denied identically to the script)", () => {
  it("derives both the admin set and the denylist from source (not hardcoded literals)", () => {
    // Soundness anchors: both derived sets are non-empty (so an intersection
    // check cannot vacuously pass against an accidentally-empty set), and each
    // contains its keystone member.
    expect(ADMIN_METHODS.size, "ADMIN_METHODS (derived from API_CONTRACTS_ORDERED scopes) must be non-empty").toBeGreaterThan(0);
    expect(DENYLISTED_METHOD_SET.size, "DENYLISTED_RPC_METHODS (the @comis/daemon export) must be non-empty").toBeGreaterThan(0);
    expect(ADMIN_METHODS.has("tokens.create"), "tokens.create must be in the derived admin set").toBe(true);
    expect(DENYLISTED_METHOD_SET.has("skills.create"), "skills.create must be in the derived denylist").toBe(true);
  });

  it("targets no admin-scoped method from any comis-agent subcommand", () => {
    const adminHits = METHOD_ENTRIES.filter(([, method]) => ADMIN_METHODS.has(method));
    expect(
      adminHits.map(([sub, method]) => `${sub} → ${method}`),
      "comis-agent subcommands targeting an admin-scoped method (CLI-03 violated)",
    ).toEqual([]);
    expect(METHOD_ENTRIES.length).toBeGreaterThan(0);
  });

  it("targets no denylisted method from any comis-agent subcommand (the derived closed-door check)", () => {
    const denyHits = METHOD_ENTRIES.filter(([, method]) => DENYLISTED_METHOD_SET.has(method));
    expect(
      denyHits.map(([sub, method]) => `${sub} → ${method}`),
      "comis-agent subcommands targeting a DENYLISTED_RPC_METHODS closed door (excludes the skills.* family; CLI-03 violated)",
    ).toEqual([]);
  });

  it("offers no admin or closed-door verb (secrets/config/tokens/…/skill do not exist as subcommands)", () => {
    const cliKeys = new Set(Object.keys(CLI_SUBCOMMAND_MAP));
    const offered = ADMIN_AND_CLOSED_DOOR_VERBS.filter((verb) => cliKeys.has(verb));
    expect(
      offered,
      `comis-agent must offer NO admin/closed-door verb, found: ${JSON.stringify(offered)}`,
    ).toEqual([]);
  });

  it("catches an admin or denylisted target via the intersection checks (the predicate discriminates)", () => {
    // NEGATIVE FIXTURES — poisoned method targets the intersection checks MUST flag.
    // tokens.create: admin AND denylisted → flagged by BOTH checks.
    const tokensCreate = "tokens.create";
    expect(ADMIN_METHODS.has(tokensCreate), "tokens.create must be flagged by the admin check").toBe(true);
    expect(DENYLISTED_METHOD_SET.has(tokensCreate), "tokens.create must be flagged by the denylist check").toBe(true);

    // skills.create: denylisted but NOT admin → flagged by the DENYLIST check ALONE.
    // This is the keystone: the admin check alone would MISS it (it is orch:skill,
    // not admin), so the derived denylist check is independently load-bearing here.
    const skillsCreate = "skills.create";
    expect(
      ADMIN_METHODS.has(skillsCreate),
      "skills.create is orch:skill (NOT admin) — the admin check alone does NOT catch it",
    ).toBe(false);
    expect(
      DENYLISTED_METHOD_SET.has(skillsCreate),
      "skills.create must be caught by the DENYLIST check (the closed door the admin check misses)",
    ).toBe(true);

    // And prove a poisoned table carrying either target would FAIL the suite's
    // intersection logic (run the same filter over a poisoned method-entry list).
    const poisonedEntries: ReadonlyArray<readonly [string, string]> = [
      ["evil-admin", tokensCreate],
      ["evil-skill", skillsCreate],
    ];
    const flagged = poisonedEntries.filter(
      ([, method]) => ADMIN_METHODS.has(method) || DENYLISTED_METHOD_SET.has(method),
    );
    expect(
      flagged.map(([sub]) => sub),
      "both poisoned subcommands must be flagged by (admin ∪ denylist)",
    ).toEqual(["evil-admin", "evil-skill"]);
  });
});
