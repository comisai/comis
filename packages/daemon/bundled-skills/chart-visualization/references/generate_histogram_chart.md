# generate_histogram_chart — Histogram

## Overview
Displays frequency or probability distribution of continuous values using bins, making it easy to identify skewness, outliers, and concentration intervals.

## Input Fields
### Required
- `data`: number[], at least 1 entry, used to build the frequency distribution.

### Optional
- `binNumber`: number, custom number of bins; auto-estimated if not set.
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines bar colors.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.
- `axisXTitle`: string, default empty string.
- `axisYTitle`: string, default empty string.

## Usage Tips
Clean out null/anomalous values before passing data in; sample size should be at least 30; adjust `binNumber` based on business context to balance detail and overall trend.

## Output
- Returns a histogram URL, with parameters stored in `_meta.spec`.
