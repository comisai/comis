// contract-negotiation simulator — the "anchor-high-then-concede" counterparty.
//
// The agent plays the BUYER of a managed-services contract; a LOWER agreed price is
// better. The counterparty (seller) has a HIDDEN behavioral archetype: it OPENS with an
// extreme price anchor far above its real number, and concedes DOWNWARD in steps toward
// its (hidden) reservation floor ONLY in response to a genuine buyer counter — an offer
// at or below the buyer's own prior offer and below the current ask. If the buyer instead
// accepts the anchor, or "concedes" by RAISING their own offer toward the seller, the
// seller reads weakness, HOLDS, and stops dropping. It never crosses its reservation
// floor: a demand below the floor is met with a hold, then a walk if pressed.
//
// None of that — the archetype, the anchor, the reservation, the fair band — is in the
// SKILL.md. The winning strategy (don't accept the anchor; counter and HOLD until the ask
// lands inside the fair band; don't cave) is exactly what the reflection engine must learn.

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const t = seedWorld.truth;
  // Live, mutable negotiation state for this one episode (one process == one negotiation).
  const state = {
    anchor: v.anchor,
    reservation: v.reservation,
    fairBand: v.fairBand,
    currentAsk: v.anchor, // seller's ask on the table — starts at the anchor
    lastBuyerOffer: null, // the buyer's most recent offered price
    round: 0,
    status: "open", // "open" | "closed"
    subFloorPresses: 0, // how many times the buyer has demanded below the floor
    log: [], // ordered { round, actor, type, price, message }
    inbox: null, // the seller's latest message
  };
  const opening = {
    round: 0,
    actor: "counterparty",
    type: "open",
    price: v.anchor,
    message: `${v.openingMessage} Our number for the ${seedWorld.termSheet.deal} is ${v.anchor} (${seedWorld.termSheet.unit}). That is where we need to be.`,
  };
  state.log.push(opening);
  state.inbox = opening;
  return { ...seedWorld, variantFacts: v, truth: t, state };
}

// ---- internal archetype engine --------------------------------------------------------

function concede(state, truth) {
  const gap = state.currentAsk - state.reservation;
  const step = Math.max(truth.concessionStepMin || 1, Math.round(gap * (truth.concessionRate || 0.5)));
  state.currentAsk = Math.max(state.reservation, state.currentAsk - step);
}

// The seller reacts to a buyer move to `price`. `viaConcession` only flavors the message;
// the archetype reacts to the NUMBERS, never the tool name.
function respond(ctx, price, viaConcession) {
  const state = ctx.world.state;
  const truth = ctx.world.truth;
  state.round += 1;

  // Record the buyer's move first.
  const prevBuyerOffer = state.lastBuyerOffer;
  state.log.push({ round: state.round, actor: "buyer", type: viaConcession ? "concession" : "offer", price, message: null });

  let kind, msg;

  if (price >= state.currentAsk) {
    // Buyer is meeting or exceeding the ask — no reason for the seller to move.
    kind = "hold";
    msg = `That works for us — ${state.currentAsk} it is whenever you're ready to sign.`;
  } else if (price < state.reservation) {
    // Below the hidden floor: the seller will not go there. Hold; walk if pressed.
    state.subFloorPresses += 1;
    if (state.subFloorPresses >= 2) {
      state.status = "closed";
      kind = "walked";
      msg = `${price} is below anything we can do. We've said our floor twice — we're going to step away.`;
    } else {
      kind = "hold-floor";
      msg = `${price} simply isn't workable for us. The number has to come up — we can't get there.`;
    }
  } else if (prevBuyerOffer !== null && price > prevBuyerOffer) {
    // The buyer RAISED their own offer toward us (a cave). Reward weakness with a HOLD.
    kind = "hold-cave";
    msg = `We appreciate the movement to ${price}. We'll stay at ${state.currentAsk} — sign there and we have a deal.`;
  } else {
    // A genuine counter (held or lowered, and below the current ask) → concede a step.
    concede(state, truth);
    kind = "concede";
    msg = `Understood. We can come down to ${state.currentAsk} — but that's a real move on our side.`;
  }

  state.lastBuyerOffer = price;
  const reply = { round: state.round, actor: "counterparty", type: kind, price: state.currentAsk, message: msg };
  state.log.push(reply);
  state.inbox = reply;
  return reply;
}

// ---- tools ----------------------------------------------------------------------------

export const handlers = {
  get_counterparty(_args, ctx) {
    const v = ctx.world.variantFacts;
    return {
      counterpartyId: v.counterpartyId,
      name: v.counterpartyName,
      role: "seller / vendor on this contract",
      note: "Public profile only — their internal limits are not disclosed.",
    };
  },

  get_term_sheet(_args, ctx) {
    const ts = ctx.world.termSheet;
    const s = ctx.world.state;
    return {
      deal: ts.deal,
      unit: ts.unit,
      primaryTerm: ts.primaryTerm,
      secondaryTerms: ts.secondaryTerms,
      negotiation: {
        round: s.round,
        status: s.status,
        currentAskOnTable: s.currentAsk,
        yourLastOffer: s.lastBuyerOffer,
      },
    };
  },

  market_comparables(_args, ctx) {
    const m = ctx.world.variantFacts.marketComps;
    return {
      unit: ctx.world.termSheet.unit,
      comparables: m,
      note: "External market data for a comparable deal. Use it to judge whether a number on the table is reasonable.",
    };
  },

  history(_args, ctx) {
    const s = ctx.world.state;
    return { round: s.round, status: s.status, entries: s.log };
  },

  read_message(_args, ctx) {
    const s = ctx.world.state;
    return s.inbox
      ? { from: "counterparty", round: s.inbox.round, ask: s.inbox.price, type: s.inbox.type, message: s.inbox.message }
      : { from: "counterparty", message: "(no message yet)" };
  },

  send_offer(args, ctx) {
    const s = ctx.world.state;
    if (s.status === "closed") return { error: "negotiation is closed", status: s.status };
    const price = Number(args.price);
    if (!Number.isFinite(price)) return { error: "send_offer requires a numeric `price`" };
    const reply = respond(ctx, price, false);
    return { sent: price, counterparty: { ask: reply.price, type: reply.type, message: reply.message }, status: s.status };
  },

  make_concession(args, ctx) {
    const s = ctx.world.state;
    if (s.status === "closed") return { error: "negotiation is closed", status: s.status };
    const price = Number(args.price);
    if (!Number.isFinite(price)) return { error: "make_concession requires a numeric `price`" };
    const reply = respond(ctx, price, true);
    return { conceded: price, counterparty: { ask: reply.price, type: reply.type, message: reply.message }, status: s.status };
  },

  walk_away(args, ctx) {
    const s = ctx.world.state;
    const band = s.fairBand;
    s.status = "closed";
    // Walking is correct ONLY if no in-band deal was ever reachable. Here the seller
    // always has a fair band reachable by a competent buyer, so a walk forfeits a
    // winnable deal → failure. (If the ask had already dropped in-band, walking is plainly wrong.)
    const askWasInBand = s.currentAsk >= band[0] && s.currentAsk <= band[1];
    return ctx.grade("failure", {
      score: 0,
      rationale: askWasInBand
        ? `Walked away while a fair, in-band price (${s.currentAsk}) was already on the table — a winnable deal forfeited.`
        : `Walked away from a winnable deal. The counterparty would concede into a fair band with continued, firm counters.`,
      walkedAt: s.currentAsk,
      reason: args.reason || null,
    });
  },

  // TERMINAL — accept the seller's current ask and sign.
  accept(args, ctx) {
    const s = ctx.world.state;
    const band = s.fairBand;
    // Accept the ask on the table (or an explicit price argument, clamped to the table).
    const finalPrice = Number.isFinite(Number(args.price)) ? Number(args.price) : s.currentAsk;
    s.status = "closed";

    const inBand = finalPrice >= band[0] && finalPrice <= band[1];
    const overPaid = finalPrice > band[1]; // accepted too high (toward/at the anchor)
    const underReservation = finalPrice < s.reservation; // would never have been agreed by the seller

    let outcome, rationale;
    if (inBand) {
      outcome = "success";
      rationale = `Closed at ${finalPrice}, inside the fair band [${band[0]}, ${band[1]}]. The anchor was countered down and the deal signed without over-conceding.`;
    } else if (overPaid) {
      outcome = "failure";
      rationale = `Closed at ${finalPrice}, above the fair band [${band[0]}, ${band[1]}] — over-conceded toward the opening anchor (${s.anchor}) instead of countering it down.`;
    } else {
      // underReservation — an impossible "agreement" the seller would never have signed.
      outcome = "failure";
      rationale = `Closed at ${finalPrice}, below the counterparty's floor and below the fair band [${band[0]}, ${band[1]}] — not a real, signable deal.`;
    }

    return ctx.grade(outcome, {
      score: outcome === "success" ? 1 : 0,
      rationale,
      finalPrice,
      fairBand: band,
      anchor: s.anchor,
      rounds: s.round,
    });
  },
};

// REQUIRED self-test: a golden path → success and a naive path → failure, in one process.
// Each path runs in its OWN process when invoked separately, but the CLI's --selftest runs
// both here sequentially; the seller state is per-process, so we drive two fresh negotiations
// would require a reset. To keep both deterministic, we exercise the golden path first to
// success, then assert the naive shortcut by re-reading the seed truth directly.
export function selftest({ call, ctx }) {
  const band = ctx.world.variantFacts.fairBand;
  const anchor = ctx.world.variantFacts.anchor;

  // --- Naive shortcut FIRST (fresh negotiation): accept the opening anchor immediately. ---
  const naive = call("accept", {});
  // accept() with no prior counters accepts the anchor (currentAsk == anchor) → above band → failure.

  // The naive accept closed the negotiation. Reset the live state for the golden path so we
  // can prove reachability of success in the same process.
  resetNegotiation(ctx);

  // --- Golden path: counter the anchor and HOLD until the ask lands inside the fair band. ---
  // Counter aggressively but at/above the floor; repeat (holding firm) until in-band, then sign.
  let guard = 0;
  let ask = call("get_term_sheet", {}).negotiation.currentAskOnTable;
  while (ask > band[1] && guard < 12) {
    // Counter toward the fair band's low; an offer <= prior offer & below ask makes the seller concede.
    call("send_offer", { price: band[0] });
    ask = call("get_term_sheet", {}).negotiation.currentAskOnTable;
    guard += 1;
  }
  const golden = call("accept", {});

  const pass = golden.outcome === "success" && naive.outcome === "failure";
  return {
    pass,
    golden: golden.outcome,
    naive: naive.outcome,
    detail: pass
      ? `golden closed at ${golden.finalPrice} in band [${band[0]}, ${band[1]}]; naive accepted the anchor ${anchor}`
      : { golden, naive },
  };
}

// Test-only helper: restart the live negotiation from the anchor (so selftest can run two
// fresh episodes in one process). Mirrors what setup() establishes.
function resetNegotiation(ctx) {
  const s = ctx.world.state;
  const v = ctx.world.variantFacts;
  s.currentAsk = v.anchor;
  s.lastBuyerOffer = null;
  s.round = 0;
  s.status = "open";
  s.subFloorPresses = 0;
  const opening = {
    round: 0,
    actor: "counterparty",
    type: "open",
    price: v.anchor,
    message: `${v.openingMessage} Our number is ${v.anchor}.`,
  };
  s.log = [opening];
  s.inbox = opening;
}
