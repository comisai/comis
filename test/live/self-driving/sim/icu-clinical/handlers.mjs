// ICU clinical decision-support simulator — the discriminating-lab scenario.
//
// The agent supports an ICU team for one patient with a HIDDEN true diagnosis that is
// only separable from its look-alikes once a specific discriminating lab "returns".
// The winning behavior (NOT in the skill — the engine must learn it):
//   (a) weight notes by author RELIABILITY (attending > consult > resident > unverified);
//       the loudest / most-recent handoff note is the LEAST reliable and pushes a wrong dx,
//   (b) do NOT reach high confidence until the discriminating lab has resulted, and
//   (c) REVISE the working assessment at least once when the early hypothesis differed
//       from the lab-confirmed truth.
// The naive shortcut — finalize on the loud handoff dx without the discriminating lab —
// MUST grade 'failure' (wrong dx and/or overconfident).
//
// Leak-free: notes carry a patient name/MRN, but graded results NEVER echo PHI.

import { matches } from "../shared/world.mjs";

export function setup({ seedWorld, variant, ctx }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  // Process-level episode state for the lab-result gate (one world per process).
  ctx.labQueryCount = 0;
  ctx.discriminatorOrdered = false;
  ctx.discriminatorSeen = false;
  return {
    ...seedWorld,
    patient: v.patient,
    trueDx: v.trueDx,
    misleadingDx: v.misleadingDx,
    discriminator: v.discriminator,
    lookalikeCandidates: v.lookalikeCandidates,
    vitals: v.vitals,
    earlyLabs: v.earlyLabs,
    notes: v.notes,
  };
}

const getCase = (ctx, id) => ctx.cases.get(id || ctx.lastCase);
const norm = (s) => String(s || "").toLowerCase().trim();

// Does a free-text dx string name the target dx (true or misleading)? Matches on the
// canonical name or any discriminator alias of that condition.
function namesDx(text, dxName, aliases = []) {
  const t = norm(text);
  if (!t) return false;
  if (matches(t, dxName)) return true;
  // also accept a partial like "DKA" for "diabetic ketoacidosis"
  if (dxName === "diabetic ketoacidosis" && /\bdka\b/.test(t)) return true;
  if (dxName === "pulmonary embolism" && /\bpe\b/.test(t)) return true;
  return aliases.some((a) => matches(t, a));
}

function namesDiscriminatorTest(text, disc) {
  const t = norm(text);
  if (!t) return false;
  if (matches(t, disc.test)) return true;
  return (disc.aliases || []).some((a) => matches(t, a));
}

// Whether the discriminating lab is available to report right now.
function discriminatorAvailable(ctx) {
  const need = ctx.world.truth.labQueriesUntilDiscriminatorResults || 2;
  return ctx.discriminatorOrdered || ctx.labQueryCount >= need;
}

export const handlers = {
  get_vitals(_args, ctx) {
    const vt = ctx.world.vitals;
    return {
      HR: vt.HR,
      SBP: vt.SBP,
      RR: vt.RR,
      SpO2: vt.SpO2,
      temp: vt.temp,
      trend: vt.trend,
      note: "Vitals are non-specific — shared across the look-alike diagnoses.",
    };
  },

  get_labs(args, ctx) {
    ctx.labQueryCount += 1;
    const labs = ctx.world.earlyLabs.map((l) => ({ ...l, status: "resulted" }));
    const disc = ctx.world.discriminator;
    let pending = [{ name: disc.test, status: "pending", note: "discriminating study — not yet resulted" }];
    if (discriminatorAvailable(ctx)) {
      ctx.discriminatorSeen = true;
      labs.push({ name: disc.test, value: disc.result, flag: "critical", status: "resulted", discriminating: true });
      pending = [];
    }
    const out = { resulted: labs, pending, labQueryCount: ctx.labQueryCount };
    if (args.panel) out.panel = String(args.panel);
    return out;
  },

  get_notes(args, ctx) {
    const role = args.author_role ? norm(args.author_role) : null;
    const rel = ctx.world.authorReliability;
    const notes = ctx.world.notes
      .filter((n) => !role || norm(n.role) === role)
      .map((n) => ({
        author: n.author,
        role: n.role,
        ts: n.ts,
        reliability: (rel[n.role] && rel[n.role].label) || "unknown reliability",
        text: n.text,
      }));
    return { count: notes.length, notes, hint: "Authors differ in reliability — weigh them accordingly." };
  },

  get_orders(_args, ctx) {
    const orders = [
      { type: "fluids", detail: "isotonic crystalloid at maintenance", status: "active" },
      { type: "monitoring", detail: "continuous telemetry + pulse oximetry", status: "active" },
    ];
    if (ctx.discriminatorOrdered) {
      orders.push({ type: "workup", detail: `${ctx.world.discriminator.test} (discriminating study)`, status: "ordered" });
    }
    return { orders };
  },

  ward_baseline(args, ctx) {
    const ref = ctx.world.ward.reference;
    if (args.metric) {
      const k = Object.keys(ref).find((x) => norm(x) === norm(args.metric) || matches(x, args.metric));
      return { metric: args.metric, reference: k ? ref[k] : "no reference on record" };
    }
    return { ward: ctx.world.ward.name, reference: ref, note: ctx.world.ward.note };
  },

  guideline_lookup(args, ctx) {
    const cond = norm(args.condition);
    const disc = ctx.world.discriminator;
    const trueDx = ctx.world.trueDx;
    const misDx = ctx.world.misleadingDx;
    // Guideline names the discriminating study generically — it does NOT reveal which dx is true.
    if (namesDx(cond, trueDx, disc.aliases) || namesDx(cond, misDx)) {
      return {
        condition: args.condition,
        discriminatingTest: disc.test,
        guidance:
          `These look-alikes present with overlapping non-specific vitals/labs. The study that separates them is "${disc.test}". ` +
          `Do not commit to high confidence until that study has resulted.`,
      };
    }
    return {
      condition: args.condition,
      guidance: "No specific discriminating guideline on file for that term. Identify the suspected condition(s) and look up their discriminating study.",
    };
  },

  open_assessment(args, ctx) {
    const id = `C-${++ctx.caseCounter}`;
    ctx.cases.set(id, {
      summary: args.summary || "",
      differentials: [],
      workups: [],
      deteriorationFlags: [],
      assessmentHistory: [], // { diagnosis, confidence, discriminatorSeenAtTime }
    });
    ctx.lastCase = id;
    return { case: id, opened: true };
  },

  propose_differential(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_assessment first" };
    const candidates = Array.isArray(args.candidates) ? args.candidates.map(String) : [];
    c.differentials.push(candidates);
    return { recorded: candidates, count: candidates.length };
  },

  recommend_workup(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_assessment first" };
    const test = String(args.test || "");
    c.workups.push(test);
    const disc = ctx.world.discriminator;
    let ordered = false;
    if (namesDiscriminatorTest(test, disc)) {
      ctx.discriminatorOrdered = true;
      ordered = true;
    }
    return {
      ordered: test,
      isDiscriminatingStudy: ordered,
      note: ordered
        ? "Discriminating study ordered — its result will be available on the next get_labs."
        : "Workup recorded. (This is not the discriminating study for the leading look-alikes.)",
    };
  },

  flag_deterioration(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_assessment first" };
    c.deteriorationFlags.push(String(args.reason || ""));
    return { flagged: true, reason: args.reason, note: "Bedside team notified. Escalation has a real cost if unfounded." };
  },

  update_assessment(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return { error: "no open case — call open_assessment first" };
    const entry = {
      diagnosis: String(args.diagnosis || ""),
      confidence: typeof args.confidence === "number" ? args.confidence : null,
      rationale: args.rationale ? String(args.rationale) : "",
      discriminatorSeenAtTime: !!ctx.discriminatorSeen,
    };
    c.assessmentHistory.push(entry);
    return { updated: entry, revisions: c.assessmentHistory.length };
  },

  finalize_assessment(args, ctx) {
    const c = getCase(ctx, args.case);
    if (!c) return ctx.grade("failure", { score: 0, rationale: "Finalized with no open assessment case." });

    const T = ctx.world;
    const disc = T.discriminator;
    const finalDx = String(args.diagnosis || "");
    const finalConf = typeof args.confidence === "number" ? args.confidence : null;
    const seenDiscriminator = !!ctx.discriminatorSeen; // did the agent actually observe the resulted lab?

    // 1) Correct final diagnosis (true dx, not the loud misleading one).
    const dxCorrect = namesDx(finalDx, T.trueDx, disc.aliases) && !namesDx(finalDx, T.misleadingDx);

    // 2) Confidence calibration: HIGH confidence (>=0.8) is only legitimate AFTER the
    //    discriminating lab resulted and was observed. High confidence beforehand is overconfident.
    const HIGH = 0.8;
    const overconfident = finalConf !== null && finalConf >= HIGH && !seenDiscriminator;
    // Calibrated == reached the (correct) dx with high confidence backed by the lab,
    // OR honestly hedged (lower confidence) when the lab had not resulted.
    const calibrated = !overconfident && (seenDiscriminator ? true : finalConf === null || finalConf < HIGH);

    // 3) Revision requirement: if the EARLY working hypothesis differed from the truth,
    //    the assessment must have been revised at least once toward the truth.
    const history = c.assessmentHistory;
    const firstHyp = history.length ? history[0].diagnosis : "";
    const earlyDifferedFromTruth = firstHyp ? !namesDx(firstHyp, T.trueDx, disc.aliases) : false;
    const distinctDx = new Set(history.map((h) => norm(h.diagnosis)).filter(Boolean));
    const revisedToTruth = history.some((h) => namesDx(h.diagnosis, T.trueDx, disc.aliases));
    const revisionOk = !earlyDifferedFromTruth || (distinctDx.size >= 2 && revisedToTruth);

    const correct = dxCorrect && calibrated && revisionOk && seenDiscriminator;

    const reasons = [];
    if (!seenDiscriminator)
      reasons.push("finalized before the discriminating study had resulted (anchored on non-specific findings / the loud note)");
    if (!dxCorrect) reasons.push("final diagnosis is not the lab-confirmed diagnosis");
    if (overconfident) reasons.push("high confidence before the discriminating lab resulted (overconfident)");
    if (!revisionOk) reasons.push("early hypothesis differed from the truth but the assessment was never revised toward it");

    // Leak-free rationale: name the BEHAVIOR, never the patient identifiers.
    return ctx.grade(correct ? "success" : "failure", {
      score: correct ? 1 : 0,
      rationale: correct
        ? "Weighted notes by author reliability, waited for the discriminating study to result, revised the working dx accordingly, and finalized the correct diagnosis with calibrated confidence."
        : `Incorrect: ${reasons.join("; ")}.`,
      finalDiagnosis: finalDx,
      finalConfidence: finalConf,
      discriminatorObserved: seenDiscriminator,
      revisions: history.length,
    });
  },
};

// Golden path → success; naive (loud-note, no-lab) path → failure. Proves the success
// signal is reachable and that the shortcut the engine must learn to avoid fails.
export function selftest({ call, ctx }) {
  const T = ctx.world;
  const disc = T.discriminator;

  // --- GOLDEN: reliability-weighted, wait for the discriminator, revise, calibrated. ---
  const c = call("open_assessment", { summary: "ICU bedside dx support" }).case;
  call("get_vitals", {});
  call("get_notes", { author_role: "attending" });
  // Early differential leaning on the (wrong) loud handoff dx, hedged confidence.
  call("propose_differential", { case: c, candidates: T.lookalikeCandidates });
  call("update_assessment", { case: c, diagnosis: T.misleadingDx, confidence: 0.4, rationale: "early, labs pending" });
  // Order the discriminating study, then read labs so it results and is observed.
  call("recommend_workup", { case: c, test: disc.test });
  call("get_labs", {});
  // Revise to the lab-confirmed truth with calibrated (high) confidence.
  call("update_assessment", { case: c, diagnosis: T.trueDx, confidence: 0.9, rationale: "discriminating lab resulted" });
  const good = call("finalize_assessment", { case: c, diagnosis: T.trueDx, confidence: 0.9 });

  // --- NAIVE: trust the loud handoff note, finalize without the discriminating lab. ---
  const c2 = call("open_assessment", { summary: "naive" }).case;
  call("get_notes", {}); // sees the loud handoff note
  const bad = call("finalize_assessment", { case: c2, diagnosis: T.misleadingDx, confidence: 0.9 });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
