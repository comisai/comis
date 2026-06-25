# FIX-VERIFY-LOG — <target> — <YYYYMMDD>

> One entry per COMIS-FAIL closed, in order. Mirrors the loop in `../02-DISCIPLINE.md`. Copy into `runs/<target>-<date>/`.

## <issue-id> — <one-line title>
- **Symptom (live):** `<which test row failed; the observed wrong behavior>`
- **Evidence (ground truth):** `<trajectory / explain / fleet / daemon-log excerpt — the REAL payload, not a paraphrase>`
- **Hypothesis → root cause:** `<one evidence-backed cause; note the defect class — built-but-not-wired / silent-degrade / …>`
- **RED test:** `<packages/*/src/**/...test.ts>` — fails on pre-patch code, reproduces the live shape. (Wiring gap → a `test/architecture/*-wiring-guard.test.ts` source guard.)
- **Fix:** `<files touched; the one-line idea>`. Docs-current: `<docs/**/*.mdx touched? N/A?>`
- **Review:** makes the failure impossible because `<…>` (not just silences the test).
- **Clean-slate + rebuild + clean-restart:** `<wiped logs+memory.db+session; proved on new code>`
- **Confirm (ground truth, clean slate):** `<oracle excerpt proving GREEN live + a forced-failure still degrades honestly>`
- **Observability gap closed:** `<the signal threaded to explain/fleet, proven on this incident — or N/A>`
- **Regression re-run:** `<tests the fix could regress, re-checked>`
- **Commit:** `<hash>` (branch-first; commit/push only when the user asks)
- **Status:** CLOSED — `<litmus: next time `explain <ref>` answers this in one call>` / deferred (dated TODO: `<…>`)
