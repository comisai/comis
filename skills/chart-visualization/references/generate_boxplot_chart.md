# generate_boxplot_chart — Box Plot

## Overview
Displays the distribution range of data per category (min, max, quartiles, outliers). Used for quality monitoring, experiment results, or population distribution comparisons.

## Input Fields
### Required
- `data`: array<object>, each record contains `category` (string) and `value` (number), with an optional `group` (string) for multi-group comparison.

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines the color list.
- `style.texture`: string, defaults to `default`. Options: `default`/`rough`.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`.
- `height`: number, defaults to `400`.
- `title`: string, defaults to empty string.
- `axisXTitle`: string, defaults to empty string.
- `axisYTitle`: string, defaults to empty string.

## Usage Tips
Provide at least 5 samples per category to ensure statistical significance. To display multiple batches, use the `group` field or make separate calls.

## Output
- Returns a box plot URL, with the input specification stored in `_meta.spec`.
