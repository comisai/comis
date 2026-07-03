// wildland-fire incident-command simulator.
// The agent is planning chief on a fire. The world exposes CONDITIONS only (weather,
// fuels, terrain, spread, resources, map). The agent must LEARN to:
//   (a) read the conditions and infer the fire TYPE (wind-driven crown vs slow grass),
//   (b) set the tactic that MATCHES that type (crown → indirect attack, anchor a wide
//       containment line off the alignment, pull crews back; grass → direct attack),
//   (c) keep every assigned resource OUT of the blow-up / danger zone, and
//   (d) order an evacuation for any community/structures in the fire's path,
//   (e) without grossly over-committing resources.
// None of the fire-type → tactic mapping, the danger zone, or the evac zone is in the
// SKILL.md. That mapping is the learned strategy; the hidden truth lives only here +
// world.seed.json.

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  // The live world is just the active variant's surface facts + its hidden truth.
  return {
    scenario: seedWorld.scenario,
    variant,
    label: v.label,
    weather: v.weather,
    fuels: v.fuels,
    spread: v.spread,
    zones: v.zones,
    resources: v.resources,
    truth: v.truth,
  };
}

const getIncident = (ctx, id) => ctx.cases.get(id || ctx.lastCase);
const zoneById = (ctx, id) => ctx.world.zones.find((z) => String(z.id).toLowerCase() === String(id).toLowerCase());
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

// A ground resource is anything that puts firefighters on the line (not aircraft).
const GROUND_TYPES = new Set(["hand-crew", "engine", "dozer"]);
function resourceType(ctx, id) {
  const r = ctx.world.resources.find((x) => String(x.id).toLowerCase() === String(id).toLowerCase());
  return r ? r.type : "unknown";
}

export const handlers = {
  // ---- observe (read-only) -------------------------------------------------
  get_weather(_args, ctx) {
    return { variant: ctx.world.variant, ...ctx.world.weather };
  },
  fuel_moisture(_args, ctx) {
    return { ...ctx.world.fuels };
  },
  terrain(args, ctx) {
    if (args.zone) {
      const z = zoneById(ctx, args.zone);
      return z ? { zone: z.id, role: z.role, terrain: z.terrain } : { zone: args.zone, unknown: true };
    }
    return { zones: ctx.world.zones.map((z) => ({ zone: z.id, role: z.role, terrain: z.terrain })) };
  },
  spread_forecast(_args, ctx) {
    return { ...ctx.world.spread };
  },
  resource_status(_args, ctx) {
    return { resources: ctx.world.resources };
  },
  get_incident_map(_args, ctx) {
    return { zones: ctx.world.zones.map((z) => ({ zone: z.id, role: z.role })) };
  },

  // ---- act -----------------------------------------------------------------
  open_incident(args, ctx) {
    const id = `INC-${++ctx.caseCounter}`;
    ctx.cases.set(id, {
      summary: args.summary || "",
      tactic: null,
      containmentLine: null,
      assignments: [], // { resource, type, zone, task }
      air: [], // { aircraft, zone }
      evacs: [], // { zone, level }
    });
    ctx.lastCase = id;
    return { incident: id, opened: true };
  },

  set_tactic(args, ctx) {
    const c = getIncident(ctx, args.incident);
    if (!c) return { error: "no open incident — call open_incident first" };
    c.tactic = norm(args.tactic);
    c.containmentLine = args.containment_line || null;
    return { tactic: c.tactic, containment_line: c.containmentLine, recorded: true };
  },

  assign_crew(args, ctx) {
    const c = getIncident(ctx, args.incident);
    if (!c) return { error: "no open incident — call open_incident first" };
    const zone = String(args.zone);
    const type = resourceType(ctx, args.resource);
    const inDanger = ctx.world.truth.dangerZones.map(norm).includes(norm(zone));
    const z = zoneById(ctx, zone);

    // REFUSE to commit a GROUND resource into a blow-up / danger zone — a real ops chief
    // would never send crews there, so the assignment is REJECTED (not silently recorded).
    // This lets the agent learn the safety posture WITHOUT an irreversible bad commit.
    // Without this refusal, probing an unsafe zone with a ground crew would record it
    // permanently and sink the grade even after reassigning to a safe zone.
    if (inDanger && GROUND_TYPES.has(type)) {
      return {
        assigned: false,
        refused: true,
        resource: args.resource,
        zone,
        zoneRole: z ? z.role : "unknown zone",
        safety:
          "UNSAFE — this zone aligns with the wind/slope and lies in the head's path; flame length and spotting exceed safe direct engagement, with no good safety zone / escape route. The assignment was REFUSED. Keep ground crews out; use aircraft here.",
      };
    }

    c.assignments.push({ resource: args.resource, type, zone, task: args.task || "" });
    let posture = "within normal engagement parameters";
    if (inDanger) posture = "high-intensity zone — acceptable for aircraft, not for ground crews on the line";
    return {
      assigned: { resource: args.resource, type, zone, task: args.task || "" },
      zoneRole: z ? z.role : "unknown zone",
      safety: posture,
    };
  },

  order_air(args, ctx) {
    const c = getIncident(ctx, args.incident);
    if (!c) return { error: "no open incident — call open_incident first" };
    c.air.push({ aircraft: args.aircraft || "air", zone: String(args.zone) });
    return { ordered: { aircraft: args.aircraft || "air", zone: String(args.zone) } };
  },

  issue_evac(args, ctx) {
    const c = getIncident(ctx, args.incident);
    if (!c) return { error: "no open incident — call open_incident first" };
    const zone = String(args.zone);
    c.evacs.push({ zone, level: args.level || "order" });
    const z = zoneById(ctx, zone);
    return { evacuation: { zone, level: args.level || "order" }, zoneRole: z ? z.role : "unknown zone" };
  },

  // ---- terminal (graded) ---------------------------------------------------
  declare_contained(args, ctx) {
    const c = getIncident(ctx, args.incident);
    if (!c) return ctx.grade("failure", { score: 0, rationale: "declared contained with no open incident" });
    const T = ctx.world.truth;

    // 1) Tactic must match the (hidden) fire type.
    const tacticMatched = c.tactic === norm(T.correctTactic);

    // 2) No GROUND resource may be assigned into a blow-up / danger zone.
    const danger = new Set(T.dangerZones.map(norm));
    const endangered = c.assignments.filter((a) => GROUND_TYPES.has(a.type) && danger.has(norm(a.zone)));
    const crewsSafe = endangered.length === 0;

    // 3) Evac issued for every zone that requires one.
    const evacuated = new Set(c.evacs.map((e) => norm(e.zone)));
    const missingEvacs = T.evacRequiredZones.map(norm).filter((z) => !evacuated.has(z));
    const evacOk = missingEvacs.length === 0;

    // 4) At least one ground resource actually committed to a safe working zone
    //    (you have to fight the fire, not just declare it out).
    const safe = new Set(T.safeWorkZones.map(norm));
    const committedSafely = c.assignments.some((a) => GROUND_TYPES.has(a.type) && safe.has(norm(a.zone)));

    // 5) Resource use reasonable — don't grossly over-commit. Cap ground assignments at
    //    the number of available ground resources (no double-tasking waste / pyramiding).
    const groundResourceCount = ctx.world.resources.filter((r) => GROUND_TYPES.has(r.type)).length;
    const groundAssignments = c.assignments.filter((a) => GROUND_TYPES.has(a.type)).length;
    const resourceReasonable = groundAssignments <= groundResourceCount + 1;

    const correct = tacticMatched && crewsSafe && evacOk && committedSafely && resourceReasonable;

    const reasons = [];
    if (!c.tactic) reasons.push("no tactic was ever set");
    else if (!tacticMatched)
      reasons.push(
        `tactic '${c.tactic}' does not match the conditions on this fire — the fire behavior/fuels/weather called for a different approach, so the line did not hold`
      );
    if (!crewsSafe)
      reasons.push(
        `ground resources were committed into a blow-up zone (${endangered.map((a) => `${a.resource}→${a.zone}`).join(", ")}) — crews endangered`
      );
    if (!evacOk) reasons.push(`evacuation never ordered for at-risk zone(s) ${missingEvacs.join(", ")}`);
    if (!committedSafely) reasons.push("no ground resource was committed to a safe working zone — the fire was not actually engaged");
    if (!resourceReasonable) reasons.push(`grossly over-committed ground resources (${groundAssignments} assignments for ${groundResourceCount} resources)`);

    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Read the conditions, set the tactic that matched the fire, kept all crews out of the blow-up zone, evacuated the values-at-risk, and contained with reasonable resources."
        : `Not contained: ${reasons.join("; ")}.`,
      tactic: c.tactic,
      assignments: c.assignments,
      evacs: c.evacs,
    });
  },
};

// REQUIRED self-test: a golden path → success, a naive path → failure, in one process.
// Naive chief = the must-fail shortcut: hits the fire with a direct/grass tactic and
// pushes a crew straight at the head — which is a blow-up zone on a crown fire.
export function selftest({ call, ctx }) {
  const T = ctx.world.truth;

  // --- golden: read conditions, set the matching tactic, keep crews out of the danger
  //     zone, evac the values-at-risk, commit safely, contain. ---
  const inc = call("open_incident", { summary: "size-up complete" }).incident;
  call("set_tactic", { incident: inc, tactic: T.correctTactic, containment_line: T.containmentAnchor });
  call("assign_crew", { incident: inc, resource: "C1", zone: T.safeWorkZones[0], task: "build line on the anchor" });
  for (const z of T.expectedAirZones) call("order_air", { incident: inc, aircraft: "T1", zone: z });
  for (const z of T.evacRequiredZones) call("issue_evac", { incident: inc, zone: z, level: "order" });
  const good = call("declare_contained", { incident: inc, note: "line held" });

  // --- naive: wrong tactic + push a ground crew at the head (the blow-up zone on a
  //     crown fire). On the grass variant the danger set is empty, so to keep the naive
  //     path a guaranteed failure we ALSO use the wrong tactic — which fails on its own. ---
  const inc2 = call("open_incident", { summary: "naive aggressive direct attack" }).incident;
  call("set_tactic", { incident: inc2, tactic: T.wrongTactic, containment_line: "right at the head" });
  const headZone = (T.dangerZones && T.dangerZones[0]) || T.safeWorkZones[0];
  call("assign_crew", { incident: inc2, resource: "C1", zone: headZone, task: "hit the head directly" });
  const bad = call("declare_contained", { incident: inc2, note: "going direct" });

  // --- Regression guard: an UNSAFE ground probe is refused (not recorded), so an
  //     otherwise-correct plan still SUCCEEDS after probing the danger zone. ---
  const inc3 = call("open_incident", { summary: "probe then commit safely" }).incident;
  call("set_tactic", { incident: inc3, tactic: T.correctTactic, containment_line: T.containmentAnchor });
  const dz = (T.dangerZones && T.dangerZones[0]) || null;
  let probeRefused = true;
  if (dz) {
    const probe = call("assign_crew", { incident: inc3, resource: "C1", zone: dz, task: "probe" });
    probeRefused = probe.refused === true && !probe.assigned;
  }
  call("assign_crew", { incident: inc3, resource: "C1", zone: T.safeWorkZones[0], task: "build line on the anchor" });
  for (const z of T.expectedAirZones) call("order_air", { incident: inc3, aircraft: "T1", zone: z });
  for (const z of T.evacRequiredZones) call("issue_evac", { incident: inc3, zone: z, level: "order" });
  const probed = call("declare_contained", { incident: inc3, note: "line held after probe" });

  const pass =
    good.outcome === "success" && bad.outcome === "failure" && probeRefused && probed.outcome === "success";
  return { pass, golden: good.outcome, naive: bad.outcome, probeRefused, afterProbe: probed.outcome, detail: pass ? "ok" : { good, bad, probed } };
}
