# Workload contract — how to build one simulator

Every workload lives in `sim/<workload>/` and is **four files**: `tools.json`, `world.seed.json`,
`handlers.mjs`, `SKILL.md`. The shared harness (`sim/shared/*`, `sim/bin/*`) does everything else — you
write only data + handler bodies. Zero dependencies; Node ≥ 22 ESM.

## The golden rule (do not violate)
**The SKILL.md teaches MECHANICS, never STRATEGY.** It may name the tools, the call order, and the goal — it
must NOT reveal the hidden answer (which host is compromised, the true diagnosis, the winning playbook). The
*strategy* is what the reflection engine must LEARN from successful episodes. If the skill encodes strategy,
the workload stops testing learning. The world's hidden truth lives ONLY in `world.seed.json` + the grading
logic in `handlers.mjs` — never in the skill.

## `tools.json`
```json
{
  "server": "th-sim",                     // MCP server name → tools surface as mcp:th-sim/<tool>
  "title": "Threat-Hunting Console",
  "tools": [
    {
      "name": "query_telemetry",
      "kind": "observe",                  // "observe" (read-only) | "act" (consequential)
      "terminal": false,                  // true ONLY on the graded terminal act (e.g. close_case)
      "description": "One-line, agent-facing. Says WHAT it returns, not the answer.",
      "inputSchema": { "type": "object", "properties": { "filter": { "type": "string" } }, "required": [] }
    }
  ]
}
```
- 6–8 **observe** tools (let the agent discover the world) + 4–6 **act** tools, exactly **one** `terminal:true`.
- `inputSchema` is standard JSON Schema (drives MCP discovery + arg validation client-side).

## `world.seed.json`
Free-form per workload. MUST contain: the entities the observe tools expose, a `truth` block (the hidden
ground truth the grader checks against — what the agent must discover), benign/decoy noise, and a `variants`
map keyed by `SIM_VARIANT` (`A`/`B`/`C`) that **rotates the surface facts while holding the behavior
constant** (this is how TRANSFER is tested — a fact-memorizer fails the next variant; only a learned
*behavioral* strategy carries).

## `handlers.mjs`
```js
// Optional: derive the live world from the seed + the active variant.
export function setup({ seedWorld, rng, variant, ctx }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || {};
  return { ...seedWorld, iocs: v.iocs, telemetry: buildTelemetry(seedWorld, v) };
}

// One function per tool. Signature: (args, ctx) => result (sync, plain JSON).
export const handlers = {
  query_telemetry(args, ctx) { /* read ctx.world, return data */ },

  open_investigation(args, ctx) {
    const id = `C-${++ctx.caseCounter}`;
    ctx.cases.set(id, { findings: [], containments: [], summary: args.summary || "" });
    ctx.lastCase = id;
    return { case: id };
  },

  // The ONE terminal act returns ctx.grade(...) — Loop A's resolver keys off this.
  close_case(args, ctx) {
    const c = ctx.cases.get(args.case || ctx.lastCase);
    const correct = /* compare c.findings/containments vs ctx.world.truth */;
    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: "what was right/wrong — safe to surface, no hidden answer leaked",
    });
  },
};

// REQUIRED: prove the success signal is reachable AND a naive path fails, in one process.
export function selftest({ call, ctx }) {
  // golden path → success
  const c = call("open_investigation", { summary: "..." }).case;
  call("raise_finding", { case: c, /* the correct answer */ });
  const good = call("close_case", { case: c, verdict: "..." });
  // naive path → failure (e.g. acts only on the rotating IOCs / ignores the baseline)
  const c2 = call("open_investigation", { summary: "naive" }).case;
  const bad = call("close_case", { case: c2, verdict: "guess" });
  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome,
           detail: pass ? "ok" : { good, bad } };
}
```

### ctx (passed to every handler)
| field | use |
|---|---|
| `ctx.world` | the live world (from `setup`, or the raw seed) — observe tools read it |
| `ctx.rng()` | seeded float [0,1) — use for any "randomness" so episodes are reproducible (no `Math.random`) |
| `ctx.variant` | `"A"`/`"B"`/`"C"` — the active surface-rotation |
| `ctx.cases` | `Map` of caseId → per-episode mutable state |
| `ctx.caseCounter`, `ctx.lastCase` | deterministic case ids (`C-1`…); default act tools to `ctx.lastCase` if `case` omitted |
| `ctx.grade(outcome, {score, rationale, ...})` | the terminal-act return shape (`outcome` ∈ `success`/`failure`/`partial`) |
| `ctx.log(...)` | stderr only (never stdout — stdout is the MCP wire) |

### Rules
- **Pure + sync handlers**, plain-JSON returns. No network, no disk writes, no `Math.random`/`Date.now`
  (use `ctx.rng`; pass any timestamps as world data) — keeps episodes reproducible.
- **Never print to stdout** from a handler (stdout is the MCP protocol channel) — use `ctx.log`.
- Act tools default `case` to `ctx.lastCase` so the agent needn't thread the id perfectly. CAVEAT: one MCP
  server process serves ALL Comis sessions, and `ctx.lastCase`/`ctx.cases` are process-global — defaulting to
  `lastCase` is safe only for **sequential** drives (the normal self-driving flow). If concurrent sessions may
  hit the same server, have the agent thread the explicit id returned by `open_*`/`accept_*` on every call
  rather than relying on `lastCase`.
- The grader compares the agent's recorded findings/acts against `ctx.world.truth` — make success require the
  *behavioral* insight, and make a shortcut (act only on the rotating IOC / ignore the baseline / trust the
  loudest source) **fail**. That gap is what the engine learns to close.

## Verify
`node sim/bin/cli.mjs <workload> --list` (tools load) and
`node sim/bin/cli.mjs <workload> --selftest` (golden→success, naive→failure) must both pass.
