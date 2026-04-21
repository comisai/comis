# generate_word_cloud_chart — Word Cloud Chart

## Overview
Adjusts text size and position based on word frequency or weight. Used for quickly extracting text themes, sentiment, or keyword hotspots.

## Input Fields
### Required
- `data`: array<object>, each record contains `text` (string) and `value` (number).

### Optional
- `style.backgroundColor`: string, sets the background color.
- `style.palette`: string[], defines word cloud colors.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.
- `title`: string, default empty string.

## Usage Tips
Remove stop words and merge synonyms before generating. Normalize letter casing to avoid duplicates. To highlight sentiment, consider mapping positive and negative values to different colors.

## Output
- Returns a word cloud chart URL with `_meta.spec` attached.
