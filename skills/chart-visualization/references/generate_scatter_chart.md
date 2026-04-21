# generate_scatter_chart — Scatter Chart

## Overview
Displays the relationship between two continuous variables. Different groups can be distinguished by color or shape. Suitable for correlation analysis and cluster exploration.

## Input Fields
### Required
- `data`: array<object>, each record contains `x` (number) and `y` (number), with optional `group` (string).

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], specifies series colors.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.
- `axisXTitle`: string, default empty string.
- `axisYTitle`: string, default empty string.

## Usage Tips
Consider standardizing variables with different units of measurement before uploading. For very large datasets, sample the data first. Use `group` to distinguish different categories or clustering results for better readability.

## Output
- Returns a scatter chart URL with `_meta.spec` attached.
