---
name: figma-prototype
description: Use when the user wants to inspect, create, edit, or debug Figma prototype flows — reactions, triggers, actions, transitions, overlays, back navigation, variable-driven prototype logic, and page flow starting points.
---

# Figma Prototype

Work with native Figma prototype interactions using labor tools.

## Core workflow

- Inspect source, destination, and current start points first
- Wire one working reaction first, then batch
- Verify by re-reading reactions after every mutation
- Use this verification pattern:
  - `labor: labor_run_script` to read back `node.reactions`
  - `labor: labor_zoom_to_node` on source and destination nodes
  - `mcp: get_screenshot` when visual placement matters
- If runtime behavior still matters, ask the user to test in Present mode

## Discovery first

- Keep reads tight
- For most tasks, inspect only:
  - source node
  - destination node
  - current page `flowStartingPoints`
  - one nearby working prototype example when available
- Prefer existing local prototype patterns over inventing new transition recipes

```js
const source = await figma.getNodeByIdAsync("SOURCE_ID");
const dest = await figma.getNodeByIdAsync("DEST_ID");
return {
	source: {
		id: source.id,
		name: source.name,
		type: source.type,
		reactions: source.reactions,
	},
	destination: {
		id: dest.id,
		name: dest.name,
		type: dest.type,
	},
	flowStartingPoints: figma.currentPage.flowStartingPoints,
};
```

## Reactions

- Prototype interactions live on `node.reactions`
- When writing, use `await node.setReactionsAsync(...)`
- Do not rely on deprecated `action`; use `actions`
- Each `Reaction` must include:
  - a `trigger`
  - a non-empty `actions` array
- Start with one trigger and one action before adding more complexity

## Basic navigate pattern

- Good first pass:
  - `ON_CLICK`
  - one `NODE` action
  - `NAVIGATE` to a known destination frame
- Re-read after writing to confirm the destination ID and transition values

```js
const source = await figma.getNodeByIdAsync("SOURCE_ID");
const destination = await figma.getNodeByIdAsync("DEST_ID");

await source.setReactionsAsync([
	{
		trigger: { type: "ON_CLICK" },
		actions: [
			{
				type: "NODE",
				destinationId: destination.id,
				navigation: "NAVIGATE",
				transition: {
					type: "SMART_ANIMATE",
					easing: { type: "EASE_OUT" },
					duration: 0.2,
				},
				preserveScrollPosition: false,
			},
		],
	},
]);

return source.reactions;
```

## Flow starting points

- Presentation entry points live on `figma.currentPage.flowStartingPoints`
- Each item is:
  - `nodeId`
  - `name`
- The first item is the default start point
- Set start points only after the target frames already exist

```js
figma.currentPage.flowStartingPoints = [
	{ nodeId: "FRAME_ID", name: "Main flow" },
];
return figma.currentPage.flowStartingPoints;
```

## Advanced prototype logic

- Figma prototype actions can also drive variables
- Useful advanced actions include:
  - `SET_VARIABLE`
  - `CONDITIONAL`
- For advanced flows:
  - create variables first
  - bind variables where needed
  - prove one working conditional or toggle before repeating it

## Good mutation pattern

- Read existing reactions first
- Clone mentally, then replace with one deliberate update
- Re-read immediately after `setReactionsAsync`
- If updating several hotspots, verify the first one before batching the rest

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const before = node.reactions;

await node.setReactionsAsync([
	...before,
	{
		trigger: { type: "ON_CLICK" },
		actions: [
			{
				type: "NODE",
				destinationId: "DEST_ID",
				navigation: "NAVIGATE",
				transition: {
					type: "DISSOLVE",
					easing: { type: "EASE_OUT" },
					duration: 0.2,
				},
				preserveScrollPosition: false,
			},
		],
	},
]);

return node.reactions;
```

## Verification

- After every prototype mutation:
  - read back `node.reactions`
  - confirm source and destination IDs
  - confirm trigger type
  - confirm transition type and duration
- For flow starts:
  - read back `figma.currentPage.flowStartingPoints`
  - confirm intended order
- For overlays or visually sensitive transitions:
  - use `get_screenshot` when available
  - otherwise zoom to source and destination and inspect manually

## Gotchas

- If the plugin runs with `documentAccess: "dynamic-page"`, `reactions` is read-only
  - use `setReactionsAsync()` to update it
- `action` is deprecated
  - always write `actions`
- Every reaction must have both a trigger and a non-empty actions array
- Not every node is a good hotspot
  - if wiring is awkward, use a supported wrapper or child node instead
- Prototype debugging is easier when names are clear
  - rename frames and key hotspots before wiring large flows
