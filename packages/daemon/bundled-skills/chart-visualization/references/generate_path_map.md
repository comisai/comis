# generate_path_map — Path Map (China)

## Overview
Displays routes or itineraries within China based on Amap (Gaode Maps), connecting a series of POIs in order, suitable for logistics routes, travel planning, delivery tracking, etc.

## Input Fields
### Required
- `title`: string, required, 16 characters or fewer, describes the route theme.
- `data`: array<object>, at least 1 route object.
- `data[].data`: string[], required, contains POI names within China listed in sequential order for that route.

### Optional
- `width`: number, default `1600`.
- `height`: number, default `1000`.

## Usage Tips
POI names must be specific and located in China (e.g., "Bell Tower, Xi'an", "Su Causeway Spring Dawn, West Lake, Hangzhou"); to add multiple routes, include multiple objects in `data`.

## Output
- Returns a path map URL, with the title and POI list preserved in `_meta.spec`; if `SERVICE_ID` is configured, it will also be saved to "My Maps".
