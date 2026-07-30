# generate_funnel_chart — Funnel Chart

## Overview
Displays multi-stage conversion or drop-off. Commonly used for sales pipelines, user journeys, and other progressive filtering processes.

## Input Fields
### Required
- `data`: array<object>, must be arranged in process order. Each record contains `category` (string) and `value` (number).

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines the color for each stage.
- `style.texture`: string, defaults to `default`. Options: `default`/`rough`.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`.
- `height`: number, defaults to `400`.
- `title`: string, defaults to empty string.

## Usage Tips
Stages must be arranged in actual process order. If values are percentages, unify the baseline and explain the methodology in the title or notes. Avoid too many stages to prevent readability issues (recommended 6 or fewer).

## Output
- Returns a funnel chart URL, with `_meta.spec` included for reuse.
