# generate_organization_chart — Organization Chart

## Overview
Displays the hierarchical relationships of a company, team, or project, with the ability to describe roles and responsibilities on each node.

## Input Fields
### Required
- `data`: object, required, each node must contain at least `name` (string), optionally `description` (string); child nodes are nested via `children` (array<object>), with a recommended maximum depth of 3.

### Optional
- `orient`: string, default `vertical`, options: `horizontal`/`vertical`.
- `style.texture`: string, default `default`, options: `default`/`rough`.
- `theme`: string, default `default`, options: `default`/`academy`/`dark`.
- `width`: number, default `600`.
- `height`: number, default `400`.

## Usage Tips
Use job titles or roles as node names; `description` should briefly explain responsibilities or headcount; for large organizations, split into multiple sub-charts or display by department.

## Output
- Returns an organization chart URL, with the structure saved in `_meta.spec` for future iteration.
