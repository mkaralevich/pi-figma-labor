---
name: figma-create
description: Use when the user wants to create, build, design, clone, duplicate, or compose new UI elements in Figma. Covers cloning existing nodes, building new components from scratch, inserting into existing layouts, and matching existing design language.
---

# Figma Create

Build new elements and compose them into existing layouts with labor tools.

## Core workflow

- Inspect first
- Create in small steps
- Return IDs from every mutation script
- Verify the first working pattern before batching
- Use this verification pattern:
  - `mcp: get_screenshot`
  - `labor: labor_zoom_to_node` + manual inspect

## Script size

- Do not build complex layouts in one `labor_run_script`
- Large creation scripts can fail silently
- Good split:
  - shell or clone
  - section A
  - section B
  - section C
  - verify
- Every script should return useful output
  - `return { createdNodeIds: [...], parentId: "..." }`
- If a script returns nothing, treat it as failed and diagnose before continuing

## Minimal inspection

- Always inspect before creating
- Keep discovery small
- Match local naming, variables, component patterns, spacing, and styling
- Reuse before creating:
  1. connected library assets already enabled in the file
  2. existing local assets in the file
  3. new local assets only if reuse is not possible
- If the user asks to use a design library, connected tokens, or existing styles, do not create new local tokens or styles until connected and local reuse paths have both been checked
- For most tasks, read only:
  - target node or parent
  - one nearby reference sibling
  - then start building

```js
const page = figma.currentPage;
return page.children.slice(-10).map((child) => ({
	name: child.name,
	type: child.type,
	id: child.id,
	x: child.x,
	y: child.y,
	w: child.width,
	h: child.height,
}));
```

## Extract design language

- Before building, read visual properties from one good local reference
- Reuse values directly; do not guess
- Common properties to extract:
  - corner radius
  - fills
  - strokes
  - effects
  - font
  - font size
  - line height
  - letter spacing

```js
const ref = await figma.getNodeByIdAsync("EXISTING_CARD_ID");
return {
	cornerRadius: ref.cornerRadius,
	fills: ref.fills,
	effects: ref.effects,
	strokes: ref.strokes,
};
```

```js
const text = await figma.getNodeByIdAsync("TEXT_NODE_ID");
return {
	fontName: text.fontName,
	fontSize: text.fontSize,
	fills: text.fills,
	letterSpacing: text.letterSpacing,
	lineHeight: text.lineHeight,
};
```

## Prove one pattern first

- For repeated creation:
  - inspect one source node deeply
  - inspect one good reference
  - create one new node or variant set
  - verify it
  - reuse the same working recipe for the rest
- This is faster than over-inspecting every target first

## Cloning

- `clone()` creates a sibling under the same parent
- Clone child IDs are new
- After cloning, find children by name, not by original child ID

```js
const original = await figma.getNodeByIdAsync("SOURCE_ID");
const clone = original.clone();
clone.x = original.x + original.width + 80;
clone.y = original.y;
clone.name = "New variant name";
return { cloneId: clone.id, x: clone.x, y: clone.y };
```

## New container frames

- Prefer auto-layout for new containers
- Typical rule of thumb inside auto-layout:
  - width is usually fill
  - height is usually hug
- Insert into parent before setting fill sizing

```js
const card = figma.createFrame();
card.name = "My Card";
card.resize(370, 10);
card.layoutMode = "VERTICAL";
card.primaryAxisSizingMode = "AUTO";
card.counterAxisSizingMode = "FIXED";
card.cornerRadius = 32;
card.clipsContent = true;
card.fills = [
	{
		type: "SOLID",
		visible: true,
		opacity: 0.8,
		blendMode: "NORMAL",
		color: { r: 0.97, g: 0.97, b: 1 },
	},
];

parentFrame.insertChild(0, card);
card.layoutSizingHorizontal = "FILL";

return { cardId: card.id };
```

## Top-level placement

- Nodes appended to the page default to `(0,0)`
- Scan siblings to place new top-level nodes into open space

```js
let maxX = 0;
for (const child of figma.currentPage.children) {
	maxX = Math.max(maxX, child.x + child.width);
}
const frame = figma.createFrame();
frame.x = maxX + 200;
frame.y = 0;
```

## Text nodes

- Always load fonts before changing text properties

```js
await figma.loadFontAsync({ family: "Inter Variable", style: "Medium" });

const title = figma.createText();
title.fontName = { family: "Inter Variable", style: "Medium" };
title.characters = "Section title";
title.fontSize = 14;
title.fills = [{ type: "SOLID", opacity: 0.96, color: { r: 0, g: 0, b: 0 } }];
```

## Inserting into existing layouts

- Use parent auto-layout instead of manual positioning when possible
- Common pattern:
  - insert at index `0` for top
  - insert at `children.length` for bottom

```js
const content = await figma.getNodeByIdAsync("CONTENT_FRAME_ID");
content.insertChild(0, card);
card.layoutSizingHorizontal = "FILL";
return { position: 0, siblings: content.children.length };
```

## Fills and strokes

- Do not mutate fills or strokes in place
- Clone → change → reassign

```js
const fills = JSON.parse(JSON.stringify(node.fills));
fills[0].opacity = 0.5;
node.fills = fills;
```

## Finding children inside clones

- Do not hardcode original child IDs after clone operations
- Traverse by name instead

```js
const clone = await figma.getNodeByIdAsync("CLONE_ID");
let content = null;
for (const child of clone.children) {
	if (child.name === "Content") {
		content = child;
		break;
	}
}
return content
	? { id: content.id, children: content.children.map((child) => child.name) }
	: "Content frame not found";
```

## Debugging silent failures

- If a script returns no output:
  - test a minimal rectangle or frame first
  - if that works, the original script was too large
  - if that fails, the parent reference is wrong
- Check:
  - parent ID
  - current page
  - locked parent
  - locked instance ancestry

```js
const parent = await figma.getNodeByIdAsync("PARENT_ID");
const test = figma.createFrame();
test.name = "TestCard";
test.resize(370, 100);
test.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
parent.insertChild(0, test);
return { ok: true, id: test.id, children: parent.children.length };
```

## Error recovery

- On error, stop and read the message before retrying
- Failed scripts are atomic
- Common causes:

| Error | Likely cause | Fix |
|---|---|---|
| `cannot read property of null` | wrong ID or wrong page | verify node ID and page context |
| `not implemented` | used unsupported API like `figma.notify()` | remove it and use `return` |
| `node must be an auto-layout frame` | set fill or hug before append | append first, then set sizing |
| no output, no error | script too large | split into smaller scripts |
| wrong visual values | used 0–255 colors | use 0–1 color range |

## Pre-flight checklist

- Colors use 0–1 range
- Fills and strokes are reassigned, not mutated in place
- `layoutSizingHorizontal` and `layoutSizingVertical` are set after append/insert
- `loadFontAsync()` is called before text changes
- `resize()` is called before sizing modes if both are needed
- `lineHeight` and `letterSpacing` use `{ unit, value }`
- Every script returns all created IDs

## Completion checklist

- Every `labor_run_script` returned useful output
- New element was verified in isolation
  - `mcp: get_screenshot`
  - `labor: labor_zoom_to_node` + manual inspect
- Parent context was verified when placement matters
  - `mcp: get_screenshot`
  - `labor: labor_get_node_full` + `labor_get_children`
- New element matches nearby siblings
- Text is readable and not clipped
- Auto-layout sizing is correct

## Quick recipes

### Clone and rename

```js
const original = await figma.getNodeByIdAsync("SOURCE_ID");
const clone = original.clone();
clone.name = "Copy";
return { cloneId: clone.id };
```

### Create one container first

```js
const parent = await figma.getNodeByIdAsync("PARENT_ID");
const frame = figma.createFrame();
frame.name = "Section";
frame.layoutMode = "VERTICAL";
frame.primaryAxisSizingMode = "AUTO";
frame.counterAxisSizingMode = "FIXED";
parent.appendChild(frame);
frame.layoutSizingHorizontal = "FILL";
return { frameId: frame.id };
```

### Verify before batching

- Create one
- Verify one
- Reuse that exact pattern for the remaining siblings
