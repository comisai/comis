# generate_pie_chart — Pie / Donut Chart

## Overview
Displays part-to-whole proportions; can form a donut chart by setting an inner radius, suitable for market share, budget composition, user segmentation, etc.

## Input Fields
### Required
- `data`: array<object>, each entry contains `category` (string) and `value` (number).

### Optional
- `innerRadius`: number, range [0, 1], default `0`; set to `0.6` or similar to generate a donut chart.
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines the color palette.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Keep the number of categories to 6 or fewer; if there are more, aggregate them into an "Other" category; ensure value units are consistent (percentages or absolute values); note the base value in the title if needed.

## Output
- Returns a pie/donut chart URL, with `_meta.spec` attached.
