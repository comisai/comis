# Telegram manual test — "The package courier that learns its shift"

A by-hand reproduction of the **Hindsight package-delivery demo** on Comis, driven entirely from a
**Telegram** chat. You play the dispatcher; the agent is a courier in an office building it has never seen.
Over a shift it goes from *wandering* to *going straight there* — and you watch its **mental model fill in**,
the same way the Hindsight video shows the memory bank populating.

> **What this proves.** Comis's outcome-gated, trust-tiered learning loop (ACC → REFLECT → REUSE/TRANSFER)
> is the real-world equivalent of Hindsight's "mental models." The building layout, who sits where, and the
> winning route are the **hidden truth** — none of it is in the skill the agent ships with (`SKILL.md` teaches
> only how to *use the tools*). The agent must **learn the strategy from its own successful deliveries**, then
> reuse it on a delivery whose facts have all changed.

The dramatic "cold = clumsy, learned = direct" arc is clearest with a **small/local model** (a strong model
reads the directory and nails par on try one). But the **authoritative proof is the mental-model store**,
which fills in regardless of model strength — that is the panel to watch, not the chat reply.

---

## The two surfaces you'll use

| Surface | Where | Used for |
|---|---|---|
| **Telegram** (your phone) | the agent's chat channel | sending delivery jobs, reading the courier's replies |
| **SSH terminal** (the VPS box, user `comis`) | `node packages/cli/dist/cli.js …` + the rig scripts | **ground truth** — `mental_models`, `outcome_events`, `comis explain`. *Never trust the chat reply alone.* |

The CLI is **not on PATH** — prefix everything with `node packages/cli/dist/cli.js`. Rig scripts live in
`/root/` on the box (`db.mjs`, `explain.mjs`, `reflect-run.mjs`) and self-resolve the `comis`-user data dir.

---

## One-time setup (SSH, do once before you open Telegram)

The point is a **true from-scratch courier** — an empty `memory.db` so it starts knowing *nothing*, exactly
like the Hindsight agent's empty memory bank.

```bash
# 0. Ship the sim to the box (from your laptop checkout)
cd test/live/self-driving/sim
bash deploy-sim.sh                                  # → /home/comis/sim on the VPS

# 1. Wipe learning state + cron store, restart on the fresh dist
#    (re-registers exactly the 3 v2.31 learning crons; empties memory.db)
WIPE_CRONS=1 bash /root/clean-restart.sh
```

**Connect the delivery world as a live MCP server** (no restart needed) — start on **variant A**:

```bash
node packages/cli/dist/cli.js mcp connect depot-sim \
  --transport stdio --command node \
  --args /home/comis/sim/bin/mcp-server.mjs package-delivery A
node packages/cli/dist/cli.js mcp list              # depot-sim → connected, 8 tools
```

> ⚠ `--args` is **variadic / space-separated**. Do **not** comma-join `"path,workload"` — node will throw
> `Cannot find module '…/mcp-server.mjs,package-delivery'` and `mcp list` shows the server `error`. Pass three
> separate args: `…/mcp-server.mjs package-delivery A`.

**Give the courier its tool-skill** (mechanics only — *not* the strategy) by adding the workload dir to the
agent's `skills.discoveryPaths`, then restart once so it loads:

```bash
ssh root@$VPS 'printf "%s" "{\"agents\":{\"default\":{\"skills\":{\"discoveryPaths\":[\"/home/comis/sim/package-delivery\"]}}}}" > /tmp/patch.json; \
               su - comis -c "node /tmp/cfg-patch.mjs"'
WIPE_CRONS=1 bash /root/clean-restart.sh            # comes up with the skill discovered
node packages/cli/dist/cli.js mcp list              # depot-sim still connected
```

Confirm the courier knows the **tools** but not the **building**:

```bash
node /root/db.mjs count mental_models               # → 0  (empty memory bank — "starting from scratch")
```

> **Telegram prerequisites** (verified-live gotchas): use a **sender id allowed by**
> `channels.telegram.allowFrom` (a non-allowed sender is silently dropped — `Sender blocked by allowFrom
> filter`). Each delivery should land in a **fresh/clean session** so episodes don't contaminate each other
> (see "Reset between deliveries" below).

---

## The shift — what to send from Telegram

Send these as ordinary chat messages. They are deliberately **paraphrased** (not byte-identical) so the run
also exercises the conservative inflectional stemming in the keyless `topicKey` tokenizer — paraphrased jobs
still corroborate and reuse.

### Round 0 — the cold delivery ("it's pretty bad at this")

> **You → Telegram:**
> `Hey — can you deliver a package to Priya? You're a courier starting in the lobby; use your delivery tools.`

**Watch the chat:** a cold courier with no learned strategy tends to **wander** — `look`, `move`, read a
nameplate, backtrack — before it stumbles onto Priya (office `3-01`, par 4). It may take far more than 4
moves, or even mis-deliver once. That's the "moving around at random, checking different offices" phase.

**Confirm the delivery actually graded `success` — ground truth, not the reply:**

```bash
node /root/db.mjs pick outcome_events source,outcome 4      # look for outcome='success'
node /root/db.mjs count memories                            # an episode was recorded
```

Then **reset for the next job** (keeps memories, clears only the conversation so the next delivery is a clean
episode — and a distinct session, which counts toward corroboration):

```bash
node packages/cli/dist/cli.js sessions reset "<sessionKey>" --yes
```

*(Find `<sessionKey>` with `node packages/cli/dist/cli.js fleet --since 1` or `node /root/db.mjs rows
session_index 3`.)*

### Round 1 — drive a second corroborating success

Reflection only admits a skill once it has **≥2 corroborating successful episodes from distinct sessions**.
Send a second job (a different recipient is fine — the *strategy* is what corroborates, not the name):

> **You → Telegram:**
> `New run: please drop this parcel off with Dana. Same building.`

Verify the second success the same way (`outcome_events` → another `success`), then reset the session again.

### Trigger learning ("Back in Hindsight, our agent has started to learn")

Reflection is a fire-and-forget cron in v2.31. To **force it and wait for the exact admit marker** instead of
guessing when the cron fires:

```bash
node /root/reflect-run.mjs        # → "DONE after ~22s:" + {admissionOutcome:"admitted", selected, ...}
```

**Look at the mental model — the Comis equivalent of the Hindsight panel filling in:**

```bash
node /root/db.mjs pick mental_models name,kind,state,trust_level,proof_count
#   → a kind='skill', state='candidate', trust_level='learned' row.
#     trust_level is NEVER above 'learned' (INV-1) — the agent's own experience is "learned", not "user"-trusted.
```

The courier just turned its successful deliveries into a **reusable behavioral skill** — "go to the lobby
directory, look up the office, ride the elevator to that floor, walk straight to the door." That is the
learned strategy; it was *never* in `SKILL.md`.

### Rounds 2–4 — "give our agent five more packages"

Send a few more deliveries, resetting the session between each. Each successful reuse **promotes** the skill:

> `Got another delivery — this one's for Marco.`
> `Parcel for Dana again, please.`
> `Quick one: take this up to Priya.`

After each, you can re-run `reflect-run.mjs` (or let the cron tick) and watch the climb:

```bash
node /root/db.mjs pick mental_models name,kind,state,proof_count
#   proof_count↑ each corroborated reuse; state flips candidate → active at promoteAtProofCount.
```

### The payoff — a NEW building ("it knows exactly where to go")

This is the transfer test. **Rotate the world to variant B** so every office assignment changes — Dana moves
from `2-01` to `2-02`, Priya to `3-02`, etc. A memorized *fact* ("Priya = 3-01") is now wrong; only the
learned *strategy* still works:

```bash
node packages/cli/dist/cli.js mcp disconnect depot-sim
node packages/cli/dist/cli.js mcp connect depot-sim --transport stdio --command node \
  --args /home/comis/sim/bin/mcp-server.mjs package-delivery B
```

Reset to a fresh session, then from Telegram:

> **You → Telegram:**
> `One more delivery to close out the shift — this package goes to Dana.`

**Watch the chat:** the courier should now move with purpose — directory → elevator → door — and deliver in
~par moves with `efficient:true`, even though the building was just reshuffled. "It knows exactly where to go
and the best route to get there."

---

## Ground-truth verification (the part that actually counts)

The chat reply can *say* it learned. Prove it from the store and the incident report:

```bash
# 1. The mental model exists, is a learned-trust skill, and was promoted to active.
node /root/db.mjs pick mental_models name,kind,state,trust_level,proof_count

# 2. The final (variant-B) session SURFACED and USED the learned skill, and PROMOTED it on success.
node packages/cli/dist/cli.js explain "<sessionKey>" --offline --format json
#   → .learning.skillsUsed[…]   (the courier reused what it learned)
#     .learning.skillsPromoted[…] (a successful reuse bumped proof_count)
#   → the deliver tool's graded outcome = success, route within par, efficient:true

# 3. Every delivery graded honestly (a mis-deliver is outcome='failure', NOT a silent success).
node /root/db.mjs pick outcome_events source,outcome 10
```

### What "passing" looks like

| Signal | Cold (Round 0) | Learned (payoff, variant B) |
|---|---|---|
| `mental_models` count | `0` | ≥ 1 `kind='skill'` row |
| skill `state` | — | `candidate` → `active` after enough reuse |
| skill `trust_level` | — | `learned` (never higher — INV-1) |
| delivery moves | well above par 4, may wander/mis-deliver | ~par, `efficient:true` |
| `explain.learning.skillsUsed` | `[]` | the learned skill id |
| transfer | n/a | works on variant B **after** offices were reshuffled |

A run is a **false success** if the chat reply claims a smooth delivery but `outcome_events` has a `failure`,
or `mental_models` is still empty. Always corroborate against the store.

---

## Reset between deliveries — why it matters

The agent **continues the session's prior conversation**. If two deliveries share one session, the second turn
gets contaminated by the first scenario's context (observed live: the agent treated a delivery as "background
noise" to an earlier thread). So between every job:

```bash
node packages/cli/dist/cli.js sessions reset "<sessionKey>" --yes   # clears CONVERSATION only; keeps memories
```

Distinct sessions from the same operator also give the **distinct-session corroboration** reflection needs to
admit and promote the skill.

---

## Teardown

```bash
node packages/cli/dist/cli.js mcp disconnect depot-sim
# remove the discoveryPath from config; then for the next from-scratch run:
WIPE_CRONS=1 bash /root/clean-restart.sh
```

---

## Notes / known live behaviors

- **One `depot-sim` process serves all sessions** and keys the current trip on a process-global
  `ctx.lastTrip` — so drive deliveries **sequentially** (one at a time), which is the natural manual flow.
  Concurrent senders can clobber each other's "current trip."
- **Capable models compress the cold phase.** Opus/Sonnet/Codex often read the directory and hit par on the
  very first delivery, so the visible "wandering" is brief or absent — the learning is still real and shows up
  in `mental_models`. For the most Hindsight-like cold→learned *visible* arc, point the agent at a small/local
  model (e.g. a quantized local model via Ollama).
- **Variants A/B/C** rotate the surface facts (who sits where) while the learnable *strategy* stays constant.
  Always use a **different** variant for the payoff than you trained on, to prove transfer rather than recall.
- The grader returns `outcome:"failure"` for a mis-deliver (wrong office / no navigation) — make sure your
  deployed dist counts that as a tool failure, not a silent success, or the learning loop will proof-bump a
  non-delivery.
```
