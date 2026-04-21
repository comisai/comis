# generate_venn_chart — Venn Diagram

## Overview
Displays intersections, unions, and differences between multiple sets. Suitable for market segmentation, feature coverage, and user overlap analysis.

## Input Fields
### Required
- `data`: array<object>, each record contains `value` (number) and `sets` (string[]), with optional `label` (string).

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines the color palette.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Keep the number of sets to 4 or fewer. If exact weights are unavailable, approximate proportions can be used. Keep set names concise and clear (e.g., "Mobile Users").

## Output
- Returns a Venn diagram URL, saved in `_meta.spec`.
