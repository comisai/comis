# generate_district_map — District Map (China)

## Overview
Generates a coverage or heatmap of provinces, cities, districts, or counties within China. Can display metric ranges, categories, or regional composition. Suitable for regional sales, policy coverage, and similar scenarios.

## Input Fields
### Required
- `title`: string, required, max 16 characters, describes the map theme.
- `data`: object, required, carries administrative district configuration and metric information.
- `data.name`: string, required, an administrative district keyword within China, must be specific to the province/city/district/county level.

### Optional
- `data.style.fillColor`: string, custom fill color for areas without data.
- `data.colors`: string[], enumerated or continuous color scale, defaults to a 10-color list.
- `data.dataType`: string, either `number` or `enum`, determines the color mapping method.
- `data.dataLabel`: string, metric name (e.g., `GDP`).
- `data.dataValue`: string, metric value or enum label.
- `data.dataValueUnit`: string, metric unit (e.g., `trillion`).
- `data.showAllSubdistricts`: boolean, defaults to `false`, whether to display all sub-level administrative districts.
- `data.subdistricts[]`: array<object>, used for drilling down into sub-regions. Each element must contain at least `name`, and may include `dataValue` and `style.fillColor`.
- `width`: number, defaults to `1600`, sets the map width.
- `height`: number, defaults to `1000`, sets the map height.

## Usage Tips
Names must be precise to the administrative level; avoid ambiguous terms. When configuring `subdistricts`, also enable `showAllSubdistricts`. The map only supports regions within China and relies on AutoNavi (Amap) data.

## Output
- Returns a map image URL, with the full input preserved in `_meta.spec`. If `SERVICE_ID` is configured, the generated record will be synced to the "My Maps" mini-program.
