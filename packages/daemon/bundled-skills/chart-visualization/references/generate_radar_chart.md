# generate_radar_chart — Radar Chart

## Overview
Compares capability dimensions of one or more objects on a multi-axis coordinate system. Commonly used for evaluations, product comparisons, and performance profiling.

## Input Fields
### Required
- `data`: array<object>, each record contains `name` (string) and `value` (number), with optional `group` (string).

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.lineWidth`: number, sets the radar line width.
- `style.palette`: string[], defines series colors.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Keep the number of dimensions between 4 and 8. Distinguish different objects via `group` and ensure every object provides a value for every dimension. If units of measurement differ, normalize the values first.

## Output
- Returns a radar chart URL with `_meta.spec` attached.
