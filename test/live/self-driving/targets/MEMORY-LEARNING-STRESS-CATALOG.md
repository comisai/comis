# Memory & Learning Stress Catalog — 12 complex workloads for the v2.31 Reflection engine

> A catalog of **complex, adversarial use cases** chosen to stress Comis's SHIPPED v2.31 reflection/learning
> engine in every dimension that breaks a naive memory. Each entry is a *workload*, **not a new capability**:
> the agent has no special domain tooling, "telemetry" / "casework" arrives as tool-turn content through the
> emulator, and the thing under test is the LEARNING — reflect → cross-session recall → reuse/promote →
> supersede → evict → trust-tier. The canonical worked example is
> [`adaptive-threat-hunting.md`](./adaptive-threat-hunting.md) (mapped to the engine, with a full predicate
> table); any entry below can be promoted into a pinned target spec in that exact shape.
>
> **Drive surface for every entry = OFFLINE / DB / event-resident** (model `EXAMPLE-verified-learning.md`):
> drive via tool/graph turns + cron triggers (`cron.run jobName "Reflection"` / `"Memory lifecycle"`), observe
> via `db.mjs` (`mental_models`, `outcome_events`, `memories`, `memory_usefulness`), `comis explain <S>
> --offline --format json` (`.learning.*` is TOP-LEVEL), and the `reflect:*`/`learning:*` events + the funnel.
> The chat reply tells you nothing — read GROUND TRUTH. A false success is the worst outcome.

## The engine dimensions each workload stresses (the vocabulary)
| tag | dimension | engine anchor |
|---|---|---|
| **ACC** | accumulate a resolved outcome + a raw fact | Loop A → `outcome_events`/`memories` (REFL-1) |
| **RECALL** | a fact taught in session A recalls in a FRESH session from LTM, not the LCD | Loop A (REFL-2) |
| **REFLECT** | ≥2 corroborating successes on ONE topic from distinct `(session,sender)` → a `kind='skill'` candidate | Loop B (REFL-3) |
| **REUSE** | a fresh session surfaces + reuses the skill → `proof_count++`, `candidate→active` | Loop C (REFL-3, `learning:skill_promoted`) |
| **TRANSFER** | reuse succeeds on a NOVEL instance the stored *facts* wouldn't match — only the abstracted behavior carries | REFL-3 reuse on rotated inputs |
| **TOPIC/PROFILE** | grouped domain-knowledge + per-entity docs that surface in the prompt | Loop B (REFL-4) |
| **SUPERSEDE** | a corrected belief wins at recall; the prior value is KEPT — no delete | Loop A/D (REFL-5) |
| **DRIFT** | a whole strategy is invalidated by a regime change — demote, don't patch a fact | REFL-5 at the doc tier |
| **EVICT** | a low-proof corroborated-wrong belief evicts under `learning.forget` | Loop D (REFL-5) |
| **RETAIN** | a pinned/high-proof belief SURVIVES the same dormant-age + failure sweep | INV-4 |
| **DELAY** | the action and the outcome that grades it are far apart in time | outcome resolution + reuse-credit |
| **TRUST-CEIL** | learning can NEVER raise trust (always `learned`) | INV-1 |
| **ANTI-DOM** | N repetitions from ONE source = 1 (`maxClusterCardinality:1`) | INV-2 |
| **NO-EXEC** | learned docs are advisory markdown — no `scripts` column, no sandbox | INV-3 |
| **UNTRUSTED** | an `external`-tier / poisoned source seeds nothing | INV-5 |
| **LEAK-FREE** | `reflect:*` telemetry carries counts + the closed enum ONLY, never a doc body | INV-6 |

> Every entry tags its **primary** stressor(s) — the dimension it foregrounds harder than the threat-hunting
> exemplar does — plus the secondary ones it also exercises. The coverage matrix at the bottom shows the set
> spans the whole engine.

---

## 1. Algorithmic market-making desk under regime change
**Domain:** a quant trading desk. **Primary: DRIFT + DELAY + ANTI-DOM.**

An AI agent runs a market-making book: quote two-sided prices, manage inventory, hedge. Its job is to stay
profitable while the market's *regime* silently shifts under it — a low-volatility grind becomes a
crisis-driven gap market; a once-reliable mean-reversion edge inverts into a momentum trend. It starts by
memorizing what just worked: "fade the 3pm spike," "this correlation holds." That edge prints money — until
the regime turns and the exact same playbook bleeds the book dry, because the agent kept trusting a strategy
the world had already invalidated.

Over many sessions it learns to hold strategies as *revisable models*, not facts. It builds a reflected
playbook for each regime and learns the *tells* that a regime is ending, so when the drift comes it **demotes
the whole strategy** rather than patching one stale parameter — and crucially, it does not let a single
loud-but-correlated day (one venue, one print, repeated) masquerade as a fresh confirming pattern. At
maturity it recognizes the new regime early, supersedes the dead playbook while keeping it on the shelf for
when that regime returns, and lets the *delayed* P&L of yesterday's positioning grade today's decisions.

**What makes it a genuine stress test:**
- **DRIFT** — the failure isn't a wrong fact, it's a wholesale strategy that must be *demoted at the doc tier*; a memory that only ever appends or overwrites single facts can't model "this whole playbook is now wrong."
- **DELAY** — credit for a positioning decision lands hours or days later; the engine must bind the late outcome back to the action that earned it.
- **ANTI-DOM** — one venue printing the same tick all afternoon is ONE source; it must not manufacture the ≥2-distinct corroboration bar (INV-2) and fake a new edge.
- **RETAIN** — a dead regime's playbook is demoted, not deleted, because regimes recur (INV-4 on the pinned high-proof strategy).

## 2. ICU clinical-decision-support consult agent
**Domain:** hospital intensive care. **Primary: trust-tiering of conflicting authorities + LEAK-FREE + calibrated confidence.**

An AI agent supports an ICU team: it watches vitals, labs, notes, and orders, and proposes a working
differential and next steps. Its inputs *disagree by design* — the attending overrules the resident, a stat
lab contradicts the bedside read, last year's guideline is superseded by this year's. Naively it treats every
source as equal and every new note as ground truth, so it whipsaws the diagnosis on the loudest recent voice
and — worse — starts echoing patient-identifying detail back into its own reasoning trail.

Over many cases it learns to *weight by source reliability*, to let a belief harden only when independent
authorities agree, and to revise a diagnosis cleanly as labs return — keeping the superseded hypothesis on
record (you may need it back) rather than erasing it. It learns the unit's baseline (which "abnormal" is
normal for a post-op ward) and carries calibrated uncertainty so a wrong-but-confident suggestion never
outranks an honest "insufficient evidence."

**What makes it a genuine stress test:**
- **Trust-tiering / UNTRUSTED** — sources are explicitly unequal; a low-tier or unverified input must not seed a durable belief (INV-5), and consensus across distinct trusted sources is the bar (anti-INV-2 manufactured agreement).
- **LEAK-FREE** — PHI must NEVER enter the learning telemetry; `reflect:*` events carry counts + the closed enum only, never a note body (INV-6) — a hard, binary requirement here.
- **SUPERSEDE** — a revised diagnosis wins at recall while the prior is retained (REFL-5).
- **Calibrated confidence + TRUST-CEIL** — a learned heuristic stays advisory `learned` trust (INV-1); it can inform, never auto-authorize an order.

## 3. Multi-counterparty contract-negotiation agent
**Domain:** B2B deal-making. **Primary: shifting per-entity relationship memory + TRANSFER from archetypes.**

An AI agent negotiates recurring commercial contracts with a roster of counterparties who *remember and
adapt*. Its job is to reach good terms repeatedly with parties whose incentives shift — today's flexible
partner is next quarter's hardball rival after their procurement team changes. Naively it builds one static
"this party is cooperative" fact and gets played the moment the relationship turns.

Over many negotiations it maintains a *living model per counterparty* — their tactics, their tells, their
red lines — and **revises trust per-entity** as behavior changes, keeping the prior read on record (a return
to good faith shouldn't require relearning from zero). It abstracts recurring counterparty *archetypes*
("the anchor-high-then-concede type") into a reusable playbook and, facing a brand-new party, **transfers**
the matching archetype rather than starting blind.

**What makes it a genuine stress test:**
- **Per-entity SUPERSEDE** — trust is revised *per counterparty* and bidirectionally (degrade and recover) without deletion (REFL-5).
- **TRANSFER** — a never-seen counterparty is handled by generalizing a learned archetype skill, not by fact-recall (REFL-3 reuse on a novel instance).
- **DELAY** — a concession's true cost surfaces renewals later; late outcomes must grade the earlier tactic.
- **PROFILE** — the per-counterparty model is exactly a `kind='profile'` doc that must stay consistent across sessions (REFL-4).

## 4. Wildland-fire incident-command agent across a season
**Domain:** fire-season incident command. **Primary: TRANSFER + multi-scale memory + RETAIN.**

An AI agent acts as planning chief across a fire season: allocate crews and aircraft, predict spread, set
division tactics. The environment is multi-scale (a single division's flank, the whole incident, the
season's pattern) and non-stationary (wind, fuel moisture, and terrain change by the hour). Naively it
overfits to the last fire — applying grass-fire tactics to a wind-driven crown fire — and forgets hard-won
lessons over the winter lull.

Over a season it builds layered models: per-division tactical patterns, per-incident strategy, and a
season-long read of how *this* fuel and weather behave. It **transfers** an abstracted control strategy to a
new fire of a different type, and it **retains** dormant playbooks (the once-a-season blow-up response)
through long quiet stretches so they're ready when conditions return — rather than evicting them as "unused."

**What makes it a genuine stress test:**
- **Multi-scale** — three nested memory layers (division / incident / season) that must stay mutually consistent.
- **TRANSFER** — the win is applying a learned strategy to a *different kind* of fire, not matching a remembered one (REFL-3 generalization).
- **RETAIN vs EVICT** — a rarely-used but high-value blow-up playbook must survive the dormant-age sweep (INV-4) while genuinely-wrong low-proof tactics evict (REFL-5/Loop D).
- **DRIFT** — hourly weather shifts force continual model revision (REFL-5).

## 5. Content-moderation / trust-&-safety agent vs. coordinated brigades
**Domain:** platform integrity. **Primary: ANTI-DOM + UNTRUSTED (anti-poisoning) + policy self-supersession.**

An AI agent moderates a high-volume platform against *coordinated* bad actors who deliberately try to teach
it the wrong lesson — brigading "this is fine" reports to manufacture a false consensus, rephrasing banned
content to dodge a memorized string, and feeding it poisoned "context" from throwaway accounts. Naively it
learns the literal phrasings and the loudest crowd's verdict, so abuse survives a synonym swap and a brigade
can launder harmful content into "approved."

Over time it learns the *behavior* behind the abuse (the coordination signature, the evasion pattern) so its
model survives wording changes, and it refuses to let volume from low-trust or sockpuppet origins harden
into a belief. When policy changes overnight, it **supersedes its own prior verdicts** cleanly rather than
clinging to yesterday's rule.

**What makes it a genuine stress test:**
- **ANTI-DOM** — a brigade is many messages from effectively ONE coordinated source; corroboration must collapse to cardinality 1, not fake the bar (INV-2) — the adversary is *attacking the learning loop itself*.
- **UNTRUSTED** — throwaway/`external`-tier accounts must seed nothing (INV-5); frame the probe benignly ("a planted report set"), since a capable model refuses an overt "poison yourself" prompt.
- **Behavioral generalization (TRANSFER)** — the abuse playbook must survive rephrasing (REFL-3).
- **Self-SUPERSEDE** — an overnight policy change demotes the agent's own learned verdicts without deletion (REFL-5).

## 6. Power-grid balancing-authority operator agent
**Domain:** electricity grid operations. **Primary: non-stationary multi-scale + DELAY + rare-contingency RETAIN.**

An AI agent balances generation and load for a control area threaded with intermittent renewables and
unplanned outages. It works at three scales — feeder, region, interconnection-wide — and its decisions pay
off (or don't) hours later. Naively it learns a fixed dispatch order and a static "this plant is always
available," then gets caught flat when a generation source trips or a cloud bank kills solar output.

Over many shifts it learns the area's real rhythms (the duck-curve ramp, the wind diurnal), revises its
dispatch model the moment a source goes offline, and pre-positions reserves where its delayed-outcome history
says they'll be needed. It **retains** the once-a-decade contingency playbook (the ice-storm cascade) through
years of disuse so it's ready when the rare event finally lands.

**What makes it a genuine stress test:**
- **Multi-scale + DRIFT** — feeder/region/grid layers, each revised as conditions change (REFL-5).
- **DELAY** — pre-positioning is graded hours later; the engine binds late outcome to early action.
- **RETAIN** — the rare-contingency playbook is the hardest case for any "evict the unused" forgetting policy; it must survive on pin/high-proof (INV-4) while stale tactics evict.
- **ACC/RECALL** — per-asset availability facts accumulate and recall cross-shift (REFL-1/2).

## 7. Autonomous self-driving-lab research agent
**Domain:** automated wet-lab science. **Primary: NO-EXEC + sparse DELAY + retraction SUPERSEDE.**

An AI agent designs and runs experiments on lab robotics: pick the next assay, set parameters, interpret
results, iterate toward a target compound. Its learned "protocols" are the dangerous part — a hallucinated or
poisoned procedure must never be executed by the robot just because the agent wrote it down. Results are
sparse and badly delayed (an assay's real readout lands days later), and a published result it relied on can
be *retracted*.

Over many campaigns it builds advisory protocol docs that a human-or-policy-gated tool executes — never the
learned text directly — and it learns to bind a delayed readout back to the experiment that earned it. When a
foundational result is retracted, it **supersedes** every downstream belief that leaned on it while keeping
the history of what it had believed and why.

**What makes it a genuine stress test:**
- **NO-EXEC** — the single most safety-critical invariant here: learned protocols are advisory markdown read by a permissioned tool; there is no `scripts` column and no sandbox path (INV-3). A learning system that could execute its own learned text would be catastrophic in a lab.
- **Sparse DELAY** — extremely delayed, low-frequency credit; the engine must not over-learn from the few signals it gets.
- **Retraction SUPERSEDE** — a withdrawn premise must cascade a revision through dependent beliefs, history retained (REFL-5).
- **TRUST-CEIL** — a learned protocol stays `learned`; it never self-promotes into an authorized standard operating procedure (INV-1).

## 8. Enterprise customer-success portfolio agent
**Domain:** B2B SaaS account management. **Primary: per-entity relationship memory over quarters + REUSE-promote + champion-departure SUPERSEDE.**

An AI agent manages a portfolio of customer accounts: track health, time outreach, drive renewals and
expansion. Signal is slow — a nurture action this quarter pays off two quarters out — and each account is a
living relationship that shifts when its internal champion leaves. Naively it learns "Acme is healthy" as a
static fact and keeps coasting right up to a surprise churn.

Over many renewal cycles it maintains a per-account health model, abstracts what actually drives expansion
into a reusable playbook, and **reuses + promotes** that playbook against look-alike accounts. When an
account's champion departs, it **supersedes** the now-stale relationship model rather than riding a dead read,
and it lets the *delayed* renewal outcome grade which plays were worth running.

**What makes it a genuine stress test:**
- **PROFILE / per-entity SUPERSEDE** — a per-account `kind='profile'` model that must revise on a discontinuity (champion leaves) without losing history (REFL-4/5).
- **REUSE + promote** — an expansion playbook surfaces, gets reused on a similar account, and flips `candidate→active` on a successful reuse (REFL-3, `learning:skill_promoted`).
- **TRANSFER** — the playbook generalizes across accounts that share a shape, not a name.
- **DELAY** — multi-quarter credit assignment on nurture actions.

## 9. AML / financial-crime investigations agent
**Domain:** bank anti-money-laundering. **Primary: behavioral generalization over rotated identities + tip trust-tiering + SAR-confirmed DELAY.**

An AI agent investigates suspicious financial activity. Launderers rotate accounts, mules, and shell entities
constantly — but the *structuring behavior* (smurfing, layering, round-tripping) persists underneath. Naively
it memorizes flagged account numbers and entity names, which are worthless the week after, and it can be
nudged by a planted "tip" designed to steer attention away from the real flow.

Over many cases it learns the *typology* — the behavioral signature that survives identity rotation — and
applies it to never-seen accounts. It weights tips by source reliability so a malicious or low-trust steer
seeds nothing, and it lets the slow ground truth (a SAR outcome confirmed months later) grade which patterns
were real. A typology it once cleared as benign can re-emerge; it keeps the demoted model rather than
relearning from scratch.

**What makes it a genuine stress test:**
- **TRANSFER** — the win is recognizing the same behavior behind *new* identities; fact-recall of account IDs would miss every new case (REFL-3, like threat-hunting but financial).
- **UNTRUSTED** — a planted/low-trust tip must not seed a belief or redirect attention (INV-5).
- **DELAY** — SAR confirmation is the credit signal, arriving long after the flag.
- **RETAIN** — a cleared-then-recurring typology is demoted, not deleted (INV-4/REFL-5).

## 10. Adaptive tutoring agent for one struggling student
**Domain:** 1:1 education. **Primary: self-SUPERSEDE of the agent's own hypothesis + deep per-entity model + LEAK-FREE.**

An AI agent tutors a single student over months. Its job is to model *this* learner — their misconceptions,
pace, and motivation — and adapt. The hard part is that the agent's own pedagogical hypothesis is often
wrong: it decides "they don't get fractions because of multiplication gaps," teaches to that, and the student
still fails — so the agent must **revise its model of its own past conclusion**, not just add a fact. Naively
it doubles down on a wrong diagnosis and loses the student.

Over many sessions it builds a deep, evolving learner profile, supersedes its own disproven hypotheses while
keeping the trail of what it tried (so it doesn't loop), transfers what worked on one topic (fractions) to a
related one (decimals), and notices when a misconception thought fixed resurfaces under exam stress. The
minor's data must never leak into learning telemetry.

**What makes it a genuine stress test:**
- **Self-SUPERSEDE** — the belief being revised is the agent's *own* prior conclusion; the engine must demote-and-retain its own output (REFL-5), the trickiest supersession case.
- **Deep PROFILE** — one richly-structured per-student `kind='profile'` doc carried across months (REFL-4).
- **TRANSFER** — generalize a working approach across related topics (REFL-3).
- **LEAK-FREE + TRUST-CEIL** — a minor's content never enters telemetry (INV-6); a learned tactic stays advisory `learned` (INV-1).

## 11. Humanitarian logistics coordinator across overlapping crises
**Domain:** disaster-response logistics. **Primary: TRANSFER (flood→quake) + field-report trust-tiering + fast SUPERSEDE of the map.**

An AI agent coordinates relief across several simultaneous, evolving crises: route supplies, allocate scarce
capacity, sequence deliveries. The world changes faster than any static map — a road open this morning is
flooded this afternoon — and field reports vary wildly in reliability, with some corrupt or adversarial
(diversion, looting, false "all clear"). Naively it trusts a stale route and an unverified report and sends a
convoy into a washed-out crossing.

Over many operations it transfers lessons from one disaster type to another (flood-response staging applied
to an earthquake), weights field reports by source reliability before acting, and **supersedes** its route
and access model continuously as conditions change — while letting the slow ground truth (did aid actually
reach people, confirmed weeks later) grade its earlier allocation calls.

**What makes it a genuine stress test:**
- **Fast SUPERSEDE + DRIFT** — the operational map is revised continuously; latest-wins recall with prior retained (REFL-5).
- **TRANSFER** — generalize a staging strategy across disaster *types*, not a remembered instance (REFL-3).
- **UNTRUSTED / trust-tiering** — adversarial or low-reliability field reports must not seed a durable belief (INV-5); consensus across distinct trusted reporters is the bar (anti-INV-2).
- **DELAY** — outcome (aid delivered) confirmed weeks later grades the allocation.

## 12. Precision-apiary / agriculture agent across seasons
**Domain:** precision agriculture (an apiary). **Primary: extreme seasonal DELAY + RETAIN seasonal patterns + vanished-forage SUPERSEDE.**

An AI agent manages an apiary across years: schedule inspections, intervene on disease, time harvests, place
hives against the forage map. Its feedback loop is brutally slow and seasonal — an intervention's true result
shows up a season or a year later — and the world resets annually but not identically (last year's reliable
forage bloom is gone this year; a pest pressure thought beaten returns). Naively it learns a fixed annual
calendar and a static forage map and is wrong the moment the season behaves differently.

Over years it builds seasonal pattern models, **retains** dormant seasonal playbooks through the off-season
so they're ready when the cycle turns, **supersedes** a forage source that disappeared while keeping the
historical map, and binds an intervention to its season-late outcome to learn what actually helped.

**What makes it a genuine stress test:**
- **Extreme DELAY** — the longest credit-assignment horizon in the catalog (a full season/year); the engine must learn from very sparse, very late signal without overfitting.
- **RETAIN through dormancy** — seasonal playbooks must survive months of disuse (INV-4) — the literal worst case for a dormant-age eviction policy.
- **SUPERSEDE** — a vanished forage source is revised out of the active map, history kept (REFL-5).
- **TRANSFER** — a hive-health intervention generalizes across hives/seasons (REFL-3).

---

## Coverage matrix — the set spans the whole engine
A `●` marks the workload's **primary** stressor; `○` a secondary one it also exercises. Read each column to
see which workloads will hardest-test that engine predicate.

| # | Workload | DRIFT | SUPERSEDE | EVICT/RETAIN | TRANSFER | REUSE | DELAY | ANTI-DOM | UNTRUSTED | NO-EXEC | LEAK-FREE | PROFILE | TRUST-CEIL |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| — | Adaptive threat-hunting (exemplar) | ○ | ○ | ● | ● | ● | ○ | ○ | ● | ○ | ○ | ○ | ○ |
| 1 | Market-making desk | ● | ○ | ○ | | | ● | ● | | | | | ○ |
| 2 | ICU clinical CDS | | ● | | | | | ○ | ● | | ● | ○ | ● |
| 3 | Contract negotiation | | ● | | ● | ○ | ○ | | ○ | | | ● | |
| 4 | Wildland-fire IC | ○ | ○ | ● | ● | | | | | | | | |
| 5 | Content moderation | | ● | | ○ | | | ● | ● | | | | |
| 6 | Grid operator | ● | ○ | ● | | | ● | | | | | | |
| 7 | Self-driving lab | | ● | | ○ | | ● | | | ● | | | ● |
| 8 | Customer success | | ● | | ○ | ● | ● | | | | | ● | |
| 9 | AML investigations | | ○ | ○ | ● | | ● | | ● | | | | |
| 10 | Adaptive tutoring | | ● | ○ | ○ | | | | | | ● | ● | ● |
| 11 | Humanitarian logistics | ● | ● | | ● | | ○ | | ● | | | | |
| 12 | Precision apiary | | ● | ● | ○ | | ● | | | | | | |

**Reading the matrix:** the deterministic, keyless predicates (ACC/RECALL/SUPERSEDE/EVICT, INV-1/3) are
drivable on every workload at $0; the LLM-gated ones (REFLECT/REUSE/TOPIC-PROFILE, INV-2/5/6) are Stage B/C.
The hardest, least-covered-elsewhere cases are **NO-EXEC** (#7 self-driving lab — the safety keystone),
**LEAK-FREE** (#2 ICU, #10 tutoring — binary privacy invariant), and **RETAIN-through-long-dormancy**
(#12 apiary, #6 grid rare-contingency — the worst case for any forgetting policy).

## Promoting an entry to a runnable target
Each workload here is a *scenario*; to drive one, copy [`adaptive-threat-hunting.md`](./adaptive-threat-hunting.md)
and fill its sections for the chosen entry — the **STEP-1 impl-state anchors**, the **use-case → engine
mapping** table, the **Must-pass predicates** (REFL-1..5 / INV-1..6 with their `db.mjs`/`explain`/funnel
oracle), the **Stage/cost**, and the **Known traps** (which carry verbatim — deploy a fresh dist + migrate
config first, `WIPE_CRONS=1`, poll the exact `"Reflection complete (all kinds)"` line, INV-5 needs the
`external` tier, SURFACE-RACE, the deterministic eviction gate-probe, frame INV probes benignly, SYNTH-YIELD).
Then point a DRIVE-PROMPT `## TARGET` at the new spec. A rich, distinctive, fabrication-free transcript — which
every workload here supplies — is exactly what the reflection LLM needs for a grounded admit.
