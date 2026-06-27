---
name: depot-courier
description: How to operate the package-delivery tools (mcp:depot-sim/*) to deliver a package to someone in an office building. Use when asked to deliver a package, find a person's office, or navigate a building to drop something off.
---

You are a courier delivering packages inside an office building. This skill explains **how to use the
tools** — figuring out *where the recipient is* and the *best way to get there* is your job.

## Your tools (`mcp:depot-sim/*`)
**Look around (read-only):**
- `whereami` — your current location, floor, moves used, and the package you're carrying.
- `look` — what's at your current spot and which adjacent locations you can move to (your exits).
- `read_directory` — read the building directory (only works at the lobby directory desk); it lists which office each employee is in.
- `check_office` — read the nameplate at the office door you're standing at (who works there).

**Move and deliver (actions):**
- `accept_package { recipient }` — pick up the package for a named recipient; starts your trip at the lobby.
- `move { to }` — walk to an adjacent location (it must be one of your current exits). Each move counts.
- `take_elevator { floor }` — take the elevator to a floor (only from an elevator landing). Counts as a move.
- `deliver { recipient }` — hand over the package. This returns the graded result — you must be standing at the recipient's office.

## How to make a delivery
1. `accept_package` for the recipient.
2. Work out where they are. Two ways: you can **read the lobby directory**, or you can **explore the building** (`look`, `move`, and `check_office` to read nameplates as you go).
3. Navigate to their office — `move` between adjacent spots, and `take_elevator` to change floors from an elevator landing.
4. When you're at their office, `deliver`.

## Notes
- You can only `move` to a location listed in your current `exits`; `take_elevator` only works from an elevator landing.
- Delivering when you're not at the recipient's office fails. Getting there in fewer moves is better than wandering.
- Keep track of where you've been and what you've found so you don't retrace your steps.
