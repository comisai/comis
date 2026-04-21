# generate_sankey_chart — Sankey Diagram

## Overview
Visualizes the flow direction and volume of resources, energy, or users between different nodes. Suitable for budget allocation, traffic paths, energy consumption distribution, etc.

## Input Fields
### Required
- `data`: array<object>, each record contains `source` (string), `target` (string), and `value` (number).

### Optional
- `nodeAlign`: string, default `center`, options: `left`/`right`/`justify`/`center`.
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines node colors.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Keep node names unique and avoid excessive crossings. If cycles exist, flatten them into staged flows first. You can filter out small flows by threshold to focus on the key paths.

## Output
- Returns a Sankey diagram URL, with node and flow definitions stored in `_meta.spec`.
