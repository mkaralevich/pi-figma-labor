---
name: figma-slides-create
description: Create and edit Figma Slides content with Labor — focused-slide content, slides, rows, grid ordering, skipped state, and transitions. Use for presentation creation, slide structure, and Slides-specific verification.
---

# Figma Slides Create

Build presentation content with Labor tools.

## Workflow

1. Call `labor_get_selection`.
2. Confirm `figma.editorType === "slides"`.
3. Read `currentPage.focusedSlide` and the canvas grid.
4. Create content inside the focused slide.
5. Create or reorder slides in small steps.
6. Verify with Labor reads and viewport zoom.
7. Restore the original grid after temporary tests.

## Read Slides context

```js
const page = figma.currentPage;
return {
  focusedSlide: page.focusedSlide
    ? { id: page.focusedSlide.id, name: page.focusedSlide.name }
    : null,
  focusedNode: page.focusedNode
    ? { id: page.focusedNode.id, type: page.focusedNode.type }
    : null,
  slidesMode: figma.viewport.slidesMode,
  grid: figma.getCanvasGrid().map((row) => row.map((slide) => slide.id)),
};
```

## Focused-slide content

`labor_create_node` places ordinary content in the focused slide when `parentId` is omitted.

Supported content:

- `FRAME`
- `RECTANGLE`
- `ELLIPSE`
- `TEXT`

Use explicit `parentId` when targeting another slide.

Slides do not expose native `createShapeWithText()` or `createTable()` in the tested runtime. Compose shapes from standard rectangles, frames, and text instead.

## Slides and rows

Create a slide:

```js
labor_create_node({ type: "SLIDE", row: 0, column: 1 });
```

Create a row:

```js
labor_create_node({ type: "SLIDE_ROW", row: 1 });
```

Rules:

- Slides are fixed at `1920×1080`.
- Do not resize or rotate slides.
- Slides may ignore custom names and keep automatic numbering.
- Read the grid after create, clone, move, or delete.

## Grid movement

Use `labor_run_script`:

```js
figma.moveNodesToCoord(["SLIDE_ID"], 1, 0);
return figma.getCanvasGrid().map((row) => row.map((slide) => slide.id));
```

Use `figma.getCanvasGrid()` and `figma.setCanvasGrid()`. Do not build new code on deprecated slide-grid APIs.

## Skipped slides

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
slide.isSkippedSlide = true;
return { id: slide.id, isSkippedSlide: slide.isSkippedSlide };
```

Re-read the slide and test undo after changing skipped state.

## Transitions

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
slide.setSlideTransition({
  style: "DISSOLVE",
  duration: 0.5,
  curve: "EASE_IN_AND_OUT",
  timing: { type: "ON_CLICK" },
});
return slide.getSlideTransition();
```

To clear a transition, use `style: "NONE"`. The setter still requires `duration >= 0.01`, even when existing cleared transitions report `0`.

## Interactive elements

`INTERACTIVE_SLIDE_ELEMENT` nodes are read/move-only through the Plugin API.

Subtypes:

- `POLL`
- `EMBED`
- `FACEPILE`
- `ALIGNMENT`
- `YOUTUBE`

Do not attempt to create or edit their interactive content.

## Verification

Desktop MCP screenshots may reject Slides files. Use:

- `labor_get_node`
- `labor_get_children`
- `labor_zoom_to_node`
- `figma.getCanvasGrid()` through `labor_run_script`

Check:

- Content parent is the intended slide
- Grid row and column are correct
- Skipped state and transitions serialize correctly
- Original slides remain intact
- Temporary slides, rows, and content are removed

## Limits

- No components, variants, variables, styles, or libraries.
- Native FigJam nodes are unavailable.
- Interactive slide elements cannot be created.
- Call `labor_undo` immediately after a wrong mutation.
