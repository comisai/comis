// Adaptive 1:1 tutoring simulator — the self-supersession scenario.
//
// The student has a HIDDEN true misconception that differs from the OBVIOUS first guess
// the attempt history seems to show. The agent must (a) form a hypothesis, (b) TEST it by
// posing the discriminating problem (whose answer only the TRUE misconception predicts),
// (c) REVISE its hypothesis when that disproves the obvious guess, (d) remediate the true
// misconception, and (e) show transfer to a related topic. None of that is in SKILL.md —
// it is the learned "form -> test -> revise" strategy.
//
// LEAK-FREE: get_student exposes the student's name/grade (a minor), but the graded result
// and rationale NEVER echo those identifiers.

import { matches } from "../shared/world.mjs";

// Keyword signatures used to classify the agent's free-text hypothesis / hint against a
// misconception KEY. The agent writes prose; we map prose -> key by its salient terms.
const KEY_SIGNATURES = {
  "add-across": [["denominator", "denominators"], ["add", "adds", "adding", "straight", "across", "both", "top and bottom"]],
  "keep-denominator": [["denominator", "denominators"], ["keep", "kept", "keeps", "same", "unchanged", "common", "one"]],
  "no-carry": [["carry", "borrow", "regroup", "regrouping"]],
  "drop-whole": [["whole", "wholes", "integer", "ignore", "ignores", "drops", "drop", "discard"]],
  "multiply-instead": [["multiply", "multiplies", "multiplying", "times", "product"]],
  "invert-second": [["invert", "inverts", "inverting", "reciprocal", "flip", "flips", "divide", "division"]],
};

function anyMatch(text, words) {
  const t = String(text).toLowerCase();
  return words.some((w) => t.includes(w));
}

// Does the free text describe the given misconception KEY? (every clause group must hit)
function describesKey(text, key) {
  const sig = KEY_SIGNATURES[key];
  if (!sig) return false;
  return sig.every((group) => anyMatch(text, group));
}

// Classify a free-text hypothesis to the persona's true/obvious key (or null).
function classify(text, persona) {
  if (describesKey(text, persona.trueKey)) return persona.trueKey;
  if (describesKey(text, persona.obviousKey)) return persona.obviousKey;
  return null;
}

export function setup({ seedWorld, variant }) {
  const v = (seedWorld.variants && seedWorld.variants[variant]) || seedWorld.variants.A;
  const persona = seedWorld.personas[v.persona];
  const student = { id: v.studentId, name: v.studentName, grade: v.grade, topic: persona.topic, recentScore: 0.42 };
  // The attempt history shows the SURFACE SYMPTOM only: like-denominator problems are
  // right, unlike-denominator problems are wrong. It deliberately does NOT show the wrong
  // ANSWER the student gave on an unlike problem — that answer (which discriminates the
  // obvious guess from the true cause) only appears when the agent poses the problem live.
  // So the history nudges toward the obvious textbook misconception without confirming it.
  const history = [
    { problem: "1/3 + 1/3 = ?", studentAnswer: "2/3", correct: "2/3", verdict: "correct", note: "right when denominators already match" },
    { problem: "2/5 + 1/5 = ?", studentAnswer: "3/5", correct: "3/5", verdict: "correct", note: "right when denominators already match" },
    { problem: "1/2 + 1/4 = ?", studentAnswer: "(error — answer not captured by the worksheet)", correct: "3/4", verdict: "incorrect", note: "wrong whenever denominators differ; the recorded answer is missing — pose this kind of problem yourself to see WHAT they write" },
  ];
  return { ...seedWorld, variant: v, persona, student, history, topicMap: seedWorld.topicMap };
}

const getSession = (ctx, id) => ctx.cases.get(id || ctx.lastCase);

// Look up the student's answer to a problem prompt under the TRUE misconception.
function studentAnswerFor(persona, prompt) {
  const p = String(prompt);
  // exact match on a catalogued problem
  for (const key of Object.keys(persona.answers)) {
    if (p.includes(key.replace(" = ?", "")) || p.includes(key)) {
      return persona.answers[key][persona.trueKey];
    }
  }
  return null;
}

export const handlers = {
  get_student(_args, ctx) {
    const s = ctx.world.student;
    // Surfaces identifiers (minor) — the grader must never echo these.
    return { id: s.id, name: s.name, grade: s.grade, topic: s.topic, recentScore: s.recentScore };
  },

  attempt_history(args, ctx) {
    const topic = args.topic;
    const rows = ctx.world.history;
    return {
      topic: topic || ctx.world.student.topic,
      attempts: rows,
      note: "An obvious error pattern is visible here. Whether it is the FULL explanation is for you to test with a problem that discriminates between competing causes.",
    };
  },

  diagnostic(args, ctx) {
    const probe = String(args.probe || "").toLowerCase();
    const persona = ctx.world.persona;
    // A probe that targets unlike-denominators / the discriminating sub-skill reveals the
    // TRUE misconception. A generic probe only re-confirms the obvious surface error.
    const discriminates =
      matches(probe, "unlike") ||
      matches(probe, "different denominator") ||
      matches(probe, "discrimin") ||
      matches(probe, "compare") ||
      matches(probe, "whole") ||
      matches(probe, "invert") ||
      matches(probe, "operation") ||
      matches(probe, persona.trueKey);
    if (discriminates) {
      const dp = persona.discriminatingProblem;
      return {
        probe: args.probe || "(general)",
        discriminating: true,
        observation: `On "${dp}" the student answered "${persona.answers[dp][persona.trueKey]}".`,
        hint: "This answer is not what the obvious surface error would predict — revise your hypothesis to fit it.",
      };
    }
    return {
      probe: args.probe || "(general)",
      discriminating: false,
      observation: "Student again misses problems with unlike denominators; matches problems with like denominators.",
      hint: "This only re-confirms the surface symptom. Pose a problem that distinguishes competing causes.",
    };
  },

  curriculum(args, ctx) {
    const topic = args.topic || ctx.world.student.topic;
    const map = ctx.world.topicMap[topic] || ctx.world.topicMap["fraction-addition"];
    return { topic, prereqs: map.prereqs, related: map.related };
  },

  affect_signal(_args, ctx) {
    // Deterministic affect — colored by progress on the active session, not the diagnosis.
    const s = getSession(ctx);
    const remediated = s && s.remediationOk;
    return {
      confidence: remediated ? "rising" : "low",
      frustration: remediated ? "easing" : "elevated",
      engagement: "present",
      note: "Affect reflects how the session is going — it is not the misconception.",
    };
  },

  // open the (single) tutoring session implicitly on first act
  open_session(args, ctx) {
    const id = `T-${++ctx.caseCounter}`;
    ctx.cases.set(id, {
      hypothesis: null,
      hypothesisKey: null,
      revised: false,
      posed: [],
      observedTrueAnswer: false,
      remediationOk: false,
      transferOk: false,
      summary: args.summary || "",
    });
    ctx.lastCase = id;
    return { session: id, opened: true };
  },

  set_hypothesis(args, ctx) {
    let s = getSession(ctx, args.session);
    if (!s) {
      // auto-open a session so the agent needn't thread ids perfectly
      handlers.open_session({ summary: "tutoring" }, ctx);
      s = getSession(ctx);
    }
    const key = classify(args.misconception, ctx.world.persona);
    s.hypothesis = args.misconception;
    s.hypothesisKey = key;
    return {
      recorded: args.misconception,
      note: "Initial hypothesis recorded. Test it with a problem before you remediate — revise if the evidence disagrees.",
    };
  },

  pose_problem(args, ctx) {
    let s = getSession(ctx, args.session);
    if (!s) {
      handlers.open_session({ summary: "tutoring" }, ctx);
      s = getSession(ctx);
    }
    const persona = ctx.world.persona;
    const answer = studentAnswerFor(persona, args.prompt || "");
    const isDiscriminating =
      String(args.prompt || "").includes(persona.discriminatingProblem.replace(" = ?", "")) ||
      String(args.prompt || "").includes(persona.discriminatingProblem);
    s.posed.push({ prompt: args.prompt, answer });
    if (isDiscriminating && answer != null) {
      s.observedTrueAnswer = true;
    }
    if (answer == null) {
      return {
        prompt: args.prompt,
        studentAnswer: "(the student stalls — this isn't a problem from the current topic)",
        revealing: false,
        note: "Pick a fraction-addition problem with unlike denominators to see the error.",
      };
    }
    return {
      prompt: args.prompt,
      studentAnswer: answer,
      revealing: isDiscriminating,
      note: isDiscriminating
        ? "Note what the student actually wrote — it may not be the error you first assumed."
        : "An answer. Does it fit your current hypothesis, or does it point elsewhere?",
    };
  },

  revise_hypothesis(args, ctx) {
    let s = getSession(ctx, args.session);
    if (!s) {
      handlers.open_session({ summary: "tutoring" }, ctx);
      s = getSession(ctx);
    }
    const key = classify(args.misconception, ctx.world.persona);
    s.hypothesis = args.misconception;
    s.hypothesisKey = key;
    s.revised = true;
    return {
      revisedTo: args.misconception,
      because: args.because || null,
      note: "Current hypothesis updated. Remediate this, then check transfer to a related topic.",
    };
  },

  give_hint(args, ctx) {
    let s = getSession(ctx, args.session);
    if (!s) {
      handlers.open_session({ summary: "tutoring" }, ctx);
      s = getSession(ctx);
    }
    const persona = ctx.world.persona;
    // A hint counts as effective remediation only if it targets the TRUE misconception —
    // i.e. it describes the true error or names the right remediation concept.
    const text = `${args.hint || ""} ${args.targets || ""}`;
    const targetsTrue =
      describesKey(text, persona.trueKey) ||
      matches(text, persona.remediationKey.replace(/-/g, " ")) ||
      matches(text, persona.remediationKey);
    const targetsWrong = matches(text, persona.wrongRemediationKey.replace(/-/g, " "));
    if (targetsTrue && !targetsWrong) {
      s.remediationOk = true;
      return { delivered: args.hint, effective: true, note: "The student engages — this addresses the real error." };
    }
    return {
      delivered: args.hint,
      effective: false,
      note: "The student nods but still stumbles — this hint doesn't target the error they actually have.",
    };
  },

  assess_mastery(args, ctx) {
    const s = getSession(ctx, args.session);
    if (!s) return ctx.grade("failure", { score: 0, rationale: "No tutoring session was open to assess." });
    const persona = ctx.world.persona;

    const hypothesisIsTrue = s.hypothesisKey === persona.trueKey;
    const hypothesisIsObvious = s.hypothesisKey === persona.obviousKey;
    const revisedAway = s.revised && hypothesisIsTrue;
    const remediated = s.remediationOk;
    // Transfer: the agent must name the related transfer topic AND have remediated, so the
    // skill carries to a new context (a memorized fact wouldn't transfer).
    const map = ctx.world.topicMap[persona.topic];
    const namedTransfer = String(args.transferTopic || "").trim().length > 0;
    const transferValid = namedTransfer && map.related.includes(String(args.transferTopic));
    s.transferOk = transferValid && remediated;

    const correct = hypothesisIsTrue && remediated && s.transferOk;

    const reasons = [];
    if (hypothesisIsObvious && !s.revised) reasons.push("locked the obvious first guess and never revised to the student's actual misconception");
    else if (!hypothesisIsTrue) reasons.push("current hypothesis does not match the student's actual misconception");
    if (!remediated) reasons.push("did not remediate the actual misconception with a targeting hint");
    if (!s.transferOk) reasons.push("did not demonstrate transfer to a valid related topic after remediation");

    // partial: revised onto the true misconception but didn't finish remediation+transfer.
    let outcome = "failure";
    if (correct) outcome = "success";
    else if (revisedAway && (remediated || transferValid)) outcome = "partial";

    return ctx.grade(outcome, {
      score: correct ? 1 : outcome === "partial" ? 0.5 : 0,
      rationale: correct
        ? "Formed a hypothesis, tested it, revised away from the obvious-but-wrong guess to the student's real misconception, remediated it, and showed transfer to a related topic."
        : `Not yet mastered: ${reasons.join("; ")}.`,
      revisedFromObviousGuess: s.revised && hypothesisIsTrue,
      remediated,
      transferDemonstrated: s.transferOk,
    });
  },
};

// Golden path → success (with a REVISE step); naive (lock obvious, never revise) → failure.
// Proves the success signal is reachable and that the no-revise shortcut actually fails.
export function selftest({ call, ctx }) {
  const persona = ctx.world.persona;
  const dp = persona.discriminatingProblem;
  const transferTopic = persona.transferTopic;

  // GOLDEN: form -> test -> revise -> remediate -> transfer.
  const sess = call("set_hypothesis", { misconception: persona.obviousMisconception });
  call("pose_problem", { prompt: dp }); // discriminating problem reveals the TRUE answer
  call("revise_hypothesis", { misconception: persona.trueMisconception, because: "the discriminating problem's answer fit the other cause" });
  call("give_hint", { hint: `Let's work on ${persona.remediationKey.replace(/-/g, " ")}`, targets: persona.trueMisconception });
  const good = call("assess_mastery", { transferTopic });

  // NAIVE: lock the obvious guess, never revise, then assess.
  call("open_session", { summary: "naive" });
  call("set_hypothesis", { misconception: persona.obviousMisconception });
  call("give_hint", { hint: `Let's work on ${persona.remediationKey.replace(/-/g, " ")}`, targets: persona.trueMisconception });
  const bad = call("assess_mastery", { transferTopic });

  const pass = good.outcome === "success" && bad.outcome === "failure";
  return { pass, golden: good.outcome, naive: bad.outcome, detail: pass ? "ok" : { good, bad } };
}
