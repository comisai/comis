# generate_flow_diagram — Flow Diagram

## Overview
Displays business processes, approval chains, or algorithm steps using nodes and edges. Supports multiple node types such as start, decision, and operation.

## Input Fields
### Required
- `data`: object, required, contains node and edge definitions.
- `data.nodes`: array<object>, at least 1 required. Each node must provide a unique `name`.
- `data.edges`: array<object>, at least 1 required. Each edge contains `source` and `target` (string), with an optional `name` for edge label text.

### Optional
- `style.texture`: string, defaults to `default`. Options: `default`/`rough`.
- `theme`: string, defaults to `default`. Options: `default`/`academy`/`dark`.
- `width`: number, defaults to `600`.
- `height`: number, defaults to `400`.

## Usage Tips
First list out node `name` values and ensure they are unique, then create edges. If you need to describe conditions, use the `edges.name` field. Flows should maintain a single direction or have clear branching to avoid crossovers.

## Output
- Returns a flow diagram URL, with node and edge data included in `_meta.spec` for easy future adjustments.
