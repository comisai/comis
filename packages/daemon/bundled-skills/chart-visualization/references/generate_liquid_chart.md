# generate_liquid_chart — Liquid Chart

## Overview
Uses liquid level height to display a single percentage or progress value, with strong visual animation effects, suitable for achievement rates, resource utilization, and similar metrics.

## Input Fields
### Required
- `percent`: number, range [0,1], represents the current percentage or progress.

### Optional
- `shape`: string, default `circle`, options: `circle`/`rect`/`pin`/`triangle`.
- `style.backgroundColor`: string, custom background color.
- `style.color`: string, custom wave color.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Ensure the percentage is normalized; each chart supports only one progress value -- to show multiple metrics, generate multiple liquid charts side by side; the title can read something like "Goal Completion Rate 85%".

## Output
- Returns a liquid chart URL, with parameters recorded in `_meta.spec`.
