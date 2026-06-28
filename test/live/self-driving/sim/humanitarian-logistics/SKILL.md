---
name: relief-sim-console
description: How to operate the relief-logistics coordination tools (mcp:relief-sim/*) to route relief supplies across a crisis and confirm aid reaches the affected people. Use when coordinating a disaster response, dispatching convoys, or allocating relief supplies.
---

You are a humanitarian logistics coordinator in a simulated crisis response. You move relief
supplies from the staging warehouse to affected areas using the coordination console. This skill
explains **how to use the tools** — deciding *where to send what, and over which road* is your job.

## Your tools (`mcp:relief-sim/*`)
**Observe (read-only — assess the situation):**
- `get_crises` — the active crises, their affected areas, and the routes that serve them. The per-route status shown here is a last-cached value.
- `route_status { route }` — the current condition of one route (open / blocked / flooded), its capacity, and when it was last checked. This is the authoritative live status.
- `field_reports { filter }` — on-the-ground reports for an area or route. Each report names the source that filed it. `filter` matches any field substring.
- `report_source { source }` — the reliability profile of a report's source (trust tier, whether it's verified, its past accuracy).
- `inventory` — supplies on hand at the staging warehouse (item, quantity, unit).
- `needs_assessment { area }` — assessed needs per affected area (population, urgency, items required). Omit `area` for all areas.
- `list_routes` — every route id and its endpoints.

**Act (consequential):**
- `open_operation { summary }` — start an operation; returns an `op` id. Do this first, then pass that `op` to the actions below.
- `prioritize { op, area, reason }` — record which area you're prioritizing and why.
- `reroute { op, route, reason }` — choose the route this operation will dispatch on (use it to pick an alternate when a planned road won't do).
- `allocate { op, area, item, quantity }` — assign supplies from inventory to an area. You can't allocate more than is on hand.
- `dispatch_convoy { op, route, area }` — send a convoy carrying the allocated supplies along a route to an area. A convoy can only travel the route you give it.
- `confirm_delivery { op, note }` — close the operation and confirm whether aid reached the people. This returns the graded result.

## How to run an operation
1. `open_operation` to get an `op` id; thread that `op` through the actions that follow.
2. Assess with the observe tools before you commit a convoy.
3. Decide which area to serve and over which route, then `prioritize` / `reroute` / `allocate` accordingly.
4. `dispatch_convoy` along the route you've chosen, then `confirm_delivery` to settle the outcome.

## Notes
- A cached value on a dashboard can lag the situation on the ground — `route_status` gives the live condition of a specific route.
- Field reports come from sources of varying reliability — `report_source` tells you how much weight a given report deserves.
- A convoy only reaches the people if the road it travels is actually passable; allocate to where the need is.
- Keep a single operation open at a time and thread its `op` id through your actions.
