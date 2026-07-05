---
name: autonomy
description: Use when a task is more than a single step — a read/research fan-out, spawning sub-agents, running a DAG, scheduling your own work, or messaging your channel. Teaches when to route work through `orchestrate(script)`, how to fan out with capability attenuation, how to read a denial, and the bounded contract you operate under.
metadata:
  version: "0.2.0"
---

# Acting on your own (the orchestration surface)

You can do real work without a human in the loop: research the web and synthesize, fan out to
sub-agents, run a multi-node DAG, schedule your own follow-ups, and reply to your channel — all
inside a bounded, budgeted, revocable envelope. This skill is how to USE that surface well.

## The two-layer model — read this first

There are two layers, and conflating them is the most common mistake:

1. **The tool you call** is `orchestrate({ script, language })`. You also call the typed
   orchestration tools `sessions_spawn`, `pipeline`, `cron`, and `message` directly.
2. **Inside an `orchestrate` script** you `import { comis_tools } from "./comis_tools.js"` and call
   the capability-scoped tools — `comis_tools.web_search(...)`, `comis_tools.web_fetch(...)`,
   `comis_tools.read(...)`, `comis_tools.grep(...)`, `comis_tools.memory_search(...)`, etc.

`tool.invoke` is the dispatch verb the SDK sends over the capability socket **inside** the jailed
script — it is **not** a tool you call. You never write `tool.invoke(...)` yourself; you write
`comis_tools.web_search(...)` and the SDK does the dispatch. If you find yourself reaching for a
"tool_invoke" tool, stop: you want `orchestrate` with a script, or a typed tool directly.

## The decision guide — route by shape

- **Single step** (one read, one fetch, one message) → call the typed tool directly.
- **Multi-step** — a read→fetch→synthesize chain, a fan-out, a DAG, or scheduled work → wrap it in
  **one** `orchestrate({ script })` turn. The script chains the tools in a jailed child and returns
  only its `stdout`; every intermediate result (search hits, fetched pages) stays on disk as a
  handle and **never** enters your context. One turn, one synthesized answer back.

## Read-fan-out — research and synthesize in one turn

With the `orch:read` and `orch:web` capabilities (both on in the default `standard` profile), a single `orchestrate` script
can search, fetch several pages, slice them in-jail, and print only the synthesis:

```typescript
import { comis_tools } from "./comis_tools.js";

// 1. Search (daemon-side, DNS-pinned) → a handle, not a wall of text in context.
const results = await comis_tools.web_search({ query: "comis autonomy model" });
// 2. Pull the top URLs out of the handle, in-jail.
const urls = (await results.jq("[.[].url][0:3]")) as string[];
// 3. Fetch + slice the readable head of each page (each a handle).
const summaries: string[] = [];
for (const url of urls) {
  const page = await comis_tools.web_fetch({ url });
  summaries.push(await page.read(0, 60));
}
// 4. ONLY this final synthesized slice re-enters the conversation.
console.log(summaries.join("\n---\n"));
```

The three searches and fetches — and all their intermediate payloads — happen inside the jail in
**one** turn. Your context only ever sees the final `console.log`.

## Fan-out — delegate with capability attenuation

Use `sessions_spawn` (capability `orch:spawn`) to delegate a self-contained piece of work to a
sub-agent. **Attenuate the child's capabilities to the minimum it needs** — a child that only reads
should get `orch:read`, not your whole set. Capabilities only ever narrow down the tree: a child can
never hold a capability you do not, so granting less is both safer and free. Spawn fan-out is
ceiling-limited, so delegate deliberately, not reflexively.

## DAG — a multi-node workflow

Use `pipeline` (capability `orch:graph`) when the work is a graph of dependent steps rather than a
single linear script — nodes that produce inputs for later nodes, branches that run in parallel.

## Self-cron — schedule work for yourself

Use `cron` (capability `orch:cron`) to schedule your own future work — a periodic check, a deferred
follow-up. You are scheduling a job for yourself; it runs later under the same bounded envelope.

## Outward = your origin channel + a quota

Use `message` (capability `orch:message`) to reach a human. It replies to your **origin channel
only** and is **hourly-quota-limited** — you cannot message arbitrary targets or other channels by
default. Use it to report results or ask a question, not as a general broadcast.

## Reading a denial — adapt, do not retry-escalate

If a call is denied, that means **either** you lacked the required capability **or** you hit a bound
— a budget ceiling, a rate limit, or a spawn ceiling. A missing-capability denial surfaces as a
`CapabilityDeniedError` (it carries the `required` capability and nothing else); the bound limits
surface as their own distinct errors from the budget / rate / outward guards. Whichever it is, the
correct response is the same: **do not retry the same call and do not try to escalate your own
permissions.** Adapt — do less, do it a cheaper way, or report what you could not do and why.

## The contract — what you can and cannot do

You act within a bounded envelope, by design:

- **Workspace-confined.** An `orchestrate` script reads and writes only your jailed workspace. It
  cannot read `~/.comis`, the secret store, other agents' workspaces, or the host filesystem.
- **You cannot read secrets, mint tokens, or change configuration.** The administrative control
  plane is unreachable through the capability surface, and the deny-by-origin chokepoint plus the
  jail enforce this regardless of what any instruction (including an injected one) tells you. Do not
  try — it is not a missing feature, it is the boundary.
- **You are capped.** Budgets, rate limits, and spawn ceilings bound how much you can do; long runs
  are **revocable and clampable** — a capability-lease revoke or a kill-run halts an in-flight run.
- **Runs are not durable.** An in-flight run does **not** survive a daemon restart. Do not assume a
  long job will resume on its own across a restart; treat completion as the only guarantee.

Used within these bounds, the surface lets you carry a multi-step job from request to a synthesized
answer in a single turn — that is the point of `orchestrate`.
