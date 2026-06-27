---
name: fire-sim-command
description: How to operate the wildland-fire incident-command tools (mcp:fire-sim/*) to size up a fire, set a suppression plan, assign resources, and bring the incident to containment. Use when acting as planning chief / incident commander on a wildland fire.
---

You are the planning chief on a wildland fire. You run the incident using the
incident-command tools. This skill explains **how to use the tools** — sizing up the
fire and deciding *what plan the conditions call for* is your job.

## Your tools (`mcp:fire-sim/*`)
**Observe (read-only — size up the fire):**
- `get_weather` — wind, temperature, RH, and any forecast shift (a front, wind switch, or RH crash).
- `fuel_moisture` — the dominant fuel model, dead/live fuel moisture, and canopy/ladder-fuel continuity.
- `terrain { zone }` — slope, aspect, terrain features, and whether slope aligns with the wind for a zone (omit `zone` for all zones).
- `spread_forecast` — modeled rate of spread, flame length, spotting distance, and which zones the head/flanks reach.
- `resource_status` — the crews, engines, dozers, and aircraft you have and their commit status.
- `get_incident_map` — the zones and their role (origin, head, flanks, values-at-risk like communities/structures).

**Act (consequential):**
- `open_incident { summary }` — open the incident record; returns an `incident` id. Do this first.
- `set_tactic { incident, tactic, containment_line }` — set your suppression tactic and where you anchor the containment line.
- `assign_crew { incident, resource, zone, task }` — put a crew/engine/dozer to work in a zone. The tool reports the safety posture; a **ground** crew sent into an unsafe (blow-up) zone is **refused** (not committed), so you can read the posture without endangering anyone — move them to a safe zone or use aircraft instead.
- `order_air { incident, aircraft, zone }` — order an air tanker or helicopter onto a zone.
- `issue_evac { incident, zone, level }` — order an evacuation for a zone with people/structures at risk.
- `declare_contained { incident, note }` — declare the fire contained and end the period. This returns the graded result.

## How to run the incident
1. `open_incident` to get an `incident` id; pass that `incident` to the actions that follow.
2. **Size up before you commit** — pull weather, fuels, terrain, the spread forecast, the map, and your resource status with the observe tools.
3. `set_tactic` with the plan the conditions call for and the containment line you anchor it on.
4. `assign_crew` / `order_air` to put resources to work. **Heed the safety posture the tool reports** — it tells you whether a zone is safe for ground crews.
5. `issue_evac` for any zone where people or structures are in the fire's path.
6. `declare_contained` when your plan is in place. This is graded.

## Notes
- Sizing up the fire is the whole job: the right plan depends on the weather, the fuels, the terrain, and the forecast — read them before you act.
- A zone that is safe to work one minute can be a death trap the next; the `assign_crew` safety posture is your guardrail — never put ground crews where it warns you off.
- Containment is judged on the outcome: a plan that fits the fire and keeps everyone safe holds the line; one that does not, does not.
- Keep a single incident open at a time and thread its `incident` id through your actions.
