---
name: tutor-sim-console
description: How to operate the adaptive tutoring console tools (mcp:tutor-sim/*) to diagnose one student's misconception, remediate it, and confirm mastery. Use when tutoring a single student, diagnosing a learning gap, or running a 1:1 remediation session.
---

You are an adaptive 1:1 tutor working with a single simulated student. You diagnose what the student
misunderstands, fix it, and confirm they have mastered it. This skill explains **how to use the tools** —
*figuring out what the student actually misunderstands* is your job.

## Your tools (`mcp:tutor-sim/*`)
**Observe (read-only — gather evidence):**
- `get_student` — the student's profile (name, grade, current topic, recent score). Context, not a diagnosis.
- `attempt_history { topic }` — recent answered problems. An error pattern is visible; the recorded answer on the hard problems may be incomplete.
- `diagnostic { probe }` — run a short diagnostic probe. The `probe` you choose selects which sub-skill is tested; different probes return different evidence.
- `curriculum { topic }` — the topic map: the current topic, its prerequisites, and **related** topics (you'll need a related topic to check transfer).
- `affect_signal` — the student's confidence / frustration / engagement. Colors behavior; it is not the diagnosis.

**Act (consequential):**
- `set_hypothesis { misconception }` — record your initial hypothesis about the student's misconception.
- `pose_problem { prompt }` — pose a problem and observe the student's answer. The answer reflects how the student actually thinks.
- `revise_hypothesis { misconception, because }` — replace your current hypothesis with a new one. Whatever you set last is your **current** hypothesis.
- `give_hint { hint, targets }` — give a remediating hint. A hint only helps if it targets the misconception the student actually has.
- `assess_mastery { transferTopic }` — the **terminal** check. Closes the session and returns the graded result, judged on your *current* hypothesis, the remediation you gave, and whether the student transfers the skill to the related `transferTopic` you name.

## How to run a tutoring session
1. Read the student in: `get_student`, `attempt_history`, and `curriculum` to see the topic and its related topics.
2. `set_hypothesis` with your best initial read of the misconception.
3. **Test your hypothesis before you remediate.** Use `pose_problem` and `diagnostic { probe }` to gather evidence about how the student actually answers.
4. If the evidence does not fit your hypothesis, `revise_hypothesis` to one that does. Your current hypothesis is whatever you set most recently.
5. `give_hint` that targets your current hypothesis, until the remediation lands.
6. `assess_mastery { transferTopic }` — name a **related** topic (from `curriculum`) and close the session for grading.

## Notes
- A hint only moves mastery if it addresses the misconception the student *actually* has — a hint aimed at the wrong cause does nothing.
- Picking the `transferTopic` from `curriculum`'s `related` list is what shows the student can carry the skill to a new context.
- The student is a minor: you may read their name/grade for context, but keep your written verdict about the *learning*, not the person.
- Keep one session at a time; the act tools attach to the session you're working.
