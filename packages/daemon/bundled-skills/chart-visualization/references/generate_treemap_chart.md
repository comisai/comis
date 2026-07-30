# generate_treemap_chart — Treemap Chart

## Overview
Displays hierarchical structures and node weights using nested rectangles. Suitable for asset allocation, market share, directory size, etc.

## Input Fields
### Required
- `data`: array<object>, an array of nodes where each entry contains `name` (string) and `value` (number), with optional recursive nesting via `children`.

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines the color palette.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Ensure each node's `value` is >= 0 and consistent with the sum of its children. Avoid excessively deep tree levels; pre-aggregate as needed. To improve readability, consider including units in node names.

## Output
- Returns a treemap chart URL, with `_meta.spec` synced.
