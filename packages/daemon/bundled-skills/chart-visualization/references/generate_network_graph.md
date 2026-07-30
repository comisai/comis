# generate_network_graph — Network Graph

## Overview
Presents connections between entities using nodes and edges, suitable for social networks, system dependencies, knowledge graphs, and similar scenarios.

## Input Fields
### Required
- `data`: object, required, contains nodes and edges.
- `data.nodes`: array<object>, at least 1 entry, must provide a unique `name`.
- `data.edges`: array<object>, at least 1 entry, contains `source` and `target` (string); optional `name` to describe the relationship.

### Optional
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.

## Usage Tips
Keep the node count between 10-50 to avoid overcrowding; ensure `source`/`target` in `edges` correspond to existing nodes; use `label` to annotate the meaning of relationships.

## Output
- Returns a network graph URL, with `_meta.spec` provided for subsequent node additions or removals.
