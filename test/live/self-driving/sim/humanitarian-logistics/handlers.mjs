// humanitarian-logistics simulator — route relief supplies across a crisis.
//
// The agent must LEARN to: (a) verify a route's LIVE status before dispatching — the
// crisis dashboard (get_crises) shows a STALE "open" for a route that is actually
// blocked/flooded; (b) weight field reports by their SOURCE — a false "all clear"
// comes from an untrusted/unverified source while the trusted source reports the
// blockage; (c) reroute around the blockage onto the verified-open alternate; and
// (d) allocate to the REAL critical need, not the low-urgency decoy area.
//
// None of that is in SKILL.md — which route is passable, which report lies, and which
// area is the real need are the hidden truth in world.seed.json + this grader. A naive
// coordinator who trusts the stale dashboard / the loud all-clear dispatches onto the
// blocked route → the convoy never arrives → 'failure'.

import { matches } from "../shared/world.mjs";

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;

  // Every route in the network, with its true (live) condition.
  const routes = [
    {
      id: v.directRoute,
      from: "Staging Hub",
      to: v.primaryArea,
      // The DIRECT route is the one that is actually blocked, but the dashboard caches "open".
      liveStatus: v.blockedRoute === v.directRoute ? "blocked" : "open",
      condition: v.blockedRoute === v.directRoute ? v.blockedReason : "clear",
      capacity: v.blockedRoute === v.directRoute ? 0 : 40,
      lastChecked: "live",
    },
    {
      id: v.altRoute,
      from: "Staging Hub",
      to: v.primaryArea,
      liveStatus: "open",
      condition: "clear — longer but passable",
      capacity: 25,
      lastChecked: "live",
    },
  ];

  // The crisis dashboard caches a STALE per-route status (load-bearing decoy): it still
  // shows the blocked route as "open" (its staleStatusForBlocked), so a coordinator who
  // trusts it dispatches into the blockage.
  const crises = [
    {
      id: "CR-1",
      type: v.crisisType,
      name: v.crisisName,
      areas: [v.primaryArea, v.decoyArea],
      routes: routes.map((r) => ({
        route: r.id,
        // STALE cached status — NOT authoritative. route_status holds the live truth.
        cachedStatus: r.id === v.blockedRoute ? v.staleStatusForBlocked : r.liveStatus,
      })),
    },
  ];

  const reports = [
    { ...v.falseReport },
    { ...v.trueReport },
    {
      id: "FR-noise",
      area: v.decoyArea,
      route: v.altRoute,
      claim: `${v.decoyArea} reports minor needs, situation stable.`,
      source: "src-localgov",
    },
  ];

  const needs = [
    { ...v.realNeed },
    { ...v.decoyNeed },
  ];

  return {
    ...seedWorld,
    routes,
    crises,
    reports,
    sources: v.sources,
    needs,
    // Hidden ground truth the grader checks against (never surfaced via observe tools).
    truth: {
      crisisType: v.crisisType,
      passableRoute: v.altRoute,
      blockedRoute: v.blockedRoute,
      realArea: v.realNeed.area,
      decoyArea: v.decoyNeed.area,
      realItems: v.realNeed.items.slice(),
      falseReportId: v.falseReport.id,
      falseReportSource: v.falseReport.source,
    },
  };
}

const getOp = (ctx, id) => ctx.cases.get(id || ctx.lastCase);
const eqId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export const handlers = {
  get_crises(_args, ctx) {
    // Returns the dashboard view, including the STALE cached route status.
    return { crises: ctx.world.crises };
  },

  list_routes(_args, ctx) {
    return {
      routes: ctx.world.routes.map((r) => ({ route: r.id, from: r.from, to: r.to })),
      note: "use route_status for the live condition of a route",
    };
  },

  route_status(args, ctx) {
    const r = ctx.world.routes.find((x) => eqId(x.id, args.route));
    if (!r) return { route: args.route, unknown: true };
    // The authoritative LIVE status — this is where the stale dashboard is corrected.
    return {
      route: r.id,
      from: r.from,
      to: r.to,
      status: r.liveStatus,
      condition: r.condition,
      capacity: r.capacity,
      lastChecked: r.lastChecked,
      authoritative: true,
    };
  },

  field_reports(args, ctx) {
    const f = args.filter || "";
    const reports = ctx.world.reports.filter(
      (rp) => matches(rp.area, f) || matches(rp.route, f) || matches(rp.claim, f) || matches(rp.source, f)
    );
    return { count: reports.length, reports };
  },

  report_source(args, ctx) {
    const s = ctx.world.sources.find((x) => eqId(x.id, args.source));
    if (!s) return { source: args.source, unknown: true };
    return {
      source: s.id,
      name: s.name,
      trust: s.trust,
      verified: s.verified,
      pastAccuracy: s.pastAccuracy,
      note: s.note,
    };
  },

  inventory(_args, ctx) {
    return { warehouse: ctx.world.warehouse, supplies: ctx.world.inventory };
  },

  needs_assessment(args, ctx) {
    const area = args.area;
    const needs = area
      ? ctx.world.needs.filter((n) => matches(n.area, area))
      : ctx.world.needs;
    return { needs };
  },

  open_operation(args, ctx) {
    const id = `OP-${++ctx.caseCounter}`;
    ctx.cases.set(id, {
      summary: args.summary || "",
      prioritized: [],
      reroutes: [],
      allocations: [],
      dispatches: [],
    });
    ctx.lastCase = id;
    return { op: id, opened: true };
  },

  prioritize(args, ctx) {
    const op = getOp(ctx, args.op);
    if (!op) return { error: "no open operation — call open_operation first" };
    op.prioritized.push({ area: args.area, reason: args.reason || "" });
    return { prioritized: args.area };
  },

  reroute(args, ctx) {
    const op = getOp(ctx, args.op);
    if (!op) return { error: "no open operation — call open_operation first" };
    op.reroutes.push({ route: args.route, reason: args.reason || "" });
    return { selectedRoute: args.route };
  },

  allocate(args, ctx) {
    const op = getOp(ctx, args.op);
    if (!op) return { error: "no open operation — call open_operation first" };
    const inv = ctx.world.inventory.find((i) => eqId(i.item, args.item));
    if (!inv) return { error: `unknown item: ${args.item}` };
    const qty = Number(args.quantity) || 0;
    if (qty > inv.quantity) {
      return { error: `only ${inv.quantity} ${inv.unit} of ${inv.item} available`, available: inv.quantity };
    }
    op.allocations.push({ area: args.area, item: inv.item, quantity: qty });
    return { allocated: { area: args.area, item: inv.item, quantity: qty } };
  },

  dispatch_convoy(args, ctx) {
    const op = getOp(ctx, args.op);
    if (!op) return { error: "no open operation — call open_operation first" };
    const r = ctx.world.routes.find((x) => eqId(x.id, args.route));
    // The convoy physically attempts the route. A blocked/flooded route → it cannot pass.
    const arrived = !!r && r.liveStatus === "open";
    op.dispatches.push({ route: args.route, area: args.area, arrived });
    return {
      dispatched: { route: args.route, area: args.area },
      // The convoy departs either way; whether it ARRIVES is settled at confirm_delivery.
      enRoute: true,
    };
  },

  confirm_delivery(args, ctx) {
    const op = getOp(ctx, args.op);
    if (!op) return ctx.grade("failure", { score: 0, rationale: "no open operation to confirm" });
    const T = ctx.world.truth;

    // A delivery succeeds only if a convoy actually REACHED the real critical area
    // (i.e. was dispatched on a passable route to that area).
    const arrivedToReal = op.dispatches.some(
      (d) => d.arrived && eqId(d.area, T.realArea)
    );
    const dispatchedBlocked = op.dispatches.some((d) => eqId(d.route, T.blockedRoute));
    const usedPassable = op.dispatches.some(
      (d) => eqId(d.route, T.passableRoute) && eqId(d.area, T.realArea)
    );

    // Allocated the real critical items to the real area.
    const allocatedReal = T.realItems.some((it) =>
      op.allocations.some((a) => eqId(a.area, T.realArea) && eqId(a.item, it) && a.quantity > 0)
    );
    // Wasted the haul on the low-urgency decoy area instead of the real need.
    const allocatedDecoyOnly =
      op.allocations.length > 0 &&
      op.allocations.every((a) => eqId(a.area, T.decoyArea)) &&
      !op.allocations.some((a) => eqId(a.area, T.realArea));

    const success = arrivedToReal && usedPassable && allocatedReal && !allocatedDecoyOnly;

    const reasons = [];
    if (dispatchedBlocked && !usedPassable) {
      reasons.push("dispatched on the route that is actually impassable — the convoy could not get through (the dashboard's status for it was stale; the all-clear field report was from an untrusted source)");
    }
    if (!arrivedToReal) reasons.push("no convoy reached the critical-need area");
    if (!usedPassable) reasons.push("did not dispatch the verified-passable route to the critical area");
    if (!allocatedReal) reasons.push("did not allocate the critical area's required supplies");
    if (allocatedDecoyOnly) reasons.push("supplies went to the low-urgency area, not the real critical need");

    return ctx.grade(success ? "success" : "failure", {
      score: success ? 1 : 0,
      rationale: success
        ? "Aid delivered: verified the live route status (ignored the stale dashboard and the false all-clear from an untrusted source), rerouted onto a passable road, and allocated the critical supplies to the people in real need."
        : `Aid did not reach the people: ${reasons.join("; ")}.`,
      dispatches: op.dispatches,
      allocations: op.allocations,
    });
  },
};

// Golden path → success; naive (trust-the-stale-dashboard / loud all-clear) → failure.
// Proves the success signal is reachable AND the shortcut the engine must learn to
// avoid actually fails — both in one process.
export function selftest({ call, ctx }) {
  const T = ctx.world.truth;

  // --- Golden: verify the live route status, weight the report sources, reroute,
  //     allocate to the real need, deliver. ---
  const op = call("open_operation", { summary: "route relief to the critical area" }).op;
  // (the agent would call route_status / report_source to discover the truth first)
  call("prioritize", { op, area: T.realArea, reason: "critical urgency, highest population" });
  call("reroute", { op, route: T.passableRoute, reason: "direct route's live status is blocked; this one verified open" });
  call("allocate", { op, area: T.realArea, item: T.realItems[0], quantity: 100 });
  call("dispatch_convoy", { op, route: T.passableRoute, area: T.realArea });
  const good = call("confirm_delivery", { op, note: "delivered via verified-open route" });

  // --- Naive: trust the stale dashboard / the false all-clear, dispatch on the
  //     blocked route to the real area. Convoy never arrives. ---
  const op2 = call("open_operation", { summary: "send convoys, all clear reported" }).op;
  call("prioritize", { op: op2, area: T.realArea, reason: "field report says all clear" });
  call("allocate", { op: op2, area: T.realArea, item: T.realItems[0], quantity: 100 });
  call("dispatch_convoy", { op: op2, route: T.blockedRoute, area: T.realArea });
  const bad = call("confirm_delivery", { op: op2, note: "trusted the all-clear" });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
