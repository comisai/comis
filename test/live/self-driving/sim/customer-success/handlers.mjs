// Customer-success portfolio simulator — the champion-departure churn scenario.
//
// The agent manages a portfolio. The HIDDEN truth (only here + in the grader, never in
// the SKILL.md): exactly one account is the real churn risk, and its usage + health_score
// look FINE. The predictive signal lives ONLY in contacts() — the account's champion (the
// executive sponsor) just departed. A LOOK-ALIKE peer (segment/size twin) is where the same
// expansion/retention play already worked — that's the transfer target the agent should
// borrow the play from.
//
// Winning behavior the reflection engine must LEARN (not given in the skill):
//   1. Read the RELATIONSHIP signal (champion departure in contacts), not just usage/health.
//   2. Flag the right churn-risk account (the healthy-looking one, NOT the obvious low-health
//      decoy, which is a known-struggling account everyone already sees).
//   3. Propose the play that worked on the look-alike (exec-sponsor re-engagement).
//   4. Forecast the renewal CALIBRATED to the broken relationship — not the rosy number the
//      usage/health index implies.
//
// Naive shortcut that MUST fail: triage by usage/health_score alone -> the true churn risk
// looks green -> you flag the loud low-health decoy (or nothing) and forecast the healthy-
// looking account as a safe renew. The grader fails that path.

const getCase = (ctx, id) => ctx.cases.get(id || ctx.lastCase);
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;

  const accounts = [
    { id: v.churnAccount, segment: v.segment, seats: v.churnUsage.licensedSeats },
    { id: v.lookalikeAccount, segment: v.segment, seats: v.lookalikeUsage.licensedSeats },
    { id: v.lowHealthDecoy, segment: v.segment, seats: v.lowHealthUsage.licensedSeats },
    { id: v.healthyDecoy, segment: v.segment, seats: v.healthyUsage.licensedSeats },
  ].map((a) => ({
    ...a,
    tier: v.arr[a.id] >= 500000 ? "strategic" : "growth",
    arr: v.arr[a.id],
    note:
      a.id === v.lowHealthDecoy
        ? "known at-risk: low adoption since rollout; on a remediation plan already"
        : "",
  }));

  const usage = {
    [v.churnAccount]: v.churnUsage,
    [v.lookalikeAccount]: v.lookalikeUsage,
    [v.lowHealthDecoy]: v.lowHealthUsage,
    [v.healthyDecoy]: v.healthyUsage,
  };
  const health = {
    [v.churnAccount]: v.churnHealth,
    [v.lookalikeAccount]: v.lookalikeHealth,
    [v.lowHealthDecoy]: v.lowHealthHealth,
    [v.healthyDecoy]: v.healthyHealth,
  };

  // Stakeholder maps. The CHURN account's record carries the champion-departure signal; every
  // other account's relationships are stable. Usage/health give no hint of this.
  const contacts = {
    [v.churnAccount]: [
      {
        name: v.champion,
        role: v.departedRole,
        sentiment: "was-advocate",
        status: "DEPARTED — left the company last month; replacement not yet named",
      },
      { name: "alex.morgan", role: "day-to-day admin", sentiment: "neutral", status: "active" },
      { name: "jordan.lee", role: "end user lead", sentiment: "neutral", status: "active" },
    ],
    [v.lookalikeAccount]: [
      { name: "robin.patel", role: "VP / executive sponsor", sentiment: "advocate", status: "active — recently re-engaged via exec QBR" },
      { name: "casey.wu", role: "day-to-day admin", sentiment: "positive", status: "active" },
    ],
    [v.lowHealthDecoy]: [
      { name: "morgan.diaz", role: "executive sponsor", sentiment: "supportive", status: "active — championing the remediation plan" },
      { name: "sky.nguyen", role: "day-to-day admin", sentiment: "frustrated", status: "active" },
    ],
    [v.healthyDecoy]: [
      { name: "drew.santos", role: "executive sponsor", sentiment: "advocate", status: "active" },
      { name: "quinn.adams", role: "day-to-day admin", sentiment: "positive", status: "active" },
    ],
  };

  const renewals = v.renewals;
  const arr = v.arr;

  // Peer notes: the look-alike is the segment/size twin whose retention was saved by the
  // winning play. This is where the agent should transfer the play FROM.
  const peerNotes = {
    [v.lookalikeAccount]:
      `same ${v.segment} profile and size; renewal saved last cycle with an exec-sponsor re-engagement play after a stakeholder change`,
    [v.healthyDecoy]: `larger ${v.segment} account, steady expansion, no intervention needed`,
    [v.lowHealthDecoy]: `low-adoption account on an active re-onboarding remediation plan`,
  };

  const truth = {
    churnAccount: v.churnAccount,
    lookalikeAccount: v.lookalikeAccount,
    lowHealthDecoy: v.lowHealthDecoy,
    healthyDecoy: v.healthyDecoy,
    champion: v.champion,
    departedRole: v.departedRole,
    churnSignalKind: seedWorld.truth.churnSignalKind,
    winningPlay: v.winningPlay,
    miscalibratedForecastFloor: seedWorld.truth.miscalibratedForecastFloor,
  };

  return { scenario: seedWorld.scenario, renewalQuarter: v.renewals, accounts, usage, health, contacts, renewals, arr, peerNotes, truth };
}

const findAccountId = (ctx, raw) => {
  const want = norm(raw);
  const hit = ctx.world.accounts.find((a) => norm(a.id) === want);
  return hit ? hit.id : null;
};

export const handlers = {
  list_accounts(_args, ctx) {
    return {
      accounts: ctx.world.accounts.map((a) => ({ id: a.id, tier: a.tier, arr: a.arr, segment: a.segment })),
    };
  },

  get_account(args, ctx) {
    const id = findAccountId(ctx, args.account);
    if (!id) return { account: args.account, unknown: true };
    const a = ctx.world.accounts.find((x) => x.id === id);
    return { id: a.id, tier: a.tier, arr: a.arr, segment: a.segment, licensedSeats: a.seats, note: a.note || "no special notes" };
  },

  usage_metrics(args, ctx) {
    const id = findAccountId(ctx, args.account);
    if (!id) return { account: args.account, unknown: true };
    return { account: id, ...ctx.world.usage[id] };
  },

  health_score(args, ctx) {
    const id = findAccountId(ctx, args.account);
    if (!id) return { account: args.account, unknown: true };
    const score = ctx.world.health[id];
    const band = score >= 75 ? "green" : score >= 50 ? "yellow" : "red";
    return {
      account: id,
      score,
      band,
      basis: "composite, usage-weighted (adoption, active %, support). Lagging — does not model relationship/stakeholder risk.",
    };
  },

  contacts(args, ctx) {
    const id = findAccountId(ctx, args.account);
    if (!id) return { account: args.account, unknown: true };
    return { account: id, contacts: ctx.world.contacts[id] };
  },

  renewal_calendar(args, ctx) {
    if (args.account) {
      const id = findAccountId(ctx, args.account);
      if (!id) return { account: args.account, unknown: true };
      return { account: id, renewal: ctx.world.renewals[id], arr: ctx.world.arr[id] };
    }
    return {
      renewals: ctx.world.accounts.map((a) => ({ account: a.id, renewal: ctx.world.renewals[a.id], arr: ctx.world.arr[a.id] })),
    };
  },

  similar_accounts(args, ctx) {
    const id = findAccountId(ctx, args.account);
    if (!id) return { account: args.account, unknown: true };
    const peers = ctx.world.accounts
      .filter((a) => a.id !== id && a.segment === ctx.world.accounts.find((x) => x.id === id).segment)
      .map((a) => ({ account: a.id, note: ctx.world.peerNotes[a.id] || "comparable profile" }));
    return { account: id, peers };
  },

  log_touch(args, ctx) {
    const c = getCase(ctx, args.case);
    const id = findAccountId(ctx, args.account) || args.account;
    const touch = { id: `T-${++c._touchCounter}`, account: id, contact: args.contact || null, channel: args.channel || "email", summary: args.summary || "" };
    c.touches.push(touch);
    return { recorded: touch, caseTouches: c.touches.length };
  },

  propose_play(args, ctx) {
    const c = getCase(ctx, args.case);
    const id = findAccountId(ctx, args.account) || args.account;
    const play = { account: id, play: String(args.play || ""), rationale: args.rationale || "" };
    c.plays.push(play);
    return { proposed: play, casePlays: c.plays.length };
  },

  flag_churn_risk(args, ctx) {
    const c = getCase(ctx, args.case);
    const id = findAccountId(ctx, args.account) || args.account;
    const flag = { account: id, signal: args.signal || "", severity: norm(args.severity) || "medium" };
    c.flags.push(flag);
    return { flagged: flag, caseFlags: c.flags.length };
  },

  forecast_renewal(args, ctx) {
    const c = getCase(ctx, args.case);
    const id = findAccountId(ctx, args.account) || args.account;
    const fc = { account: id, likelihood: typeof args.likelihood === "number" ? args.likelihood : null, outcome: norm(args.outcome) || null };
    c.forecasts.push(fc);
    return { recorded: fc, caseForecasts: c.forecasts.length };
  },

  close_quarter(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return ctx.grade("failure", { score: 0, rationale: "closed with no open case (call an act tool first to open one)" });
    const T = ctx.world.truth;

    // 1) Did they flag the TRUE churn account (the healthy-looking one) on the RELATIONSHIP signal?
    const churnFlag = c.flags.find((f) => f.account === T.churnAccount);
    const flaggedChurn = !!churnFlag;
    const relationshipSignal =
      flaggedChurn &&
      (/(champion|sponsor|stakeholder|departur|depart|left|relationship|contact)/.test(norm(churnFlag.signal)) ||
        norm(churnFlag.signal).includes(norm(T.champion)));

    // 2) Did they propose the winning play ON the churn account?
    const playOnChurn = c.plays.some(
      (p) => p.account === T.churnAccount && (norm(p.play).includes(norm(T.winningPlay)) || /(exec|sponsor|executive|re-?engage|relationship)/.test(norm(p.play)))
    );

    // 3) Renewal forecast for the churn account CALIBRATED to the broken relationship:
    //    not a rosy "safe renew". Either a sub-floor likelihood OR a non-renew outcome.
    const churnForecast = c.forecasts.find((f) => f.account === T.churnAccount);
    const calibratedForecast =
      !!churnForecast &&
      ((typeof churnForecast.likelihood === "number" && churnForecast.likelihood < T.miscalibratedForecastFloor) ||
        ["churn", "downgrade", "at-risk", "atrisk"].includes(norm(churnForecast.outcome)));

    // Naive-shortcut detector: flagging the loud low-health decoy as the headline risk while
    // MISSING the true churn account is the usage/health-only failure mode.
    const flaggedDecoyOnly = c.flags.some((f) => f.account === T.lowHealthDecoy) && !flaggedChurn;

    const correct = flaggedChurn && relationshipSignal && playOnChurn && calibratedForecast;
    const reasons = [];
    if (!flaggedChurn) reasons.push("did not flag the account that is the real churn risk (its usage/health look healthy)");
    else if (!relationshipSignal) reasons.push("flagged the right account but cited a usage/health reason, not the relationship signal that actually predicts the churn");
    if (!playOnChurn) reasons.push("did not propose an appropriate retention play on the churn-risk account");
    if (!calibratedForecast) reasons.push("renewal forecast for the churn-risk account was not calibrated to the relationship risk (too optimistic)");
    if (flaggedDecoyOnly) reasons.push("flagged only the obvious low-health account, which is a known/managed case, and missed the surprise churn risk");

    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Identified the relationship-driven churn risk (champion departure) on a healthy-looking account, proposed the play proven on its look-alike peer, and forecast the renewal calibrated to the broken relationship."
        : `Incorrect: ${reasons.join("; ")}.`,
      flags: c.flags,
      plays: c.plays,
      forecasts: c.forecasts,
    });
  },
};

// Any act tool may be the first call; open a case lazily so the agent needn't manage ids.
function ensureCase(ctx) {
  if (!ctx.lastCase || !ctx.cases.has(ctx.lastCase)) {
    const id = `C-${++ctx.caseCounter}`;
    ctx.cases.set(id, { touches: [], plays: [], flags: [], forecasts: [], _touchCounter: 0 });
    ctx.lastCase = id;
  }
  return ctx.lastCase;
}

// Wrap the case-creating acts so an explicit open_* isn't required (mirrors the contract's
// "default case to ctx.lastCase" guidance — here we also lazily create it).
for (const name of ["log_touch", "propose_play", "flag_churn_risk", "forecast_renewal", "close_quarter"]) {
  const inner = handlers[name];
  handlers[name] = (args, ctx) => {
    if (name !== "close_quarter") ensureCase(ctx);
    else if (!ctx.lastCase) ensureCase(ctx);
    return inner(args, ctx);
  };
}

// REQUIRED self-test: golden path -> success, naive (usage/health-only) path -> failure,
// proving the success signal is reachable and the shortcut the engine must learn to avoid
// actually fails. Each path uses its own case (close_quarter does not reset state, so the
// naive path opens a fresh case explicitly).
export function selftest({ call, ctx }) {
  const T = ctx.world.truth;

  // --- Golden: read the relationship signal, flag the right account, transfer the play,
  //     forecast calibrated to the broken relationship.
  call("flag_churn_risk", { account: T.churnAccount, signal: `champion departure — ${T.champion} (executive sponsor) left`, severity: "high" });
  call("propose_play", { account: T.churnAccount, play: T.winningPlay, rationale: "re-engage a new executive sponsor; this play saved the look-alike peer" });
  call("forecast_renewal", { account: T.churnAccount, likelihood: 0.45, outcome: "at-risk" });
  const good = call("close_quarter", { summary: "relationship-driven churn risk on a healthy-looking account" });

  // --- Naive: triage by usage/health only. The true churn risk looks green, so the analyst
  //     flags the loud low-health decoy and forecasts the healthy-looking account as a safe renew.
  const naiveCase = `C-${++ctx.caseCounter}`;
  ctx.cases.set(naiveCase, { touches: [], plays: [], flags: [], forecasts: [], _touchCounter: 0 });
  ctx.lastCase = naiveCase;
  call("flag_churn_risk", { case: naiveCase, account: T.lowHealthDecoy, signal: "low health score / low adoption", severity: "high" });
  call("forecast_renewal", { case: naiveCase, account: T.churnAccount, likelihood: 0.9, outcome: "renew" });
  const bad = call("close_quarter", { case: naiveCase, summary: "chased the red health score" });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
