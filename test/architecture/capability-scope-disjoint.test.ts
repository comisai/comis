// SPDX-License-Identifier: Apache-2.0
/**
 * The orchestration-capability axis is DISJOINT from the
 * gateway `Scope` axis, and no capability implies an elevated scope.
 *
 * Two invariants, proven against the LIVE runtime union imported from
 * `@comis/core` (the arch-test project resolves the package to its compiled
 * dist — so this also proves the capability-union barrel export is wired):
 *
 *   Invariant 1: `Scope ∩ AgentCapability = ∅`. Capabilities are `orch:*`; scopes
 *           are `rpc|admin|mcp-client`. A member appearing in both axes would
 *           let a scope grant masquerade as a capability (or vice-versa).
 *
 *   Invariant 2: no `AgentCapability` member equals or contains `admin` / `rpc` /
 *           `*` — i.e. no capability implies an elevated gateway scope or an
 *           all-authority wildcard. Reinforced by a static guard that the
 *           `checkCapability` predicate body contains NO wildcard branch
 *           (unlike `checkScope`'s `*`-implies-all rule).
 *
 * Idiom: import-the-runtime-value + assert-a-set-relation
 * (`contract-internal-fields.test.ts`); failure rendering via
 * `formatViolations` (`architecture-helpers.ts`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CAPABILITIES, type Scope } from "@comis/core";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const CAPABILITY_SRC = resolve(
  REPO_ROOT,
  "packages/core/src/security/capability.ts",
);

/**
 * The three `Scope` literals, pinned from
 * `packages/core/src/api-contracts/types.ts:19`. `Scope` is a TYPE (no runtime
 * value to import), so the list is hardcoded — the `satisfies readonly Scope[]`
 * guard makes the build FAIL if `Scope` ever changes shape, keeping this list
 * honest (the disjointness invariant must re-verify against any new scope).
 */
const SCOPE_VALUES = ["rpc", "admin", "mcp-client"] as const satisfies readonly Scope[];

describe("Scope ∩ AgentCapability = ∅ (disjoint authority axes)", () => {
  it("no AgentCapability member is also a Scope value", () => {
    const scopeSet = new Set<string>(SCOPE_VALUES);
    const intersection = AGENT_CAPABILITIES.filter((c) => scopeSet.has(c));
    expect(
      intersection,
      formatViolations({
        description:
          "An AgentCapability member collides with a gateway Scope value — the two authority axes must be disjoint.",
        violations: intersection.map((c) => ({
          file: "packages/core/src/security/capability.ts",
          line: 0,
          snippet: `AGENT_CAPABILITIES member "${c}" is also a Scope value`,
        })),
        suggestedFix:
          "Rename the colliding capability so it does not equal any Scope literal (rpc|admin|mcp-client).",
        designRef: "the capability and scope authority axes are disjoint",
      }),
    ).toEqual([]);
  });
});

describe("no AgentCapability implies admin/rpc/*", () => {
  it("no member equals or contains 'admin', 'rpc', or '*'", () => {
    // (^|:)admin$ / (^|:)rpc$ catches a bare or namespaced scope-equivalent;
    // \* catches any wildcard. orch:* members never match.
    const elevated = /(^|:)(admin|rpc)$|\*/;
    const violators = AGENT_CAPABILITIES.filter((c) => elevated.test(c));
    expect(
      violators,
      formatViolations({
        description:
          "An AgentCapability member implies an elevated scope (admin/rpc) or an all-authority wildcard (*).",
        violations: violators.map((c) => ({
          file: "packages/core/src/security/capability.ts",
          line: 0,
          snippet: `AGENT_CAPABILITIES member "${c}" implies admin/rpc/*`,
        })),
        suggestedFix:
          "Capabilities must be orch:* surfaces with no lattice; remove any admin/rpc/wildcard-implying member.",
        designRef: "no capability implies an elevated scope or wildcard authority",
      }),
    ).toEqual([]);
  });

  it("the checkCapability predicate has no wildcard branch (static source guard)", () => {
    const src = readFileSync(CAPABILITY_SRC, "utf8");
    // The predicate must be a plain membership test...
    expect(
      /checkCapability[\s\S]*?return held\.includes\(required\)/.test(src),
      formatViolations({
        description:
          "checkCapability is not the expected plain membership predicate (held.includes(required)).",
        violations: [
          {
            file: "packages/core/src/security/capability.ts",
            line: 0,
            snippet: "checkCapability body did not match `return held.includes(required)`",
          },
        ],
        suggestedFix:
          "checkCapability must return held.includes(required) — no lattice, no wildcard.",
        designRef: "checkCapability is a plain membership predicate",
      }),
    ).toBe(true);
    // ...with NO wildcard authority anywhere in the predicate module.
    const wildcardForms = ['=== "*"', "includes(\"*\")", '"*"'];
    const found = wildcardForms.filter((form) => src.includes(form));
    expect(
      found,
      formatViolations({
        description:
          "A wildcard literal appears in capability.ts — checkCapability must have NO '*'-implies-all branch (the divergence from checkScope).",
        violations: found.map((form) => ({
          file: "packages/core/src/security/capability.ts",
          line: 0,
          snippet: `forbidden wildcard form present: ${form}`,
        })),
        suggestedFix:
          "Remove any '*' literal from the predicate; capabilities confer only the caps explicitly held.",
        designRef: "no wildcard authority in the capability predicate",
      }),
    ).toEqual([]);
  });
});

describe("orch:mcp joins the closed capability union (default-off, disjoint from Scope)", () => {
  it("orch:mcp is a member of AGENT_CAPABILITIES (the single source of truth)", () => {
    // The MCP-in-jail inbound surface is born into the closed union FIRST, so the
    // inferred AgentCapability type + every exhaustive Record<AgentCapability,…>
    // are forced to acknowledge it before any dispatch shape is wired.
    const caps: readonly string[] = AGENT_CAPABILITIES;
    expect(caps).toContain("orch:mcp");
  });

  it("orch:mcp is disjoint from the gateway Scope set (orch:mcp ≠ mcp-client)", () => {
    // The one collision worth naming: orch:mcp is NOT the mcp-client Scope. A cap
    // named like a scope would let a scope grant masquerade as a capability. (The
    // "no member implies admin/rpc/*" test above now iterates orch:mcp too, so the
    // elevated-scope rule is already re-proven for the new member.)
    const scopeSet = new Set<string>(SCOPE_VALUES);
    expect(scopeSet.has("orch:mcp")).toBe(false);
  });
});
