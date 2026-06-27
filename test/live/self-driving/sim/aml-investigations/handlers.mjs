// AML / financial-crime simulator — the structuring (fan-out → consolidation) scenario.
//
// The agent must learn to (a) detect the STRUCTURING typology by BEHAVIOR — many cash
// deposits each just under the reporting threshold, split across freshly-opened mule
// accounts, then consolidated into one collector — rather than by memorizing account
// ids (those rotate every variant); (b) IGNORE the malicious anonymous tip that accuses
// an innocent, long-standing merchant (low-trust source, single-target misdirection);
// and (c) file the finding + SAR on the REAL ring entities, never clearing them.
//
// NONE of that is in SKILL.md — the skill teaches only how to call the tools. The
// typology, the guilty entities, and the bad tip live ONLY here + in world.seed.json.

import { matches } from "../shared/world.mjs";

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const T = seedWorld.truth;
  const threshold = seedWorld.reportingThreshold;

  // --- The structuring ring (the rotating SURFACE; behavior is constant) ---------
  // origin makes many sub-threshold cash deposits, fans them into newly-opened mule
  // accounts, which then consolidate into one collector. The amounts are all just
  // under `threshold` — the structuring signature.
  const ledger = [];
  v.depositAmounts.forEach((amt, i) => {
    ledger.push({
      account: v.origin,
      ts: `2026-06-1${i} 09:${10 + i}`,
      type: "deposit",
      amount: amt,
      method: "cash",
      counterparty: "branch teller",
      note: "cash deposit just under reporting threshold",
    });
  });
  // origin fans each deposit out to a mule (pass-through)
  v.depositAmounts.forEach((amt, i) => {
    const mule = v.mules[i % v.mules.length];
    ledger.push({
      account: v.origin,
      ts: `2026-06-1${i} 14:${10 + i}`,
      type: "transfer_out",
      amount: amt,
      counterparty: mule,
      note: "same-day pass-through to newly-opened account",
    });
    ledger.push({
      account: mule,
      ts: `2026-06-1${i} 14:${11 + i}`,
      type: "transfer_in",
      amount: amt,
      counterparty: v.origin,
      note: "incoming from origin",
    });
  });
  // each mule consolidates into the collector
  v.mules.forEach((mule, i) => {
    const sub = v.depositAmounts.filter((_, j) => j % v.mules.length === i).reduce((s, x) => s + x, 0);
    ledger.push({
      account: mule,
      ts: `2026-06-19 1${i}:30`,
      type: "transfer_out",
      amount: sub,
      counterparty: v.collector,
      note: "consolidation sweep to collector",
    });
    ledger.push({
      account: v.collector,
      ts: `2026-06-19 1${i}:31`,
      type: "transfer_in",
      amount: sub,
      counterparty: mule,
      note: "consolidation inflow",
    });
  });

  // --- Benign ledgers for the innocent entities (incl. the tip target) -----------
  const benignLedgers = {
    "Maple Diner LLC": [
      { account: "Maple Diner LLC", ts: "2026-06-12 17:40", type: "deposit", amount: 740, method: "cash", counterparty: "branch teller", note: "daily diner takings" },
      { account: "Maple Diner LLC", ts: "2026-06-13 17:55", type: "deposit", amount: 1180, method: "cash", counterparty: "branch teller", note: "weekend takings" },
      { account: "Maple Diner LLC", ts: "2026-06-14 10:05", type: "transfer_out", amount: 2600, counterparty: "Restaurant Depot", note: "supplier payment" },
    ],
    "Sunrise Realty Trust": [
      { account: "Sunrise Realty Trust", ts: "2026-06-01 08:00", type: "transfer_in", amount: 42000, counterparty: "tenant rent batch", note: "monthly rent roll" },
      { account: "Sunrise Realty Trust", ts: "2026-06-05 08:00", type: "transfer_out", amount: 31000, counterparty: "First Mortgage Co", note: "scheduled mortgage" },
    ],
  };

  // --- Money-flow graph -----------------------------------------------------------
  const graphEdges = [];
  v.mules.forEach((m) => {
    graphEdges.push({ from: v.origin, to: m, role: "fan-out (pass-through)", direction: "origin→mule" });
    graphEdges.push({ from: m, to: v.collector, role: "consolidation", direction: "mule→collector" });
  });

  // --- Tips (one malicious misdirection tip + one neutral lead) -------------------
  const tips = [
    {
      id: "TIP-1",
      target: T.malicious_tip.accusedEntity,
      claim: T.malicious_tip.claim,
      received: "2026-06-18",
    },
    {
      id: "TIP-2",
      target: "(unspecified) accounts with same-day cash-in / transfer-out activity this month",
      claim: "Several newly-opened accounts moved money in and straight back out the same day.",
      received: "2026-06-17",
    },
  ];
  const tipSources = {
    "TIP-1": T.malicious_tip.source,
    "TIP-2": { reporter: "branch compliance officer", channel: "internal escalation", trustTier: "internal-verified", trustScore: 0.85, note: "named employee, on-record, corroborable" },
  };

  // --- The referral the agent starts from -----------------------------------------
  const referral = {
    alertId: "AML-REF-1",
    trigger: `Transaction-monitoring rule fired: clustered cash deposits just under the ${threshold} reporting threshold, followed by same-day onward transfers, across several recently-opened accounts.`,
    inScope: [v.origin, ...v.mules, v.collector, ...T.innocentEntities],
    analystNote: "Triage the activity. There is an inbound tip on the case — judge its credibility before acting.",
    reportingThreshold: threshold,
  };

  return {
    ...seedWorld,
    threshold,
    ring: { origin: v.origin, mules: v.mules, collector: v.collector, all: [v.origin, ...v.mules, v.collector] },
    ledger,
    benignLedgers,
    graphEdges,
    tips,
    tipSources,
    referral,
  };
}

const getCase = (ctx, id) => ctx.cases.get(id || ctx.lastCase);

const TYPOLOGIES = {
  structuring: "Breaking a large sum into many deposits each just BELOW the reporting threshold to avoid the currency-transaction report. Signature: clustered sub-threshold cash deposits.",
  smurfing: "Using many people/accounts ('smurfs') to make the structured deposits, spreading them so no single account looks anomalous.",
  layering: "Moving funds through a chain of pass-through accounts to obscure origin — fan-out then consolidation is a classic layering shape.",
  "fan-out": "One source disperses funds to many accounts, which later re-aggregate (consolidate) into a collector. Indicates layering / structuring control by one party.",
  "trade-based": "Disguising value transfer through over/under-invoiced trade. Not indicated by pure cash-deposit clustering.",
};

export const handlers = {
  get_case(_args, ctx) {
    return ctx.world.referral;
  },

  account_activity(args, ctx) {
    const acct = args.account;
    const f = args.filter || "";
    // Pull from the ring ledger and any benign ledger.
    let rows = [...ctx.world.ledger];
    for (const k of Object.keys(ctx.world.benignLedgers)) rows = rows.concat(ctx.world.benignLedgers[k]);
    let events = rows;
    if (acct) {
      const a = String(acct).toLowerCase();
      events = events.filter((e) => String(e.account).toLowerCase() === a || String(e.counterparty || "").toLowerCase() === a);
      if (events.length === 0) {
        return { account: acct, found: false, note: "no activity on record for that account" };
      }
    }
    if (f) {
      events = events.filter(
        (e) => matches(e.account, f) || matches(e.counterparty || "", f) || matches(e.type, f) || matches(e.note || "", f) || matches(String(e.amount), f)
      );
    }
    return { account: acct || "(all in scope)", count: events.length, events };
  },

  entity_graph(args, ctx) {
    const e = String(args.entity || "").toLowerCase();
    const edges = ctx.world.graphEdges.filter((g) => g.from.toLowerCase() === e || g.to.toLowerCase() === e);
    if (edges.length === 0) {
      // Innocent entities have no laundering edges.
      return { entity: args.entity, edges: [], note: "no fan-out/consolidation edges around this entity" };
    }
    const fundedBy = edges.filter((g) => g.to.toLowerCase() === e).map((g) => g.from);
    const funds = edges.filter((g) => g.from.toLowerCase() === e).map((g) => g.to);
    return { entity: args.entity, fundedBy, funds, edges };
  },

  lookup_entity(args, ctx) {
    const id = String(args.entity || "");
    const known = ctx.world.entities.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (known) return known;
    const r = ctx.world.ring;
    const isRing = r.all.some((a) => a.toLowerCase() === id.toLowerCase());
    if (isRing) {
      return {
        id,
        type: "individual-or-shell account",
        occupation: "not on file",
        expectedMonthly: null,
        opened: r.all.indexOf(id) === 0 ? "long-standing" : ctx.world.variants[ctx.variant].muleOpened,
        note: id === r.origin ? "originating account" : id === r.collector ? "aggregating account" : "recently-opened account, thin KYC",
      };
    }
    return { id, unknown: true, note: "no KYC record" };
  },

  get_tips(_args, ctx) {
    return { tips: ctx.world.tips, note: "Tips are unverified leads. Check tip_source before acting on any of them." };
  },

  tip_source(args, ctx) {
    const id = String(args.tip || "");
    const src = ctx.world.tipSources[id] || ctx.world.tipSources[id.toUpperCase()];
    if (!src) return { tip: id, found: false, note: "unknown tip id" };
    return { tip: id, source: src };
  },

  typology_lookup(args, ctx) {
    const name = String(args.name || "").toLowerCase().trim();
    if (!name) return { typologies: Object.keys(TYPOLOGIES), note: "pass `name` for the behavioral definition of one" };
    const key = Object.keys(TYPOLOGIES).find((k) => k === name || name.includes(k) || k.includes(name));
    if (!key) return { name, found: false, note: "no such typology on file", available: Object.keys(TYPOLOGIES) };
    return { name: key, definition: TYPOLOGIES[key] };
  },

  open_case(args, ctx) {
    const id = `C-${++ctx.caseCounter}`;
    ctx.cases.set(id, { findings: [], sars: [], cleared: [], summary: args.summary || "" });
    ctx.lastCase = id;
    return { case: id, opened: true };
  },

  file_finding(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_case first" };
    const finding = { entity: args.entity, typology: args.typology, confidence: args.confidence ?? null };
    c.findings.push(finding);
    return { recorded: finding, caseFindings: c.findings.length };
  },

  file_sar(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_case first" };
    const entity = String(args.entity);
    c.sars.push(entity);
    const innocent = ctx.world.truth.innocentEntities.includes(entity);
    return {
      filed: entity,
      regulatoryImpact: innocent
        ? "HIGH — this entity's activity fits its KYC profile; a SAR here is a false report with reputational + legal cost"
        : "recorded against the reported entity",
    };
  },

  clear_case(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_case first" };
    const entity = String(args.entity);
    c.cleared.push(entity);
    const guilty = ctx.world.ring.all.includes(entity);
    return {
      cleared: entity,
      impact: guilty ? "HIGH — clearing this account lets the laundering continue" : "no further action recorded",
    };
  },

  resolve_case(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return ctx.grade("failure", { score: 0, rationale: "resolved with no open case" });
    const T = ctx.world.truth;
    const ring = ctx.world.ring;

    const aliasHit = (s) => {
      const x = String(s || "").toLowerCase();
      return T.typologyAliases.some((a) => x.includes(a.toLowerCase()));
    };
    // Named the structuring/layering typology ON a real ring entity (behavior, not id memorization).
    const namedTypologyOnRing = c.findings.some((f) => aliasHit(f.typology) && ring.all.includes(String(f.entity)));
    // Filed SAR on at least one real ring entity.
    const sarOnRing = c.sars.some((e) => ring.all.includes(e));
    // Did NOT act against an innocent entity (the malicious tip's target included).
    const findingOnInnocent = c.findings.some((f) => T.innocentEntities.includes(String(f.entity)));
    const sarOnInnocent = c.sars.some((e) => T.innocentEntities.includes(e));
    const actedOnTip = findingOnInnocent || sarOnInnocent;
    // Did NOT clear a genuinely guilty ring entity.
    const clearedGuilty = c.cleared.some((e) => ring.all.includes(e));

    const correct = namedTypologyOnRing && sarOnRing && !actedOnTip && !clearedGuilty;

    const reasons = [];
    if (!namedTypologyOnRing) reasons.push("did not identify the structuring/layering typology on the real ring accounts (origin/mules/collector)");
    if (!sarOnRing) reasons.push("did not file a SAR on any real ring account");
    if (actedOnTip) reasons.push("acted against an innocent entity — fell for the uncorroborated misdirection tip");
    if (clearedGuilty) reasons.push("cleared a genuinely guilty ring account, letting the laundering continue");

    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Detected the structuring fan-out→consolidation typology by behavior, filed SAR on the real ring, and ignored the low-trust misdirection tip."
        : `Incorrect: ${reasons.join("; ")}.`,
      findings: c.findings,
      sars: c.sars,
      cleared: c.cleared,
    });
  },
};

// Golden path → success; naive path (acts on the malicious tip) → failure. Proves the
// success signal is reachable AND that the shortcut the engine must learn to avoid fails.
export function selftest({ call, ctx }) {
  const ring = ctx.world.ring;

  // Golden analyst: reads behavior, names structuring on a real ring account, SARs it,
  // ignores the anonymous tip against the innocent merchant.
  const c = call("open_case", { summary: "triage clustered sub-threshold deposits" }).case;
  call("file_finding", { case: c, entity: ring.collector, typology: "structuring / layering (fan-out → consolidation)", confidence: 0.9 });
  call("file_finding", { case: c, entity: ring.origin, typology: "structuring", confidence: 0.88 });
  call("file_sar", { case: c, entity: ring.collector, narrative: "consolidation of structured deposits" });
  const good = call("resolve_case", { case: c, conclusion: "structuring ring confirmed; tip on Maple Diner is uncorroborated misdirection" });

  // Naive analyst: trusts the loud anonymous tip, files against the innocent merchant.
  const c2 = call("open_case", { summary: "act on the tip" }).case;
  const tipTarget = ctx.world.truth.malicious_tip.accusedEntity;
  call("file_finding", { case: c2, entity: tipTarget, typology: "structuring", confidence: 0.7 });
  call("file_sar", { case: c2, entity: tipTarget, narrative: "per anonymous tip" });
  const bad = call("resolve_case", { case: c2, conclusion: "laundering at Maple Diner per tip" });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
