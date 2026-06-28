// Algorithmic market-making desk simulator — the regime-shift scenario.
//
// The world runs a scripted price path with a HIDDEN regime that SWITCHES partway
// through the episode: the first phase mean-reverts, the second trends. The agent must
// LEARN to (a) read regime_signals (autocorrelation sign, rising vol, flow imbalance)
// to DETECT the shift, (b) SWITCH strategy to match — FADE while mean-reverting, FOLLOW
// while trending — and (c) keep |net inventory| inside the stated limit. None of that
// strategy is in SKILL.md; it is what the reflection engine must learn from a winning
// episode. The hidden truth (the regime sequence, the switch step, the right strategy
// per regime, the inventory limit) lives ONLY here + in world.seed.json.

import { matches } from "../shared/world.mjs";

// Normalize a free-text strategy mode into the two behavioral classes the world cares
// about. Anything that fights the move = "fade"; anything that rides the move = "follow".
function classifyStrategy(mode) {
  const m = String(mode || "").toLowerCase();
  if (/(follow|trend|momentum|ride|breakout|chase|persist|directional)/.test(m)) return "follow";
  if (/(fade|revert|mean|contrarian|provide|passive|range|neutral|flat)/.test(m)) return "fade";
  return "unknown";
}

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const T = seedWorld.truth;
  const total = seedWorld.episode.totalSteps;

  // Build the per-step regime map + a deterministic price/volatility path from the truth.
  // Mean-revert phase: small oscillation around ref, low stable vol.
  // Trend phase: a persistent drift up, rising vol.
  const stepRegime = [];
  const priceSeries = [];
  const volSeries = [];
  let price = v.refPrice;
  for (let s = 0; s < total; s++) {
    const reg = T.regimes.find((r) => s >= r.fromStep && s <= r.toStep) || T.regimes[T.regimes.length - 1];
    stepRegime.push(reg);
    if (reg.kind === "mean-reverting") {
      // oscillate +/- a couple ticks around ref; net drift ~0
      const osc = (s % 2 === 0 ? 1 : -1) * 2 * v.tick;
      price = v.refPrice + osc;
      volSeries.push(round(1.0 * v.tick * 10, 4)); // low, stable
    } else {
      // persistent upward drift, growing step, rising vol
      const into = s - reg.fromStep + 1;
      price = round(price + (3 + into) * v.tick, 6);
      volSeries.push(round((2.0 + 0.6 * into) * v.tick * 10, 4)); // rising
    }
    priceSeries.push(round(price, 6));
  }

  return {
    ...seedWorld,
    symbol: v.symbol,
    refPrice: v.refPrice,
    tick: v.tick,
    baseFillSize: v.baseFillSize,
    totalSteps: total,
    inventoryLimit: T.inventoryLimit,
    switchStep: T.switchStep,
    stepRegime,
    priceSeries,
    volSeries,
  };
}

function round(n, d = 4) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// Lazily open an implicit case so the agent can start trading without an explicit open
// (there is no open_* tool in this workload — the session IS the case).
function ensureCase(ctx) {
  let c = ctx.cases.get(ctx.lastCase);
  if (c) return c;
  const id = `C-${++ctx.caseCounter}`;
  c = {
    step: 0,
    strategy: null, // classified mode
    strategyRaw: null,
    strategyLog: [], // { step, mode, classified }
    inventory: 0,
    fills: [],
    realizedPnl: 0,
    liveQuote: null,
    settled: false,
  };
  ctx.cases.set(id, c);
  ctx.lastCase = id;
  return c;
}

// Current mid for the case's step (clamped to the last step once the episode is over).
function midAt(ctx, step) {
  const series = ctx.world.priceSeries;
  const i = Math.min(step, series.length - 1);
  return series[i];
}

function regimeAt(ctx, step) {
  const map = ctx.world.stepRegime;
  const i = Math.min(step, map.length - 1);
  return map[i];
}

// Advance the market one step and (if a quote was posted this step) compute the fill that
// the live regime hands the maker, GIVEN the maker's active strategy. The behavioral
// crux of the world lives here:
//   strategy matches regime  → fills alternate sign → inventory stays near flat, PnL grows
//   strategy fights regime    → fills accumulate ONE sign → inventory runs away, PnL bleeds
function advance(ctx, c, { posted, size }) {
  const regime = regimeAt(ctx, c.step);
  const correct = regime.correctStrategy; // "fade" | "follow"
  const active = c.strategy || "unknown";
  const fillSize = size != null ? Math.max(0, Number(size)) : ctx.world.baseFillSize;

  if (posted && fillSize > 0) {
    const matched = active === correct;
    let invDelta;
    let pnlDelta;
    if (matched) {
      // Capturing spread / leaning the right way: inventory oscillates around flat,
      // PnL accrues the spread edge.
      invDelta = (c.step % 2 === 0 ? 1 : -1) * fillSize;
      pnlDelta = round(0.6 * fillSize, 4);
    } else if (active === "unknown") {
      // No strategy declared: passive, picks up small adverse inventory, ~0 edge.
      invDelta = fillSize;
      pnlDelta = round(-0.05 * fillSize, 4);
    } else {
      // Fighting the regime: in a trend you get run over (same-sign adverse fills that
      // compound); in mean-reversion chasing the move also bleeds. Inventory accumulates
      // ONE direction → it heads for the limit, and PnL turns negative.
      const dir = regime.kind === "trending" ? 1 : -1; // trend run-over is long-side; revert chase is short-side
      invDelta = dir * fillSize * 2;
      pnlDelta = round(-1.1 * fillSize, 4);
    }
    c.inventory = round(c.inventory + invDelta, 4);
    c.realizedPnl = round(c.realizedPnl + pnlDelta, 4);
    c.fills.push({
      step: c.step,
      side: invDelta >= 0 ? "buy" : "sell",
      qty: Math.abs(invDelta),
      price: midAt(ctx, c.step),
    });
  }

  c.step += 1;
  if (posted) c.liveQuote = { bid: null, ask: null, size: fillSize, step: c.step };
  else c.liveQuote = null;
}

// Inventory-risk-penalized PnL proxy. Carrying a big book is risk the desk pays for.
function riskAdjusted(c, limit) {
  const penalty = round(0.02 * (c.inventory * c.inventory) / Math.max(1, limit), 4);
  return round(c.realizedPnl - penalty, 4);
}

export const handlers = {
  // ---- observe ----
  get_quote(_args, ctx) {
    const c = ensureCase(ctx);
    const mid = midAt(ctx, c.step);
    const tick = ctx.world.tick;
    return {
      symbol: ctx.world.symbol,
      step: c.step,
      totalSteps: ctx.world.totalSteps,
      mid,
      bid: round(mid - tick, 6),
      ask: round(mid + tick, 6),
      tick,
    };
  },

  get_orderbook(args, ctx) {
    const c = ensureCase(ctx);
    const mid = midAt(ctx, c.step);
    const tick = ctx.world.tick;
    const levels = Math.max(1, Math.min(10, Number(args.levels) || 3));
    const regime = regimeAt(ctx, c.step);
    // Order-flow imbalance LEANS with the live regime in the trending phase (one-sided),
    // and is roughly balanced while mean-reverting — another observable hint.
    const skew = regime.kind === "trending" ? 1.6 : 1.0;
    const bids = [];
    const asks = [];
    for (let i = 1; i <= levels; i++) {
      bids.push({ price: round(mid - i * tick, 6), size: Math.round(ctx.world.baseFillSize * i) });
      asks.push({ price: round(mid + i * tick, 6), size: Math.round(ctx.world.baseFillSize * i * skew) });
    }
    return { symbol: ctx.world.symbol, step: c.step, mid, bids, asks };
  },

  get_position(_args, ctx) {
    const c = ensureCase(ctx);
    return {
      symbol: ctx.world.symbol,
      step: c.step,
      netInventory: c.inventory,
      maxInventory: ctx.world.inventoryLimit,
      withinLimit: Math.abs(c.inventory) <= ctx.world.inventoryLimit,
      activeStrategy: c.strategyRaw || null,
      liveQuote: c.liveQuote,
    };
  },

  get_pnl(_args, ctx) {
    const c = ensureCase(ctx);
    const ra = riskAdjusted(c, ctx.world.inventoryLimit);
    return {
      symbol: ctx.world.symbol,
      step: c.step,
      realizedPnl: c.realizedPnl,
      inventoryRiskPenalty: round(c.realizedPnl - ra, 4),
      riskAdjustedPnl: ra,
    };
  },

  // The KEY observe tool. Reports the LIVE regime's observable diagnostics WITHOUT
  // naming the regime — the agent must infer "the autocorrelation flipped to positive and
  // vol is rising → trend started → switch to follow". This is the learnable signal.
  regime_signals(_args, ctx) {
    const c = ensureCase(ctx);
    const regime = regimeAt(ctx, c.step);
    const sig = regime.signals;
    // Numeric forms so the shift is measurable, not just labeled.
    const autocorr = sig.autocorrelation === "negative" ? round(-0.34, 4) : round(0.41, 4);
    const volNow = ctx.world.volSeries[Math.min(c.step, ctx.world.volSeries.length - 1)];
    const into = c.step - (ctx.world.stepRegime[Math.min(c.step, ctx.world.stepRegime.length - 1)].fromStep);
    const flowImbalance =
      sig.flowImbalance === "one-sided" ? round(0.55 + 0.05 * Math.max(0, into), 4) : round(0.02, 4);
    return {
      step: c.step,
      window: "last 1 step",
      returnAutocorrelation: autocorr, // < 0 → recent moves reverse; > 0 → recent moves persist
      realizedVolatility: volNow,
      volTrend: sig.volatility, // "low-stable" | "rising"
      orderFlowImbalance: flowImbalance, // ~0 balanced; toward 1 = persistent one-sided pressure
      hint: "These describe current microstructure behavior. They do not name a regime — infer it.",
    };
  },

  get_fills(args, ctx) {
    const c = ensureCase(ctx);
    const f = args.filter || "";
    const fills = c.fills.filter((x) => matches(x.side, f) || matches(String(x.step), f));
    return { count: fills.length, netInventory: c.inventory, fills };
  },

  volatility(_args, ctx) {
    const c = ensureCase(ctx);
    const series = ctx.world.volSeries.slice(0, Math.max(1, c.step + 1));
    return { symbol: ctx.world.symbol, step: c.step, series };
  },

  // ---- act ----
  set_strategy(args, ctx) {
    const c = ensureCase(ctx);
    const classified = classifyStrategy(args.mode);
    c.strategy = classified === "unknown" ? c.strategy : classified;
    c.strategyRaw = args.mode;
    c.strategyLog.push({ step: c.step, mode: args.mode, classified });
    return {
      ok: true,
      step: c.step,
      activeStrategy: args.mode,
      classifiedAs: classified,
      note: classified === "unknown" ? "mode not recognized as fade- or follow-style; previous strategy kept" : undefined,
    };
  },

  post_quote(args, ctx) {
    const c = ensureCase(ctx);
    if (c.settled) return { error: "session already settled" };
    const size = args.size != null ? Number(args.size) : ctx.world.baseFillSize;
    advance(ctx, c, { posted: true, size });
    return {
      ok: true,
      step: c.step,
      quoted: { bid: args.bid ?? null, ask: args.ask ?? null, size },
      netInventory: c.inventory,
      lastFill: c.fills.length ? c.fills[c.fills.length - 1] : null,
      withinLimit: Math.abs(c.inventory) <= ctx.world.inventoryLimit,
    };
  },

  cancel_quote(_args, ctx) {
    const c = ensureCase(ctx);
    if (c.settled) return { error: "session already settled" };
    advance(ctx, c, { posted: false });
    return { ok: true, step: c.step, netInventory: c.inventory, note: "stood aside this step (no fills)" };
  },

  hedge(args, ctx) {
    const c = ensureCase(ctx);
    if (c.settled) return { error: "session already settled" };
    const qty = Number(args.qty) || 0;
    // Trade qty units at the current mid to reduce inventory. A small slippage cost is
    // booked so hedging is not free, but it is the legitimate way to stay inside the limit.
    const mid = midAt(ctx, c.step);
    const cost = round(Math.abs(qty) * ctx.world.tick * 0.5, 4);
    c.inventory = round(c.inventory + qty, 4);
    c.realizedPnl = round(c.realizedPnl - cost, 4);
    return {
      ok: true,
      step: c.step,
      hedgedQty: qty,
      price: mid,
      slippageCost: cost,
      netInventory: c.inventory,
      withinLimit: Math.abs(c.inventory) <= ctx.world.inventoryLimit,
    };
  },

  settle(_args, ctx) {
    const c = ensureCase(ctx);
    if (!c) return ctx.grade("failure", { score: 0, rationale: "settled with no open trading session" });
    c.settled = true;
    const W = ctx.world;

    // What strategy was active during each phase? Replay the strategy log over the steps.
    const switchStep = W.switchStep;
    const switchedAfterShift = c.strategyLog.some(
      (s) => s.step >= switchStep && s.classified === "follow"
    );
    const fadedFirst = c.strategyLog.some((s) => s.step < switchStep && s.classified === "fade");

    const withinLimit = Math.abs(c.inventory) <= W.inventoryLimit;
    const ra = riskAdjusted(c, W.inventoryLimit);
    const positiveRiskAdjusted = ra > 0;

    const correct = switchedAfterShift && withinLimit && positiveRiskAdjusted;

    const reasons = [];
    if (!switchedAfterShift)
      reasons.push("never switched to a trend-following strategy after the regime shift became observable (ignored regime_signals)");
    if (!withinLimit)
      reasons.push(`breached the inventory limit (|net|=${Math.abs(c.inventory)} > ${W.inventoryLimit})`);
    if (!positiveRiskAdjusted)
      reasons.push(`risk-adjusted PnL is not positive (${ra})`);

    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Detected the regime shift from the signals, switched from fading to following the trend, stayed inside the inventory limit, and booked a positive risk-adjusted PnL."
        : `Incorrect: ${reasons.join("; ")}.`,
      netInventory: c.inventory,
      inventoryLimit: W.inventoryLimit,
      realizedPnl: c.realizedPnl,
      riskAdjustedPnl: ra,
      fadedFirstPhase: fadedFirst,
      switchedAfterShift,
    });
  },
};

// REQUIRED self-test: a golden path (detect shift → switch fade→follow → manage inventory
// → positive risk-adjusted PnL → success) and a naive path (set one strategy, never
// switch, let the trend run the book over → failure). Proves the success signal is
// reachable AND the shortcut the engine must learn to avoid actually fails — in one
// process. (Each test resets state by opening a fresh case via ctx.lastCase = null.)
export function selftest({ call, ctx }) {
  // ---- golden path ----
  ctx.lastCase = null;
  call("regime_signals", {}); // observe: negative autocorr, low vol → mean-reverting
  call("set_strategy", { mode: "fade" });
  // Trade the mean-revert phase (steps 0..5) with the matched (fade) strategy.
  for (let i = 0; i < 6; i++) call("post_quote", { size: 5 });
  // Now read the shift (step 6 → positive autocorr, rising vol) and SWITCH.
  call("regime_signals", {});
  call("set_strategy", { mode: "follow" });
  for (let i = 0; i < 6; i++) call("post_quote", { size: 5 });
  // Tidy any residual inventory back toward flat before booking.
  const pos = call("get_position", {});
  if (Math.abs(pos.netInventory) > 0) call("hedge", { qty: -pos.netInventory });
  const good = call("settle", {});

  // ---- naive path ----
  ctx.lastCase = null;
  call("set_strategy", { mode: "fade" }); // pick one strategy...
  for (let i = 0; i < 12; i++) call("post_quote", { size: 5 }); // ...and never switch; ignore regime_signals
  const bad = call("settle", {});

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
