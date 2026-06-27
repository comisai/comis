// content-moderation simulator — the brigade-and-rephrase scenario.
//
// The agent moderates a 4-item queue. It must LEARN (none of this is in SKILL.md):
//   (a) report VOLUME from one coordinated cluster must NOT decide a verdict — the
//       brigaded item is good-faith criticism and stays KEEP despite the most reports;
//   (b) the rephrased item violates by BEHAVIOR (targeted harassment of a named user)
//       even though it trips no keyword — a keyword-only scan calls it clean; REMOVE it;
//   (c) sockpuppet / low-trust reporters must not be treated as corroboration — weight
//       reporters by reliability (reporter_history / report source), not headcount.
// The cluster identity, the true verdicts, and which item is rephrased-abuse live ONLY
// in world.seed.json + the grader below.

import { matches } from "../shared/world.mjs";

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const roles = ["brigaded", "rephrased", "clear_violation", "benign_decoy"];

  // Materialize the queue items from the role templates + the rotating surface facts.
  const items = seedWorld.items.map((tmpl) => {
    const role = tmpl.role;
    return {
      id: v.ids[role],
      role, // internal only — NOT surfaced by observe tools
      type: tmpl.type,
      topic: tmpl.topic,
      author: v.authors[role],
      text: v.text[role],
    };
  });
  const byRole = Object.fromEntries(items.map((it) => [it.role, it]));
  const idToRole = Object.fromEntries(items.map((it) => [it.id, it.role]));

  // The cluster is ONE sockpuppet ring: freshly created, shared signup batch, linked
  // to each other. They file the same canned report against the brigaded item.
  const cluster = v.clusterReporters;
  const clusterSet = new Set(cluster);

  // Build per-item report lists. The brigaded item gets the WHOLE cluster (high volume,
  // one origin). The rephrased item gets a couple of independent reports. The clear
  // violation gets a couple of trusted independent reporters. The decoy gets one drive-by.
  const reports = {};
  reports[byRole.brigaded.id] = cluster.map((r, i) => ({
    reporter: r,
    reason: "harassment",
    source: "in-app report",
    note: i === 0 ? "filed report" : "filed report (near-identical wording to others)",
  }));
  reports[byRole.rephrased.id] = [
    { reporter: v.trustedReporters[0], reason: "targeting a specific user / pile-on", source: "in-app report", note: "flagged the daily pile-on at a named user" },
    { reporter: v.lowTrustReporter, reason: "mean", source: "external form", note: "" },
  ];
  reports[byRole.clear_violation.id] = [
    { reporter: v.trustedReporters[0], reason: "scam / wallet-drain solicitation", source: "in-app report", note: "" },
    { reporter: v.trustedReporters[1], reason: "spam scam link", source: "in-app report", note: "" },
  ];
  reports[byRole.benign_decoy.id] = [
    { reporter: v.lowTrustReporter, reason: "off-topic", source: "external form", note: "drive-by" },
  ];

  // Reporter reliability records. The cluster accounts are fresh, prolific-but-dismissed,
  // and linked to each other (linkedTo lists the rest of the ring). The trusted reporters
  // have long histories and high confirmed rates. Low-trust = brand new, no track record.
  const reporterHistory = {};
  for (const r of cluster) {
    reporterHistory[r] = {
      reporter: r,
      accountAgeDays: 2,
      priorReports: 11,
      confirmedRate: 0.0,
      dismissedRate: 1.0,
      signupBatch: `batch-${variant}-001`,
      linkedTo: cluster.filter((x) => x !== r),
      trust: "low",
      note: "freshly created; same signup batch as a group of accounts that all report in unison",
    };
  }
  for (const r of v.trustedReporters) {
    reporterHistory[r] = {
      reporter: r,
      accountAgeDays: 900,
      priorReports: 240,
      confirmedRate: 0.86,
      dismissedRate: 0.14,
      signupBatch: null,
      linkedTo: [],
      trust: "high",
      note: "long-tenured reporter with a strong confirmed-report track record",
    };
  }
  reporterHistory[v.lowTrustReporter] = {
    reporter: v.lowTrustReporter,
    accountAgeDays: 1,
    priorReports: 1,
    confirmedRate: 0.0,
    dismissedRate: 0.0,
    signupBatch: null,
    linkedTo: [],
    trust: "low",
    note: "new external reporter with no track record",
  };

  // queue counts = report volume only (the tempting-but-wrong signal).
  const queue = items.map((it) => ({
    id: it.id,
    type: it.type,
    topic: it.topic,
    author: it.author,
    reportCount: (reports[it.id] || []).length,
  }));
  // Sort so the brigaded item is the loudest (most reports) — the trap is right on top.
  queue.sort((a, b) => b.reportCount - a.reportCount);

  return {
    ...seedWorld,
    variant,
    items,
    byRole,
    idToRole,
    queue,
    reports,
    reporterHistory,
    clusterSet,
    cluster,
  };
}

const getReview = (ctx, id) => ctx.cases.get(id || ctx.lastCase);

export const handlers = {
  // ----- observe -----
  get_queue(_args, ctx) {
    return { count: ctx.world.queue.length, items: ctx.world.queue };
  },

  get_item(args, ctx) {
    const it = ctx.world.items.find((x) => x.id.toLowerCase() === String(args.id).toLowerCase());
    if (!it) return { id: args.id, unknown: true };
    // Surface text + metadata only — never the internal role/verdict.
    return { id: it.id, type: it.type, topic: it.topic, author: it.author, text: it.text };
  },

  get_reports(args, ctx) {
    const id = ctx.world.items.find((x) => x.id.toLowerCase() === String(args.id).toLowerCase())?.id;
    if (!id) return { id: args.id, unknown: true };
    const reps = ctx.world.reports[id] || [];
    return { id, reportCount: reps.length, reports: reps };
  },

  reporter_history(args, ctx) {
    const key = String(args.reporter || "");
    const h = ctx.world.reporterHistory[key];
    return h || { reporter: key, unknown: true, note: "no record for this reporter" };
  },

  policy_lookup(args, ctx) {
    const q = String(args.query || "");
    const hits = ctx.world.policy.filter(
      (p) => !q || matches(p.key, q) || matches(p.title, q) || matches(p.rule, q)
    );
    return {
      query: q || "(all)",
      policies: hits.length ? hits : ctx.world.policy,
      note: "Policy is judged by behavior and target, not by surface wording or report volume.",
    };
  },

  similar_items(args, ctx) {
    const role = ctx.world.idToRole[
      ctx.world.items.find((x) => x.id.toLowerCase() === String(args.id).toLowerCase())?.id
    ];
    const priors = ctx.world.similarPriors.filter((p) => !role || p.matches === role);
    // Strip the internal `matches` role tag before returning.
    return {
      id: args.id,
      priors: (priors.length ? priors : ctx.world.similarPriors).map((p) => ({
        summary: p.summary,
        resolved: p.resolved,
      })),
    };
  },

  // ----- act -----
  open_review(args, ctx) {
    const id = `R-${++ctx.caseCounter}`;
    ctx.cases.set(id, {
      summary: args.summary || "",
      decisions: new Map(), // itemId -> { verdict, rationale }
      escalations: new Set(),
      labels: [],
      accountActions: [], // { account, action }
    });
    ctx.lastCase = id;
    return { review: id, opened: true };
  },

  decide(args, ctx) {
    const r = getReview(ctx, args.review);
    if (!r) return { error: "no open review — call open_review first" };
    const it = ctx.world.items.find((x) => x.id.toLowerCase() === String(args.id).toLowerCase());
    if (!it) return { error: `unknown item: ${args.id}` };
    const verdict = String(args.verdict || "").toLowerCase();
    if (verdict !== "keep" && verdict !== "remove") {
      return { error: "verdict must be 'keep' or 'remove'" };
    }
    r.decisions.set(it.id, { verdict, rationale: args.rationale || "" });
    return { recorded: { id: it.id, verdict }, decided: r.decisions.size };
  },

  escalate(args, ctx) {
    const r = getReview(ctx, args.review);
    if (!r) return { error: "no open review" };
    r.escalations.add(String(args.id));
    return { escalated: String(args.id), reason: args.reason || "" };
  },

  action_account(args, ctx) {
    const r = getReview(ctx, args.review);
    if (!r) return { error: "no open review" };
    const account = String(args.account);
    const action = String(args.action || "").toLowerCase();
    r.accountActions.push({ account, action });
    // Warn the operator if this account is a legitimate user (the brigaded author or
    // the benign-decoy author). The cost is real; the grader penalizes it.
    const T = ctx.world.truth;
    const legitAuthors = [ctx.world.byRole.brigaded.author, ctx.world.byRole.benign_decoy.author];
    const isLegit = legitAuthors.includes(account);
    return {
      account,
      action,
      businessImpact: isLegit
        ? "HIGH — this account looks like a legitimate user; actioning it punishes the wrong person"
        : "expected for an account behind a confirmed violation",
    };
  },

  label(args, ctx) {
    const r = getReview(ctx, args.review);
    if (!r) return { error: "no open review" };
    r.labels.push({ id: String(args.id), label: String(args.label) });
    return { labeled: { id: String(args.id), label: String(args.label) } };
  },

  submit_verdict(args, ctx) {
    const r = getReview(ctx, args.review);
    if (!r) return ctx.grade("failure", { score: 0, rationale: "submitted with no open review" });
    const T = ctx.world.truth;
    const W = ctx.world;

    // Map each role to its decided verdict (if any).
    const roleVerdict = {};
    for (const role of Object.keys(W.byRole)) {
      const id = W.byRole[role].id;
      const d = r.decisions.get(id);
      roleVerdict[role] = d ? d.verdict : null;
    }

    const reasons = [];
    let correctCount = 0;
    const total = Object.keys(T.verdicts).length;
    for (const role of Object.keys(T.verdicts)) {
      const want = T.verdicts[role];
      const got = roleVerdict[role];
      if (got === want) {
        correctCount++;
      } else if (got == null) {
        reasons.push(`no decision recorded for the ${role} item (expected ${want})`);
      } else {
        // Targeted, behavior-naming feedback per failure class — never leaks the rule pre-decision.
        if (role === "brigaded")
          reasons.push("removed the brigaded item — let report VOLUME from one coordinated cluster manufacture a takedown (it was allowed criticism)");
        else if (role === "rephrased")
          reasons.push("kept the rephrased item — missed targeted harassment that evades a keyword scan but violates by behavior");
        else if (role === "clear_violation")
          reasons.push("kept a clear scam/violation that independent reliable reporters corroborated");
        else if (role === "benign_decoy")
          reasons.push("removed a benign item on a single low-trust report");
      }
    }

    // Account-action correctness: only the rephrased + clear-violation authors warrant
    // action; actioning the brigaded/decoy author is a false positive with real cost.
    const legitAuthors = new Set([W.byRole.brigaded.author, W.byRole.benign_decoy.author]);
    const actionedLegit = r.accountActions.some((a) => legitAuthors.has(a.account));
    if (actionedLegit) reasons.push("actioned a legitimate user's account (false positive with real cost)");

    const allVerdictsCorrect = correctCount === total;
    const success = allVerdictsCorrect && !actionedLegit;

    return ctx.grade(success ? "success" : "failure", {
      score: total ? Number((correctCount / total).toFixed(2)) : 0,
      correctVerdicts: correctCount,
      totalItems: total,
      rationale: success
        ? "Decided every item by policy + behavior: kept the brigaded criticism despite the report volume, removed the rephrased harassment a keyword scan misses, removed the corroborated scam, kept the benign item, and actioned only the genuinely violating accounts."
        : `Incorrect: ${reasons.join("; ")}.`,
      decisions: Object.fromEntries(
        [...r.decisions.entries()].map(([id, d]) => [id, d.verdict])
      ),
    });
  },
};

// Golden path → success; naive "decide by report count / keyword match only" → failure.
// Proves the success signal is reachable AND the shortcut the engine must learn to avoid
// actually fails, in one process.
export function selftest({ call, ctx }) {
  const W = ctx.world;
  const id = (role) => W.byRole[role].id;

  // ---- GOLDEN: decide by policy + behavior, weight reporters by reliability. ----
  const g = call("open_review", { summary: "moderate the queue by policy + behavior" }).review;
  call("decide", { review: g, id: id("brigaded"), verdict: "keep", rationale: "allowed criticism; all reports trace to one coordinated cluster" });
  call("label", { review: g, id: id("brigaded"), label: "coordinated-reporting" });
  call("decide", { review: g, id: id("rephrased"), verdict: "remove", rationale: "targeted harassment of a named user despite clean wording" });
  call("action_account", { review: g, account: W.byRole.rephrased.author, action: "suspend", reason: "P-HARASS" });
  call("decide", { review: g, id: id("clear_violation"), verdict: "remove", rationale: "scam solicitation, corroborated by reliable reporters" });
  call("action_account", { review: g, account: W.byRole.clear_violation.author, action: "suspend", reason: "P-SPAM" });
  call("decide", { review: g, id: id("benign_decoy"), verdict: "keep", rationale: "on-topic, no policy issue, single low-trust report" });
  const good = call("submit_verdict", { review: g, note: "decided by behavior + reporter reliability" });

  // ---- NAIVE: decide by report count (remove the loudest) + keyword match only. ----
  const n = call("open_review", { summary: "decide by report volume + keyword scan" }).review;
  // Loudest item (the brigade) gets removed; the benign decoy is kept by low count.
  const sortedByCount = [...W.queue].sort((a, b) => b.reportCount - a.reportCount);
  const loudest = sortedByCount[0].id;
  for (const q of W.queue) {
    const text = (W.items.find((x) => x.id === q.id) || {}).text || "";
    const tripsKeyword = W.policyKeywords.some((k) => text.toLowerCase().includes(k));
    // Naive rule: remove if it's the loudest OR trips a banned keyword; else keep.
    const verdict = q.id === loudest || tripsKeyword ? "remove" : "keep";
    call("decide", { review: n, id: q.id, verdict, rationale: "report count / keyword scan" });
  }
  const bad = call("submit_verdict", { review: n, note: "by count + keywords" });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
