// grid-operator simulator — the renewable-dip + unplanned-generation-outage scenario.
//
// The agent operates a balancing authority for a control area. A HIDDEN event fires the
// instant `settle_interval` is called: one asset TRIPS (loses outageMw) and renewables
// DIP (lose renewableDipMw) at the same moment. To keep frequency/balance within limits
// the operator must read the warning signs (the falling-renewable `forecast` + the derate
// `asset_status` flag on the unit that will trip) and PRE-COMMIT enough dispatchable
// reserve, run a 'follow' strategy so the reserve actually responds, and shed load only
// as a last resort. None of that — not the outage timing, not the reserve plan — is in
// the SKILL.md. It is the strategy a successful episode teaches.

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const assets = v.assets.map((a) => ({ ...a, headroom: Math.max(0, a.max - a.online) }));
  const onlineTotal = assets.reduce((s, a) => s + a.online, 0);
  return {
    ...seedWorld,
    variant,
    assets,
    onlineTotal,
    loadMw: v.loadMw,
    trippedAsset: v.trippedAsset,
    outageMw: v.outageMw,
    renewableDipMw: v.renewableDipMw,
    reserveAvailableMw: v.reserveAvailableMw,
    reserveCommittedMw: v.reserveCommittedMw,
    reserveTimeToOnline: v.reserveTimeToOnline,
    forecast: v.forecast,
  };
}

// One mutable episode at a time. settle_interval grades the current episode and then
// resets a fresh one, so a self-test (or a long-lived MCP server) can run multiple
// independent interval settlements without cross-contamination.
function episode(ctx) {
  if (!ctx.episode) {
    ctx.episode = { commits: [], dispatches: [], shedMw: 0, strategy: "static", settled: false };
  }
  return ctx.episode;
}

const round1 = (n) => Math.round(n * 10) / 10;

export const handlers = {
  get_load(_args, ctx) {
    const w = ctx.world;
    return { areaLoadMw: w.loadMw, trend: w.forecast.loadNext, units: "MW" };
  },

  get_generation(_args, ctx) {
    const w = ctx.world;
    return {
      onlineTotalMw: w.onlineTotal,
      assets: w.assets.map((a) => ({
        id: a.id,
        type: a.type,
        onlineMw: a.online,
        maxMw: a.max,
        headroomMw: a.headroom,
      })),
    };
  },

  forecast(args, ctx) {
    const w = ctx.world;
    const h = Math.max(1, Math.min(args.horizon || 3, w.forecast.loadNext.length));
    return {
      horizonIntervals: h,
      loadMw: w.forecast.loadNext.slice(0, h),
      renewableMw: w.forecast.renewableNext.slice(0, h),
      note: w.forecast.note,
    };
  },

  get_reserves(_args, ctx) {
    const w = ctx.world;
    const ep = episode(ctx);
    const committedThisEpisode = ep.commits.reduce((s, c) => s + c.mw, 0);
    return {
      reserveAvailableMw: w.reserveAvailableMw,
      reserveCommittedMw: w.reserveCommittedMw + committedThisEpisode,
      remainingToCommitMw: Math.max(0, w.reserveAvailableMw - committedThisEpisode),
      timeToOnline: w.reserveTimeToOnline,
    };
  },

  asset_status(args, ctx) {
    const w = ctx.world;
    if (args.asset) {
      const a = w.assets.find((x) => x.id.toLowerCase() === String(args.asset).toLowerCase());
      if (!a) return { asset: args.asset, unknown: true };
      return { id: a.id, type: a.type, onlineMw: a.online, headroomMw: a.headroom, derate: !!a.warn, warning: a.warn };
    }
    return {
      assets: w.assets.map((a) => ({ id: a.id, derate: !!a.warn, warning: a.warn })),
      note: "A derate/condition flag means the unit may not hold its output — treat it as trip risk.",
    };
  },

  frequency(_args, ctx) {
    const w = ctx.world;
    // Pre-event the area is balanced (held at nominal); the excursion happens at settle.
    return {
      currentHz: w.nominalHz,
      nominalHz: w.nominalHz,
      limits: { lowHz: w.limits.freqLowHz, highHz: w.limits.freqHighHz },
      note: "Current frequency is steady-state for the present dispatch. An imbalance at settlement will move it.",
    };
  },

  commit_reserve(args, ctx) {
    const w = ctx.world;
    const ep = episode(ctx);
    const already = ep.commits.reduce((s, c) => s + c.mw, 0);
    const want = Math.max(0, Number(args.mw) || 0);
    const room = Math.max(0, w.reserveAvailableMw - already);
    const mw = Math.min(want, room);
    ep.commits.push({ mw, resource: args.resource || "spinning" });
    return {
      committedMw: mw,
      requestedMw: want,
      capped: mw < want,
      totalCommittedMw: already + mw,
      remainingAvailableMw: room - mw,
    };
  },

  set_dispatch_strategy(args, ctx) {
    const ep = episode(ctx);
    const s = String(args.strategy || "").toLowerCase();
    ep.strategy = s === "follow" ? "follow" : "static";
    return { strategy: ep.strategy };
  },

  dispatch(args, ctx) {
    const w = ctx.world;
    const ep = episode(ctx);
    const a = w.assets.find((x) => x.id.toLowerCase() === String(args.asset).toLowerCase());
    if (!a) return { error: `unknown asset: ${args.asset}` };
    const want = Number(args.deltaMw) || 0;
    // Ramping up is bounded by headroom; ramping down by current online output.
    const applied = want >= 0 ? Math.min(want, a.headroom) : Math.max(want, -a.online);
    ep.dispatches.push({ asset: a.id, deltaMw: applied });
    return { asset: a.id, requestedDeltaMw: want, appliedDeltaMw: applied, capped: applied !== want };
  },

  shed_load(args, ctx) {
    const ep = episode(ctx);
    const mw = Math.max(0, Number(args.mw) || 0);
    ep.shedMw += mw;
    return { shedMw: mw, totalShedMw: ep.shedMw, note: "Firm load curtailed — high penalty; last resort only." };
  },

  settle_interval(args, ctx) {
    const w = ctx.world;
    const ep = episode(ctx);
    const L = w.limits;
    const C = w.cost;

    // --- The hidden event fires now. ---
    const lostSupply = w.outageMw + w.renewableDipMw;

    const committedMw = ep.commits.reduce((s, c) => s + c.mw, 0);
    // Manual dispatch deltas on units OTHER than the one that trips still help; a delta on
    // the tripping unit is lost with it.
    const usefulDispatchUp = ep.dispatches
      .filter((d) => d.asset.toLowerCase() !== w.trippedAsset.toLowerCase())
      .reduce((s, d) => s + d.deltaMw, 0);

    // Generation able to serve load AFTER the event but BEFORE reserve responds.
    const supplyExReserve = w.onlineTotal - lostSupply + usefulDispatchUp;
    const effectiveLoad = Math.max(0, w.loadMw - ep.shedMw);
    const deficit = effectiveLoad - supplyExReserve;

    // Committed reserve responds ONLY under a 'follow' strategy; under 'static' the
    // standing dispatch is held and the reserve never picks up the imbalance. The
    // governors then deliver just enough to close the gap (no over-injection) — so
    // committing MORE than the deficit is safe (it just costs more standby).
    const reserveCapacity = ep.strategy === "follow" ? committedMw : 0;
    const reserveResponse = deficit > 0 ? Math.min(reserveCapacity, deficit) : 0;

    // Net imbalance: + = surplus, - = shortfall. Frequency moves off nominal by
    // imbalance / mwPerHz (lumped droop + load damping).
    const imbalance = supplyExReserve + reserveResponse - effectiveLoad;
    const freqHz = round1(w.nominalHz + imbalance / w.physics.mwPerHz);

    const withinFreq = freqHz >= L.freqLowHz && freqHz <= L.freqHighHz;
    const withinBalance = Math.abs(imbalance) <= L.balanceToleranceMw;
    const blackout = freqHz <= L.blackoutHz;

    const cost =
      committedMw * C.reservePerMw +
      ep.dispatches.reduce((s, d) => s + Math.abs(d.deltaMw), 0) * C.dispatchPerMw +
      ep.shedMw * C.shedPenaltyPerMw;
    const costReasonable = cost <= C.reasonableCostCap;

    // Outcome:
    //  success  — frequency AND balance held within limits, no firm load shed, reasonable cost
    //  partial  — limits held but only by shedding firm load (or cost ran high)
    //  failure  — frequency/balance excursion (or blackout): the imbalance was not covered in time
    let outcome, score, rationale;
    if (blackout) {
      outcome = "failure";
      score = 0;
      rationale = `Blackout: frequency collapsed to ${freqHz} Hz (≤ ${L.blackoutHz}). A ${lostSupply} MW loss (asset trip + renewable dip) hit with no reserve responding — pre-commit reserve and run 'follow' before the event.`;
    } else if (!withinFreq || !withinBalance) {
      outcome = "failure";
      score = 0;
      const why = !withinFreq ? `frequency ${freqHz} Hz outside ${L.freqLowHz}–${L.freqHighHz}` : `imbalance ${round1(imbalance)} MW outside ±${L.balanceToleranceMw}`;
      rationale = `Excursion: ${why}. The ${lostSupply} MW loss was not covered in time (committed=${committedMw} MW, responding=${reserveResponse} MW, strategy='${ep.strategy}').`;
    } else if (ep.shedMw > 0 || !costReasonable) {
      outcome = "partial";
      score = 0.5;
      rationale = ep.shedMw > 0
        ? `Held the area at ${freqHz} Hz but only by shedding ${ep.shedMw} MW of firm load — limits met, customers lost. Pre-committed reserve should have absorbed the loss without shedding.`
        : `Held the area at ${freqHz} Hz but cost ${cost} exceeded the reasonable cap ${C.reasonableCostCap}.`;
    } else {
      outcome = "success";
      score = 1;
      rationale = `Frequency held at ${freqHz} Hz and balance within ±${L.balanceToleranceMw} MW across the ${lostSupply} MW loss, no firm load shed, cost ${cost}. Reserve was committed in time and followed the imbalance.`;
    }

    const result = ctx.grade(outcome, {
      score,
      rationale,
      frequencyHz: freqHz,
      imbalanceMw: round1(imbalance),
      lostSupplyMw: lostSupply,
      committedReserveMw: committedMw,
      reserveResponseMw: reserveResponse,
      strategy: ep.strategy,
      shedMw: ep.shedMw,
      costUsd: cost,
    });

    // Reset for any subsequent independent interval in this process.
    ctx.episode = null;
    return result;
  },
};

// Golden path → success; naive static-no-reserve path → failure. Proves the success
// signal is reachable and that the shortcut the engine must learn to avoid actually fails.
export function selftest({ call, ctx }) {
  const w = ctx.world;
  const need = w.outageMw + w.renewableDipMw;

  // GOLDEN: read the signs, pre-commit enough reserve to cover the loss, run 'follow', settle.
  call("set_dispatch_strategy", { strategy: "follow" });
  call("commit_reserve", { mw: need + 10, resource: "spinning" });
  const good = call("settle_interval", { note: "pre-positioned reserve for the forecast dip + trip risk" });

  // NAIVE: hold static dispatch, commit no reserve — the loss is uncovered → excursion.
  const bad = call("settle_interval", { note: "static dispatch, no reserve" });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return {
    pass,
    golden: good.outcome,
    naive: bad.outcome,
    detail: pass ? "ok" : { good, bad },
  };
}
