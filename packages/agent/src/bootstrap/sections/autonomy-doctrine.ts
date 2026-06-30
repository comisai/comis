// SPDX-License-Identifier: Apache-2.0
/**
 * Autonomy doctrine: the one-paragraph, always-on contract + routing rule.
 *
 * Every top-level run (and every sub-agent / lockdown run) carries this
 * paragraph in its bootstrap system prompt, even when the model never opens the
 * full `autonomy` skill. It is the always-on floor; the bundled `autonomy` skill
 * is the on-demand detail.
 *
 * The framing reflects current behavior: runs are revocable/clamped, NOT durable
 * (no resume across a daemon restart). It names no introspection surface (no
 * `whoami`, `capabilities.introspect`, or `comis-agent` CLI).
 */

/**
 * Build the always-on autonomy doctrine section.
 *
 * Returns a heading-first `string[]`: the `## Autonomy` heading followed by
 * one paragraph of prose (authored as concatenated fragments for readability)
 * stating the routing rule, the delegate-then-synthesize rule (heavy/long/
 * high-volume work goes to a fresh-window child, the lead synthesizes its
 * returned summary + `ResultRef`), the autonomy envelope, the contract truth,
 * and how to read a denial.
 *
 * The capability claim is PROFILE-CONDITIONAL by phrasing, not by plumbing: the
 * opener says "When your agent profile grants autonomy capabilities (the
 * `standard` default does; `assistant` does not), you can …" so the always-on
 * paragraph stays accurate for EVERY resolved profile — including `assistant`
 * (`enabled:false, capabilities:[]`, `schema-agent-autonomy.ts`) — without
 * threading the resolved posture through `AssemblerParams`. This keeps the
 * single universal paragraph (it rides every bootstrap prompt) while avoiding
 * the over-claim a categorical "You can spawn sub-agents …" would make for an
 * `assistant`-profile agent that holds none of those caps.
 *
 * Registered in `SECTIONS` with `MODES_ALL_PLUS_COMPACT`
 * (the same membership `identity`/`safety` use), placed after `language` so it
 * lands in the semi-stable body and does not disturb the cache-block
 * boundaries (`computeBlockBoundaries`).
 */
export function buildAutonomyDoctrineSection(): string[] {
  return [
    "## Autonomy",
    "",
    "When your agent profile grants autonomy capabilities (the `standard` default does; `assistant` " +
      "does not), you can act on your own within a bounded envelope: spawn sub-agents, run DAGs, " +
      "schedule your own cron jobs, research the web, and message your origin channel — all " +
      "budget-capped, rate-limited, and revocable (long runs may be clamped or stopped, and do not " +
      "resume across a daemon restart). Route by shape: a single step is a direct tool call; a " +
      "multi-step read/fetch/synthesize/fan-out chain is one `orchestrate(script)` turn. Route by " +
      "weight too: delegate heavy, long-running, or high-volume work to a fresh-window child via " +
      "`sessions_spawn` — each child runs an isolated context with its own budget and returns a " +
      "bounded summary plus a `ResultRef` handle to its full output, which you then synthesize " +
      "(drilling into the `ResultRef` on demand) rather than doing the heavy work inline and " +
      "burning your own window. A `coordinator`-role lead MUST delegate such work (it holds only " +
      "the orchestration surface); any other autonomy-bearing agent SHOULD, to keep its window " +
      "lean. You are " +
      "confined to your workspace; you cannot read secrets, mint tokens, change config, or reach the " +
      "control plane — don't try. A `CapabilityDeniedError` — or any quota, budget, or rate-limit " +
      "denial — means you lack that capability or hit a ceiling: adapt or report — do not retry the " +
      "same blocked call in a loop. (Under an unattended profile the platform escalates a blocked " +
      "irreversible action to your operator for you; you still adapt and continue, you do not wait on " +
      "it.)",
  ];
}
