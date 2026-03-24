---
name: figma-create
description: Use when the user wants to create, build, design, clone, duplicate, or compose new UI elements in Figma — cards, frames, layouts, screens, or any multi-node structure. Covers cloning existing designs, building new components from scratch, inserting into existing layouts, and matching existing design language.
---

# Figma Create

Instructions for building new design elements and composing them into existing layouts
via `figma_run_script`.

## Golden rule: incremental scripts

**Never build an entire card/component in a single `figma_run_script` call.**
Long scripts (>40 lines of node creation) silently fail — the script runs but
produces no output or partial results with no error.

Break creation into phases, one script per phase:

| Phase | Script | Returns |
|---|---|---|
| 1. Clone / create shell | Clone frame or create outer container | `{ id }` of new root |
| 2. Add section A | Header, title bar, etc. | `{ createdNodeIds: [...] }` |
| 3. Add section B | Content area, chart, list, etc. | `{ createdNodeIds: [...] }` |
| 4. Add section C | Footer, CTAs, metadata, etc. | `{ createdNodeIds: [...] }` |
| 5. Verify | `get_screenshot` on the new node | visual confirmation |

**Every script must `return` ALL created/mutated node IDs.** Return them in a
structured object: `return { createdNodeIds: [...], parentId: "..." }`. If a script
returns nothing (`Tool ran without output or errors`), it silently failed. Diagnose
before continuing.

## Inspect before creating

**Always inspect the file before creating anything.** Different files use different
naming conventions, variable structures, and component patterns. Match what's there.

```js
// Quick inspection: what's on this page?
const page = figma.currentPage;
return page.children.slice(-10).map(c => ({
  name: c.name, type: c.type, id: c.id,
  x: c.x, y: c.y, w: c.width, h: c.height
}));
```

## Extract design language first

Before building anything new, extract visual properties from an existing sibling
element. One script call:

```js
const ref = await figma.getNodeByIdAsync("EXISTING_CARD_ID");
return {
  cornerRadius: ref.cornerRadius,
  fills: ref.fills,
  effects: ref.effects,
  strokes: ref.strokes,
};
```

Also read text styles from a representative text node:

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

Use these extracted values verbatim. Do not guess colors, fonts, or spacing.

## Cloning frames

```js
const original = await figma.getNodeByIdAsync("SOURCE_ID");
const clone = original.clone();
clone.x = original.x + original.width + 80;
clone.y = original.y;
clone.name = "New variant name";
return { cloneId: clone.id, x: clone.x, y: clone.y };
```

**Gotchas:**
- `clone()` places the new node as a sibling of the original (same parent)
- Clone IDs are new — do not reuse original child IDs
- To find children inside a clone, traverse by **name**, not by ID

## Creating a container frame

```js
const card = figma.createFrame();
card.name = "My Card";
card.resize(370, 10); // width fixed, height will be auto
card.layoutMode = "VERTICAL";
card.primaryAxisSizingMode = "AUTO";
card.counterAxisSizingMode = "FIXED";
card.cornerRadius = 32;
card.clipsContent = true;
card.fills = [{ type: "SOLID", visible: true, opacity: 0.8,
  blendMode: "NORMAL", color: { r: 0.97, g: 0.97, b: 1 } }];

// Insert into parent BEFORE setting layoutSizing
parentFrame.insertChild(0, card);
card.layoutSizingHorizontal = "FILL";

return { cardId: card.id };
```

## Positioning top-level nodes

Nodes appended to the page default to (0,0) and overlap existing content.
Scan existing children to find clear space:

```js
let maxX = 0;
for (const child of figma.currentPage.children) {
  maxX = Math.max(maxX, child.x + child.width);
}
const frame = figma.createFrame();
frame.x = maxX + 200;
frame.y = 0;
```

## Adding text nodes

Always load fonts before creating text:

```js
await figma.loadFontAsync({ family: "Inter Variable", style: "Medium" });

const title = figma.createText();
title.fontName = { family: "Inter Variable", style: "Medium" };
title.characters = "Section title";
title.fontSize = 14;
title.fills = [{ type: "SOLID", opacity: 0.96, color: { r: 0, g: 0, b: 0 } }];
```

## Inserting into existing layouts

```js
const content = await figma.getNodeByIdAsync("CONTENT_FRAME_ID");

// insertChild(0, ...) = top of list
// insertChild(content.children.length, ...) = bottom
content.insertChild(0, card);
card.layoutSizingHorizontal = "FILL";

return { position: 0, siblings: content.children.length };
```

## Fills and strokes are read-only

Never mutate fills/strokes in place. Clone, modify, reassign:

```js
// Wrong
node.fills[0].opacity = 0.5;

// Correct
const fills = JSON.parse(JSON.stringify(node.fills));
fills[0].opacity = 0.5;
node.fills = fills;
```

## Debugging silent failures

When a script returns no output:

1. **Test with a minimal version** — create a simple colored rectangle and insert it.

```js
const parent = await figma.getNodeByIdAsync("PARENT_ID");
const test = figma.createFrame();
test.name = "TestCard";
test.resize(370, 100);
test.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }];
parent.insertChild(0, test);
return { ok: true, id: test.id, children: parent.children.length };
```

2. **If the test succeeds**, the problem is script size. Break into smaller pieces.

3. **If the test fails**, the parent reference is wrong. Check:
   - Is the parent on the current page?
   - Is the ID correct?
   - Is the parent locked or inside a locked instance?

## Finding children inside a clone

After cloning, child IDs change. Find them by name:

```js
const clone = await figma.getNodeByIdAsync("CLONE_ID");
let content = null;
for (const child of clone.children) {
  if (child.name === "Content") { content = child; break; }
}
return content
  ? { id: content.id, children: content.children.map(c => c.name) }
  : "Content frame not found";
```

**Never hardcode child IDs from the original into clone operations.**

## Error recovery

**On error, STOP. Do not immediately retry.** Read the error message. Failed scripts
are atomic — if a script errors, no changes are made. The file remains in the state
before the call. Fix the script, then retry.

| Error message | Likely cause | Fix |
|---|---|---|
| `"cannot read property of null"` | Node doesn't exist (wrong ID, wrong page) | Verify ID, check page context |
| `"not implemented"` | Used `figma.notify()` | Remove — use `return` for output |
| `"node must be an auto-layout frame"` | Set FILL/HUG before appending to parent | Move `appendChild` before `layoutSizingX = 'FILL'` |
| No output, no error | Script too large | Break into smaller scripts |
| Property value looks wrong | Color used 0-255 instead of 0-1 | All colors are 0-1 range |

## Pre-flight checklist

Before every `figma_run_script` call:

- [ ] Colors use 0-1 range (not 0-255)
- [ ] Fills/strokes reassigned as new arrays (not mutated in place)
- [ ] `layoutSizingHorizontal`/`Vertical` set AFTER `appendChild`
- [ ] `loadFontAsync()` called BEFORE any text property changes
- [ ] `resize()` called BEFORE setting sizing modes (resize resets them to FIXED)
- [ ] `lineHeight`/`letterSpacing` use `{ unit, value }` format (not bare numbers)
- [ ] Script returns all created node IDs

## Completion checklist

Before reporting completion:

- [ ] Every `figma_run_script` returned a meaningful value (not empty)
- [ ] `get_screenshot` taken on the new element in isolation
- [ ] `get_screenshot` taken on the parent frame showing context
- [ ] New element visually matches sibling elements (same radius, shadow, spacing)
- [ ] Text is readable (not clipped, not overlapping)
- [ ] Auto-layout sizing is correct (FILL where needed)
