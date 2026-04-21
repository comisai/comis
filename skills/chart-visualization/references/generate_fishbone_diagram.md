# generate_fishbone_diagram — Fishbone Diagram

## Overview
Used for root cause analysis. Places the central problem on the main spine with branches on both sides showing different categories of causes and their sub-nodes. Commonly used in quality management and process optimization.

## Input Fields
### Required
- `data`: object, required. Must provide at least a root node `name`, and can be recursively expanded via `children` (array<object>). A maximum of 3 levels is recommended.

### Optional
- `style.texture`: string, defaults to `default`. Options: `default`/`rough` to switch line styles.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`.
- `height`: number, defaults to `400`.

## Usage Tips
The main spine node should describe the problem statement. First-level branches should name cause categories (e.g., People, Machine, Material, Method). Leaf nodes should describe specific observations, using concise phrases.

## Output
- Returns a fishbone diagram URL, with the tree structure saved in `_meta.spec` for subsequent addition or removal of nodes.
