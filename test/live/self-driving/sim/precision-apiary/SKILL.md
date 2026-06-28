---
name: apiary-sim-console
description: How to operate the precision-apiary console tools (mcp:apiary-sim/*) to manage a bee yard through one season — inspecting hives, reading the forage and honey-flow, and acting (treat, place, harvest) up to closing the season. Use when managing an apiary, planning hive placement, scheduling treatments, or timing a honey harvest.
---

You are the beekeeper for a simulated apiary running one full season. You manage the yard
with the apiary console tools. This skill explains **how to use the tools** — deciding
*what each hive needs, where to put it, and when to pull honey* is your job.

## Your tools (`mcp:apiary-sim/*`)
**Observe (read-only — gather information):**
- `get_hives` — the hives in the yard with a quick summary (boxes, population). Summary only.
- `inspect_hive { hive }` — open one hive for a detailed look: brood pattern, population, field-visible health signs. Also pulls a mite-wash sample.
- `pest_pressure { hive }` — the measured mite/pest reading for a hive. Needs a fresh sample first (`inspect_hive` or `schedule_inspection`); otherwise it reports no sample. It tells you the treatment threshold.
- `forage_map` — the forage sources blooming **this** season, each with bloom status and nectar quality.
- `weather_season` — the week-by-week weather outlook.
- `harvest_forecast` — the projected honey-flow curve by week (relative nectar income). You read the curve.

**Act (consequential):**
- `schedule_inspection { hive, week }` — book an inspection; this produces a fresh pest sample for `pest_pressure`.
- `treat { hive, week, reason }` — apply a treatment to a hive. Treating a colony that doesn't need it adds stress for little benefit.
- `place_hive { hive, location }` — place/move a hive at a forage location for the season.
- `harvest { hive, week }` — pull honey supers from a hive in a given week.
- `close_season { notes }` — end the season and submit for grading. This returns the graded result. Call it last.

## How to run a season
1. Survey the yard: `get_hives`, then `inspect_hive` the ones you want a closer look at.
2. To get a mite reading from `pest_pressure`, sample first — via `inspect_hive` or `schedule_inspection`.
3. Read `forage_map`, `weather_season`, and `harvest_forecast` to understand this season's conditions.
4. Act: `treat`, `place_hive`, and `harvest` as your judgment dictates. Each act takes a `week` so timing is yours to set.
5. `close_season` once when you are done — it grades colony health and harvest yield.

## Notes
- The `get_hives` summary is shallow; `inspect_hive` + `pest_pressure` reveal far more about a hive's real state.
- `pest_pressure` returns the threshold it considers significant — compare your reading against it.
- `forage_map` reflects the current season; `harvest_forecast` shows when nectar income rises and falls.
- Treating, placing, and harvesting all carry a cost when done to the wrong hive, at the wrong place, or at the wrong time — observe before you act.
- `close_season` is terminal: you cannot act after it.
