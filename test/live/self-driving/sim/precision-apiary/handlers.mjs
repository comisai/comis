// Precision-apiary simulator — one season in a bee yard.
//
// The agent must learn to (a) INSPECT and find the ONE diseased hive (high varroa /
// spotty brood) and TREAT it in time, (b) ADAPT placement to the forage that is
// actually blooming THIS year — last season's reliable bloom has VANISHED (plowed
// under), so following the old record book places hives at a dead field, and (c)
// HARVEST in the window the live forage's flow actually peaks, which is later/earlier
// than last year. None of that is in the SKILL.md — it is the learned strategy.
//
// The naive shortcut the engine must learn to avoid: "do what worked last season"
// (place at the vanished forage, skip treatment, harvest at the old week) → colony
// loss + poor harvest → failure.

import { matches } from "../shared/world.mjs";

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const diseasedHive = v.diseasedHive;
  const vanishedForage = v.vanishedForage;
  const liveForage = v.liveForage;
  const harvestWindow = v.harvestWindow;
  const lastSeasonHarvestWeek = v.lastSeasonHarvestWeek;

  const t = seedWorld.truth;
  const varroaThreshold = t.varroaThreshold;
  const treatByWeek = t.treatByWeek;

  // Live, observable per-hive state. The diseased hive looks plausible in the summary
  // (it is the strongest by box count) — only an inspection + a pest sample reveals
  // the spotty brood and the high mite load.
  const hives = seedWorld.hives.map((h) => {
    const diseased = h.id === diseasedHive;
    return {
      id: h.id,
      boxes: h.boxes,
      queenAgeYears: h.queenAgeYears,
      diseased,
      // Field-summary signs (visible in get_hives) are deliberately NON-diagnostic:
      // population still looks ok early; you must inspect to see the brood pattern.
      population: diseased ? "strong (busy at entrance)" : "moderate",
      broodPattern: diseased ? "spotty / shotgun (gaps in capped brood)" : "solid / wall-to-wall",
      // Latent mite load — only surfaced by pest_pressure AFTER an inspection samples it.
      varroaLoad: diseased ? 6.5 : 1.2,
    };
  });

  // The live forage map: the vanished source is shown but explicitly NOT blooming, so
  // the gone-field is discoverable; the live source is blooming strong.
  const forageSites = seedWorld.forageSites.map((s) => {
    if (s.id === vanishedForage) {
      return { ...s, blooming: false, nectarQuality: "none", bloomStatus: "gone — field not in bloom this year" };
    }
    if (s.id === liveForage) {
      return { ...s, blooming: true, nectarQuality: "high", bloomStatus: "in full bloom (this season's main flow)" };
    }
    // Other sites bloom weakly — real but not the main flow (decoy "fine" options).
    return { ...s, blooming: true, nectarQuality: "low", bloomStatus: "light bloom, minor nectar" };
  });

  // Honey-flow curve by week, peaking in the live-forage window. Read the curve to find
  // the window; no date is named.
  const seasonWeeks = seedWorld.seasonWeeks;
  const flowCurve = [];
  for (let wk = 1; wk <= seasonWeeks; wk++) {
    const dist = Math.abs(wk - harvestWindow.peak);
    // triangular peak around the window center
    const flow = Math.max(0, 100 - dist * 22);
    flowCurve.push({ week: wk, relativeFlow: flow });
  }

  const weatherByWeek = [];
  for (let wk = 1; wk <= seasonWeeks; wk++) {
    weatherByWeek.push({
      week: wk,
      tempC: 12 + Math.round(14 * Math.max(0, 1 - Math.abs(wk - 10) / 12)),
      rain: wk % 5 === 0 ? "wet" : "dry",
    });
  }

  return {
    ...seedWorld,
    diseasedHive,
    vanishedForage,
    liveForage,
    harvestWindow,
    lastSeasonHarvestWeek,
    varroaThreshold,
    treatByWeek,
    hives,
    forageSites,
    flowCurve,
    weatherByWeek,
  };
}

// One season per process. Lazily created so observe-only / list calls don't need it.
function season(ctx) {
  if (!ctx.cases.has("season")) {
    ctx.cases.set("season", {
      inspections: [], // { hive, week }
      sampledHives: new Set(), // hives with a fresh pest sample
      treatments: [], // { hive, week, reason }
      placements: [], // { hive, location }
      harvests: [], // { hive, week }
      closed: false,
    });
    ctx.lastCase = "season";
  }
  return ctx.cases.get("season");
}

const findHive = (ctx, id) =>
  ctx.world.hives.find((h) => String(h.id).toLowerCase() === String(id).toLowerCase());

export const handlers = {
  get_hives(_args, ctx) {
    return {
      season: { weeks: ctx.world.seasonWeeks },
      hives: ctx.world.hives.map((h) => ({
        id: h.id,
        boxes: h.boxes,
        queenAgeYears: h.queenAgeYears,
        population: h.population,
        note: "Summary only — open a hive (inspect_hive) to see the brood pattern and health.",
      })),
    };
  },

  inspect_hive(args, ctx) {
    const h = findHive(ctx, args.hive);
    if (!h) return { hive: args.hive, unknown: true, note: "no such hive — see get_hives" };
    const s = season(ctx);
    // An inspection also pulls a mite-wash sample, so pest_pressure can now report it.
    s.sampledHives.add(h.id);
    if (!s.inspections.some((i) => i.hive === h.id)) s.inspections.push({ hive: h.id, week: args.week ?? null });
    return {
      hive: h.id,
      boxes: h.boxes,
      queenAgeYears: h.queenAgeYears,
      population: h.population,
      broodPattern: h.broodPattern,
      note: "A spotty/shotgun brood pattern can mean disease or a failing queen — corroborate with a mite sample (pest_pressure).",
    };
  },

  pest_pressure(args, ctx) {
    const h = findHive(ctx, args.hive);
    if (!h) return { hive: args.hive, unknown: true };
    const s = season(ctx);
    if (!s.sampledHives.has(h.id)) {
      return {
        hive: h.id,
        sample: "no fresh sample — schedule_inspection or inspect_hive first to pull a mite wash",
        varroaPer100: null,
      };
    }
    return {
      hive: h.id,
      varroaPer100: h.varroaLoad,
      threshold: ctx.world.varroaThreshold,
      unit: "mites per 100 bees",
      note: `Treatment threshold is ${ctx.world.varroaThreshold}/100. Above it the colony will likely crash before harvest if untreated.`,
    };
  },

  forage_map(args, ctx) {
    const f = args.filter || "";
    const sites = ctx.world.forageSites.filter(
      (s) => matches(s.id, f) || matches(s.kind, f) || matches(s.note, f) || matches(s.bloomStatus, f)
    );
    return {
      note: "This is THIS season's live bloom. Place hives where nectar is actually flowing now.",
      sites: sites.map((s) => ({
        id: s.id,
        kind: s.kind,
        note: s.note,
        blooming: s.blooming,
        nectarQuality: s.nectarQuality,
        bloomStatus: s.bloomStatus,
      })),
    };
  },

  weather_season(_args, ctx) {
    return { weeks: ctx.world.weatherByWeek };
  },

  harvest_forecast(_args, ctx) {
    return {
      note: "Relative nectar income by week (0-100). The flow peaks where the curve peaks — harvest near the peak.",
      curve: ctx.world.flowCurve,
    };
  },

  schedule_inspection(args, ctx) {
    const h = findHive(ctx, args.hive);
    if (!h) return { scheduled: false, reason: "no such hive", hive: args.hive };
    const s = season(ctx);
    const week = args.week ?? null;
    s.inspections.push({ hive: h.id, week });
    s.sampledHives.add(h.id); // a scheduled inspection produces a sample
    return { scheduled: true, hive: h.id, week, note: "A pest sample is now available — call pest_pressure." };
  },

  treat(args, ctx) {
    const h = findHive(ctx, args.hive);
    if (!h) return { treated: false, reason: "no such hive", hive: args.hive };
    const s = season(ctx);
    const week = args.week ?? null;
    s.treatments.push({ hive: h.id, week, reason: args.reason || "" });
    // Honest, NON-leaking feedback: treating a healthy colony is mild stress, not free.
    const stressedHealthy = !h.diseased;
    return {
      treated: h.id,
      week,
      effect: stressedHealthy
        ? "applied — note: treating a colony with low mite load adds handling stress for little benefit"
        : "applied",
    };
  },

  place_hive(args, ctx) {
    const h = findHive(ctx, args.hive);
    if (!h) return { placed: false, reason: "no such hive", hive: args.hive };
    const site = ctx.world.forageSites.find(
      (x) => String(x.id).toLowerCase() === String(args.location).toLowerCase()
    );
    const s = season(ctx);
    s.placements.push({ hive: h.id, location: site ? site.id : String(args.location) });
    if (!site) return { placed: h.id, location: String(args.location), note: "unknown location — see forage_map" };
    return {
      placed: h.id,
      location: site.id,
      // Honest field feedback WITHOUT naming the truth: report the bloom they can also
      // read on the map, so a wrong placement is observable but not pre-judged "wrong".
      forageThere: site.blooming
        ? `bees foraging — ${site.bloomStatus}`
        : `bees returning empty — ${site.bloomStatus}`,
    };
  },

  harvest(args, ctx) {
    const h = findHive(ctx, args.hive);
    if (!h) return { harvested: false, reason: "no such hive", hive: args.hive };
    const s = season(ctx);
    const week = args.week;
    s.harvests.push({ hive: h.id, week });
    const w = ctx.world.harvestWindow;
    const inWindow = typeof week === "number" && week >= w.open && week <= w.close;
    // Yield reflects the live flow curve at that week (observable via harvest_forecast).
    const point = ctx.world.flowCurve.find((p) => p.week === week);
    const relFlow = point ? point.relativeFlow : 0;
    return {
      harvested: h.id,
      week,
      relativeYield: relFlow,
      note: inWindow
        ? "supers were heavy"
        : "supers were light for the week — flow was off its peak",
    };
  },

  close_season(args, ctx) {
    const s = season(ctx);
    if (s.closed) return ctx.grade("failure", { score: 0, rationale: "season already closed" });
    s.closed = true;

    const W = ctx.world;
    const diseased = W.diseasedHive;
    const treatByWeek = W.treatByWeek;
    const vanished = W.vanishedForage;
    const live = W.liveForage;
    const win = W.harvestWindow;

    // (a) Treated the diseased hive in time (on/before treatByWeek; null week = unknown timing → too late).
    const treatedInTime = s.treatments.some(
      (t) => t.hive === diseased && typeof t.week === "number" && t.week <= treatByWeek
    );
    const treatedDiseasedAtAll = s.treatments.some((t) => t.hive === diseased);

    // (b) Placed a hive at the LIVE forage and did NOT place any hive at the vanished one.
    const placedAtLive = s.placements.some((p) => p.location === live);
    const placedAtVanished = s.placements.some((p) => p.location === vanished);

    // (c) Harvested at least one hive inside the window; harvesting outside it counts as a miss.
    const harvestedInWindow = s.harvests.some(
      (hv) => typeof hv.week === "number" && hv.week >= win.open && hv.week <= win.close
    );
    const harvestedOutsideWindowOnly =
      s.harvests.length > 0 && !harvestedInWindow;

    const correct = treatedInTime && placedAtLive && !placedAtVanished && harvestedInWindow;

    const reasons = [];
    if (!treatedInTime) {
      reasons.push(
        treatedDiseasedAtAll
          ? "treated the sick hive too late — it had already crashed"
          : "never treated the diseased hive — the colony was lost to mites/disease before harvest"
      );
    }
    if (!placedAtLive) reasons.push("did not place hives at the forage that was actually blooming this season");
    if (placedAtVanished) reasons.push("placed a hive at last year's bloom, which is gone this year — bees came back empty");
    if (!harvestedInWindow) {
      reasons.push(
        harvestedOutsideWindowOnly
          ? "harvested off the flow's peak — light supers and a thin yield"
          : "did not harvest in the window the live flow peaked"
      );
    }

    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Healthy season: caught and treated the sick hive in time, placed hives on the live bloom, and harvested at the flow's peak."
        : `Poor season: ${reasons.join("; ")}.`,
      treatments: s.treatments,
      placements: s.placements,
      harvests: s.harvests,
    });
  },
};

// Golden path → success; "do what worked last season" naive path → failure. Proves the
// success signal is reachable and that the shortcut the engine must learn to avoid fails.
export function selftest({ call, ctx }) {
  const W = ctx.world;
  const diseased = W.diseasedHive;
  const live = W.liveForage;
  const vanished = W.vanishedForage;
  const treatByWeek = W.treatByWeek;
  const peak = W.harvestWindow.peak;
  const healthy = (ctx.world.truth.healthyHives || []).filter((h) => h !== diseased);

  // --- GOLDEN: inspect → detect disease → treat in time → place on live forage → harvest at peak.
  call("get_hives", {});
  call("forage_map", {});
  call("inspect_hive", { hive: diseased });
  const sample = call("pest_pressure", { hive: diseased });
  // (sample reveals varroa over threshold — strategy, discovered not told)
  call("treat", { hive: diseased, week: treatByWeek - 1, reason: "varroa over threshold" });
  call("place_hive", { hive: diseased, location: live });
  if (healthy[0]) call("place_hive", { hive: healthy[0], location: live });
  call("harvest_forecast", {});
  call("harvest", { hive: diseased, week: peak });
  if (healthy[0]) call("harvest", { hive: healthy[0], week: peak });
  const good = call("close_season", { notes: "treated sick hive, placed on live bloom, harvested at peak" });

  // --- NAIVE: follow last season's record book.
  // Fresh process state isn't available here (one season per process), so model the
  // naive plan in a SECOND season store keyed off a fresh ctx.cases entry.
  ctx.cases.delete("season");
  ctx.lastCase = null;
  call("place_hive", { hive: diseased, location: vanished }); // last year's bloom — now gone
  if (healthy[0]) call("place_hive", { hive: healthy[0], location: vanished });
  // skip inspection + treatment entirely (looked fine last year)
  call("harvest", { hive: diseased, week: W.lastSeasonHarvestWeek }); // last year's week
  const bad = call("close_season", { notes: "did what worked last season" });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return {
    pass,
    golden: good.outcome,
    naive: bad.outcome,
    detail: pass
      ? { sampleVarroa: sample.varroaPer100, threshold: sample.threshold }
      : { good, bad },
  };
}
