// SPDX-License-Identifier: Apache-2.0
/**
 * `CLI_SUBCOMMAND_MAP` — the `comis-agent` subcommand→call-target
 * source-of-truth. The in-jail `comis-agent` CLI is the third call surface
 * (typed tool / orchestrate script / this CLI all converge on the SAME handlers
 * + the SAME `requireCapability` gate). Its value is shell fluency,
 * NOT new authority — so this table NEVER restates a capability: each
 * entry is a `{kind:"tool", tool}` (rides `tool.invoke`) or a `{kind:"method",
 * method}` (a direct orchestration / self-scoped-read method), and the CAP is
 * DERIVED from the existing {@link TOOL_CAPABILITY_MAP} / {@link
 * HANDLER_CAPABILITY_MAP} (there is deliberately no `cap` field here). The wire
 * the CLI sends each call over is the lease cap socket, never the
 * loopback gateway WebSocket.
 *
 * The `skill` family is INTENTIONALLY OMITTED — it is NOT a gap. Every
 * `orch:skill` method (`skills.{create,update,delete,import,upload}`) is in the
 * cap socket's `DENYLISTED_RPC_METHODS` (`skills_manage` — the SIGUSR2
 * skill-mutation mitigation), and `skills.list` is denylisted too; the
 * endpoint's denylist pre-check throws BEFORE `validate()`, so NO `orch:skill`
 * method is reachable over the cap socket. The orchestrate SCRIPT surface hits
 * the SAME closed door. Offering a `skill` subcommand would advertise a path
 * that is always denied — so it is excluded by design (the substrate denylist is
 * NOT relaxed; un-denylisting would contradict the mitigation and grant a
 * capability this table must never grant). The admin verbs
 * (`secrets`/`config`/`tokens`/`gateway`/…) are likewise absent: the
 * real `comis` is not on the jail PATH, the lease holds no admin cap, and admin
 * handlers deny-by-origin.
 *
 * The module-load soundness assertion below fails LOUD at import if any entry
 * points at a non-cap-map target, or at a method that is neither `orch:*` nor a
 * {@link SELF_SCOPED_AGENT_READS} member, or at a `deny-by-origin` method — so a
 * future re-added `skill`-like entry pointing at a non-orch/denied target aborts
 * module load rather than silently shipping a weaker/false-affordance path. The
 * denylist cross-check itself (the proof that no target is in
 * `DENYLISTED_RPC_METHODS`) is the companion arch-test, which imports the daemon's
 * exported denylist — kept OUT of here so `@comis/core` never imports
 * `@comis/daemon` (a package cycle).
 *
 * @allow-throw: module-load invariant (mirrors `tool-capability-map.ts` +
 * `handler-capability-map.ts`). The assertion block throws at import on a
 * mis-targeted entry; the arch-tests pin the same invariants at build time.
 *
 * @module
 */
import {
  HANDLER_CAPABILITY_MAP,
  SELF_SCOPED_AGENT_READS,
  type GatedMethodName,
} from "./handler-capability-map.js";
import { TOOL_CAPABILITY_MAP, type ToolName } from "./tool-capability-map.js";

/**
 * A single `comis-agent` subcommand call target. Exactly one of two shapes:
 *   - `{kind:"tool", tool}` — the subcommand rides `tool.invoke` (the dispatch
 *     sends `callCapSocket("tool.invoke", { tool, args })`). `tool` MUST be a
 *     {@link ToolName} (a `TOOL_CAPABILITY_MAP` key).
 *   - `{kind:"method", method}` — the subcommand sends the DIRECT method (the
 *     dispatch sends `callCapSocket(method, params)`, NOT a `tool.invoke`
 *     envelope). `method` MUST be a {@link GatedMethodName} (a
 *     `HANDLER_CAPABILITY_MAP` key) classified `orch:*` or a member of
 *     {@link SELF_SCOPED_AGENT_READS}.
 */
export type CliCallTarget =
  | { readonly kind: "tool"; readonly tool: ToolName }
  | { readonly kind: "method"; readonly method: GatedMethodName };

/**
 * The FINAL `comis-agent` subcommand→target table (minus
 * the denylisted `skill`). `as const satisfies Record<string, CliCallTarget>`
 * keeps the literal tool/method strings exact at the type level (a typo'd target
 * fails the build) while typing the whole table.
 *
 * `list` is its OWN top-level key (→ `session.list`) and `status` is its own (→
 * `session.status`) so BOTH are flat enumerable entries the same-gate arch-test
 * predicate iterates; the two-token `status list` is a PARSER-level alias to the
 * `list` entry (handled in `comis-agent-cli.ts`), NOT a nested value shape that
 * would hide a target from the flat enumeration.
 */
export const CLI_SUBCOMMAND_MAP = {
  // ── orchestration methods (direct method — NOT tool.invoke) ──
  spawn: { kind: "method", method: "session.spawn" }, // orch:spawn
  run: { kind: "method", method: "graph.execute" }, // orch:graph
  schedule: { kind: "method", method: "cron.add" }, // orch:cron
  send: { kind: "method", method: "message.send" }, // orch:message
  // ── read/web tools (ride tool.invoke) ──
  search: { kind: "tool", tool: "web_search" }, // orch:web
  fetch: { kind: "tool", tool: "web_fetch" }, // orch:web
  read: { kind: "tool", tool: "read" }, // orch:read
  grep: { kind: "tool", tool: "grep" }, // orch:read
  find: { kind: "tool", tool: "find" }, // orch:read
  ls: { kind: "tool", tool: "ls" }, // orch:read
  // ── self-scoped reads (the cap-socket audience exception; any valid lease reaches) ──
  whoami: { kind: "method", method: "capabilities.introspect" },
  status: { kind: "method", method: "session.status" },
  list: { kind: "method", method: "session.list" }, // parser aliases `status list` → here
} as const satisfies Record<string, CliCallTarget>;

/** The subcommand-name keys of {@link CLI_SUBCOMMAND_MAP}. */
export type CliSubcommand = keyof typeof CLI_SUBCOMMAND_MAP;

// ---------------------------------------------------------------------------
// Module-load soundness assertion (fail-loud).
// Mirrors tool-capability-map.ts + handler-capability-map.ts: assert-at-load so
// a mis-targeted entry (a non-cap-map tool/method, or a method that is neither
// orch:* nor a self-scoped read, or a deny-by-origin method) fails LOUD at
// import — this is what would catch a re-added `skill`-like entry IF it pointed
// at a non-orch/denied target. The denylist cross-check (no target ∈
// DENYLISTED_RPC_METHODS) is the companion arch-test (it imports the daemon export;
// @comis/core must NOT import @comis/daemon — a package cycle).
// ---------------------------------------------------------------------------

const SELF_SCOPED_READ_SET: ReadonlySet<string> = new Set<string>(SELF_SCOPED_AGENT_READS);

/**
 * Assert the CLI table ↔ cap-map soundness invariants. Pure: takes the
 * three tables explicitly so the invariant is independently unit-testable over a
 * poisoned copy (the throw branches are the security fail-loud paths). Throws a
 * descriptive `Error` on the first violation.
 *
 * @allow-throw: module-load invariant (mirrors tool-capability-map.ts). Called
 * once at import below with the real tables; the throw aborts module load.
 */
export function assertCliSubcommandMapSoundness(
  cliMap: Readonly<Record<string, CliCallTarget>>,
  toolMap: Readonly<Record<string, unknown>>,
  handlerMap: Readonly<Record<string, string>>,
): void {
  for (const [sub, target] of Object.entries(cliMap)) {
    if (target.kind === "tool") {
      if (!(target.tool in toolMap)) {
        throw new Error(
          `CLI_SUBCOMMAND_MAP invariant violated: "${sub}" → tool "${target.tool}" is not a ` +
            `TOOL_CAPABILITY_MAP key — every subcommand must resolve 1:1 to an existing cap-mapped tool.`,
        );
      }
      continue;
    }
    // target.kind === "method"
    const classification = handlerMap[target.method];
    if (classification === undefined) {
      throw new Error(
        `CLI_SUBCOMMAND_MAP invariant violated: "${sub}" → method "${target.method}" is not a ` +
          `HANDLER_CAPABILITY_MAP key — every subcommand must resolve 1:1 to an existing cap-mapped method.`,
      );
    }
    if (classification === "deny-by-origin") {
      throw new Error(
        `CLI_SUBCOMMAND_MAP invariant violated: "${sub}" → method "${target.method}" is ` +
          `deny-by-origin (an admin/control-plane method an agent origin cannot reach) — it must never be a CLI target.`,
      );
    }
    const isOrchCap = classification.startsWith("orch:");
    const isSelfScoped = SELF_SCOPED_READ_SET.has(target.method);
    if (!isOrchCap || classification === "orch:skill") {
      // A method target must be an orch:* cap OTHER than orch:skill (denylisted),
      // OR a self-scoped read. orch:skill is the closed door — never a CLI target.
      if (!isSelfScoped) {
        throw new Error(
          `CLI_SUBCOMMAND_MAP invariant violated: "${sub}" → method "${target.method}" is ` +
            `classified "${classification}" — a method target must be orch:* (never orch:skill, which is ` +
            `denylisted at the cap socket / skills_manage) or a SELF_SCOPED_AGENT_READS member.`,
        );
      }
    }
  }
}

// Run the invariant at module load with the real tables (fail-loud at import).
assertCliSubcommandMapSoundness(CLI_SUBCOMMAND_MAP, TOOL_CAPABILITY_MAP, HANDLER_CAPABILITY_MAP);
