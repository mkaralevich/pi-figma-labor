---
name: figjam-create
description: Create and edit native FigJam content with Labor — stickies, shapes, connectors, code blocks, tables, and sections. Use for FigJam boards, workshops, diagrams, flowcharts, planning boards, and native FigJam updates.
---

# FigJam Create

Build native FigJam content with Labor tools.

## Workflow

1. Call `labor_get_selection`.
2. Confirm `figma.editorType === "figjam"` when unclear.
3. Inspect nearby nodes and open canvas space.
4. Create one native pattern first.
5. Verify the first pattern with `get_screenshot`, `get_figjam`, and a Labor read.
6. Batch the remaining nodes.
7. Run `get_screenshot` on the created or changed root node for the final visual audit.
8. Re-read affected nodes and remove temporary test nodes.

## Prefer native nodes

| Need            | Node              |
| --------------- | ----------------- |
| Note            | `STICKY`          |
| Diagram step    | `SHAPE_WITH_TEXT` |
| Relationship    | `CONNECTOR`       |
| Code sample     | `CODE_BLOCK`      |
| Structured grid | `TABLE`           |
| Board grouping  | `SECTION`         |

Use `labor_create_node`. Do not build FigJam diagrams from Design components.

## Placement

- Scan nearby top-level nodes before choosing coordinates.
- Create sections before their content.
- Pass `parentId` when content belongs in a section.
- Avoid reparenting finished nodes unless you also recalculate local coordinates.

```js
const nodes = figma.currentPage.children;
return nodes.slice(-20).map((n) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  x: n.x,
  y: n.y,
  w: n.width,
  h: n.height,
}));
```

## Connectors

Create endpoints by node ID:

```js
labor_create_node({
  type: "CONNECTOR",
  connectorLineType: "ELBOWED",
  startNodeId: "1:2",
  endNodeId: "1:3",
  text: "depends on",
});
```

Update with `labor_update_properties`:

- `connectorLineType`
- `connectorStartNodeId` / `connectorEndNodeId`
- `connectorStartMagnet` / `connectorEndMagnet`
- `connectorStartStrokeCap` / `connectorEndStrokeCap`

Rules:

- Straight connectors use `CENTER` or `NONE` magnets.
- Elbowed and curved connectors usually use `AUTO`.
- Re-read endpoints after every reassignment.

## Tables

Create with rows and columns:

```js
labor_create_node({ type: "TABLE", rows: 3, columns: 4 });
```

Use `labor_update_table` for:

- Insert/remove row or column
- Move row or column
- Resize row or column

Use `labor_get_children` to read cells. Cells include `rowIndex` and `columnIndex`. Update cell text with `labor_update_text`.

## Native properties

Use `labor_update_properties` for:

- Sticky `authorVisible` and `isWideWidth`
- Section `sectionContentsHidden`
- Code-block `codeLanguage`
- Connector endpoints, magnets, line type, and caps

Use `labor_update_text` for sticky, shape, connector, table-cell, and code-block content.

## Fonts

Dedicated text tools load required fonts. In `labor_run_script`, load fonts before changing embedded text.

- New connector labels need a valid fallback font.
- Code blocks require Source Code Pro Medium before assigning code.

## Verification

At the end, always run `get_screenshot` on the created or changed root node. Use it as the first visual audit because it exposes clipping, overlap, spacing, and alignment issues quickly.

Then verify structure and native FigJam properties with:

- `get_figjam({ nodeId, includeImagesOfNodes: true })`
- `labor_get_node`
- `labor_get_children`

If `get_screenshot` is unavailable, use the image from `get_figjam` or `labor_zoom_to_node` for manual inspection.

Check:

- Text is present
- Connector endpoints are correct
- Table dimensions and cell indexes are correct
- Section visibility is correct
- No temporary nodes remain

## Limits

- Components, variants, variables, and design libraries are Design-only.
- Widgets, stamps, highlights, and embeds may be inspectable without being creatable.
- Call `labor_undo` immediately after a wrong mutation.
