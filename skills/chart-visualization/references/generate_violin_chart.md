# generate_violin_chart — Violin Chart

## Overview
Combines kernel density curves with box plot statistics to show the distribution shape across different categories. Suitable for comparing multi-batch experiments or group performance.

## Input Fields
### Required
- `data`: array<object>, each record contains `category` (string) and `value` (number), with optional `group` (string).

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines the color palette.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.
- `axisXTitle`: string, default empty string.
- `axisYTitle`: string, default empty string.

## Usage Tips
A sample size of at least 30 per category is recommended to ensure stable density estimation. To highlight quartile information, consider combining with a box plot display.

## Output
- Returns a violin chart URL, with configuration preserved in `_meta.spec`.
