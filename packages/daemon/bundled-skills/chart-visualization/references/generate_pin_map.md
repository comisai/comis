# generate_pin_map — Pin Map (China)

## Overview
Displays multiple POI locations on a map of China using markers, with optional popups showing images or descriptions, suitable for store distribution, asset placement, etc.

## Input Fields
### Required
- `title`: string, required, 16 characters or fewer, summarizes the set of points.
- `data`: string[], required, contains a list of POI names within China.

### Optional
- `markerPopup.type`: string, fixed as `image`.
- `markerPopup.width`: number, default `40`, image width.
- `markerPopup.height`: number, default `40`, image height.
- `markerPopup.borderRadius`: number, default `8`, image border radius.
- `width`: number, default `1600`.
- `height`: number, default `1000`.

## Usage Tips
POI names should include sufficient geographic qualifiers (city + landmark); you can append attributes to the name based on business needs, e.g., "Store A, Xuhui, Shanghai"; the map relies on Amap (Gaode) data and only supports China.

## Output
- Returns a pin map URL, with point locations and popup configuration saved in `_meta.spec`.
