---
name: figma-select
description: Use when the user wants to find, select, filter, list, enumerate, inspect, read, extract, audit, or batch-select nodes in Figma — by name, type, property, variant, style, text content, variable binding, or spatial relationship. Covers searching the layer tree, listing node names, selecting multiple nodes, filtering by criteria, reading structure, extracting styles, inspecting variable bindings, and navigating complex component hierarchies.
---

# Figma Select & Inspect

Instructions for finding, selecting, and inspecting nodes on the Figma canvas using
figma-labor tools.

## Key principle: discover structure first, extract second

**STRICT RULE: Do NOT attempt any name listing, property reading, or data extraction
before you have seen the tree structure. Your first `figma_run_script` call MUST be a
structure discovery call.** No exceptions.

Step 1 — discover the shape (always do this first):

```js
const root = await figma.getNodeByIdAsync("NODE_ID");
function walk(node, depth) {
  const info = { name: node.name, type: node.type, id: node.id };
  if (node.type === "TEXT") info.chars = node.characters;
  if (depth > 0 && "children" in node) {
    info.children = node.children.map(c => walk(c, depth - 1));
  }
  return info;
}
return walk(root, 2);
```

Step 2 — read the discovery output carefully. If the structure already reveals the
data you need (e.g. TEXT nodes with characters, COMPONENT_SET names), write one
batch extraction call. **Do NOT drill into individual items to "confirm" — the
discovery output is your confirmation.**

**Target: 1 discovery call + 1 extraction call = 2 `figma_run_script` calls total.
Every additional call is a failure.**

## Core tools

| Tool | Use for |
|---|---|
| `figma_get_selection` | Read what the user currently has selected |
| `figma_get_children` | List direct children of a node (or current page if omitted) |
| `figma_get_node` | Get properties of a known node by ID |
| `figma_get_node_full` | Get all properties including layout, constraints, padding |
| `figma_select_node` | Select a node and zoom viewport to it |
| `figma_run_script` | Advanced queries — `findAll`, `findOne`, multi-select, inspection |

## Selecting a single node

```js
// figma_select_node is the simplest — takes a nodeId, selects it, zooms to it
figma_select_node({ nodeId: "123:456" })
```

## Selecting multiple nodes

`figma_select_node` only selects one. For multi-select, use `figma_run_script`:

```js
const ids = ["123:456", "123:457", "123:458"];
const nodes = [];
for (const id of ids) {
  const n = await figma.getNodeByIdAsync(id);
  if (n) nodes.push(n);
}
figma.currentPage.selection = nodes;
figma.viewport.scrollAndZoomIntoView(nodes);
return `Selected ${nodes.length} nodes`;
```

## Finding nodes by name

```js
// Exact match
const nodes = figma.currentPage.findAll(n => n.name === "Button");

// Contains
const nodes = figma.currentPage.findAll(n => n.name.includes("icon"));

// Regex
const nodes = figma.currentPage.findAll(n => /^Header\//.test(n.name));
```

## Finding nodes by type

```js
// All text nodes
const texts = figma.currentPage.findAll(n => n.type === "TEXT");

// All instances of a specific component
const instances = figma.currentPage.findAll(n => n.type === "INSTANCE");
const filtered = [];
for (const inst of instances) {
  const main = await inst.getMainComponentAsync();
  if (main?.parent?.name === "Button") filtered.push(inst);
}
```

## Finding nodes by property

```js
// Nodes with a specific fill color
const red = figma.currentPage.findAll(n =>
  "fills" in n && Array.isArray(n.fills) &&
  n.fills.some(f => f.type === "SOLID" && f.color.r > 0.9 && f.color.g < 0.1)
);

// Hidden nodes
const hidden = figma.currentPage.findAll(n => n.visible === false);

// Nodes with specific opacity
const faded = figma.currentPage.findAll(n => n.opacity < 0.5);
```

## Finding nodes by text content

```js
const query = "Submit";
const texts = figma.currentPage.findAll(
  n => n.type === "TEXT" && n.characters.includes(query)
);
figma.currentPage.selection = texts;
return texts.map(t => ({ id: t.id, text: t.characters }));
```

## Async node access

Always use async node access in `figma_run_script`:

```js
// Correct
const node = await figma.getNodeByIdAsync("123:456");

// Wrong — throws with documentAccess: dynamic-page
const node = figma.getNodeById("123:456");
```

## Scoping searches

Never search the entire page on large files. Scope to a known parent:

```js
const frame = await figma.getNodeByIdAsync("123:456");
const texts = frame.findAll(n => n.type === "TEXT");
```

**Exception:** `findAll` on INSTANCE nodes crashes the proxy. Use the page-level
workaround:

```js
const instanceId = "I123:456";
const children = figma.currentPage.findAll(
  n => n.id.startsWith(instanceId + ";")
);
```

---

## Inspection patterns

### Extract all styles from a frame

Extract fills, effects, text styles, and corner radii from a subtree to understand
or reproduce the design language:

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const styles = { fills: new Map(), effects: [], fonts: new Map(), radii: new Set() };

root.findAll(n => {
  // Fills
  if ("fills" in n && Array.isArray(n.fills)) {
    for (const f of n.fills) {
      if (f.type === "SOLID" && f.visible !== false) {
        const key = `${f.color.r.toFixed(3)},${f.color.g.toFixed(3)},${f.color.b.toFixed(3)},${f.opacity ?? 1}`;
        styles.fills.set(key, { color: f.color, opacity: f.opacity ?? 1 });
      }
    }
  }
  // Effects
  if ("effects" in n && n.effects?.length) {
    for (const e of n.effects) {
      styles.effects.push({ type: e.type, radius: e.radius });
    }
  }
  // Fonts
  if (n.type === "TEXT") {
    const fn = n.fontName;
    if (fn && fn !== figma.mixed) {
      const key = `${fn.family}/${fn.style}/${n.fontSize}`;
      styles.fonts.set(key, { family: fn.family, style: fn.style, size: n.fontSize });
    }
  }
  // Corner radii
  if ("cornerRadius" in n && n.cornerRadius > 0) {
    styles.radii.add(n.cornerRadius);
  }
  return false;
});

return {
  fills: [...styles.fills.values()],
  fonts: [...styles.fonts.values()],
  radii: [...styles.radii],
  effectTypes: [...new Set(styles.effects.map(e => e.type))],
};
```

### Extract bound variables from a subtree

Find all design variables used in a frame — colors, spacing, radii:

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const varMap = new Map();

const nodes = root.findAll(() => true);
for (const node of nodes) {
  const bv = node.boundVariables;
  if (!bv) continue;
  for (const [prop, binding] of Object.entries(bv)) {
    const bindings = Array.isArray(binding) ? binding : [binding];
    for (const b of bindings) {
      if (b?.id && !varMap.has(b.id)) {
        const v = await figma.variables.getVariableByIdAsync(b.id);
        if (v) varMap.set(b.id, {
          name: v.name, id: v.id, key: v.key,
          type: v.resolvedType, remote: v.remote,
          boundTo: prop, onNode: node.name
        });
      }
    }
  }
}
return [...varMap.values()];
```

### Extract component map from a frame

Find all unique components used as instances inside a frame:

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const uniqueSets = new Map();

const instances = root.findAll(n => n.type === "INSTANCE");
for (const inst of instances) {
  const mc = await inst.getMainComponentAsync();
  if (!mc) continue;
  const cs = mc.parent?.type === "COMPONENT_SET" ? mc.parent : null;
  const key = cs ? cs.id : mc.id;
  const name = cs ? cs.name : mc.name;
  if (!uniqueSets.has(key)) {
    uniqueSets.set(key, {
      name, id: key, isSet: !!cs,
      sampleVariant: mc.name, instanceCount: 1
    });
  } else {
    uniqueSets.get(key).instanceCount++;
  }
}
return [...uniqueSets.values()];
```

### Extract applied text and effect styles

Find all text styles and effect styles used in a frame:

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const styles = { text: new Map(), effect: new Map() };

root.findAll(n => {
  if ("textStyleId" in n && n.textStyleId) {
    const s = figma.getStyleById(n.textStyleId);
    if (s) styles.text.set(s.id, { name: s.name, id: s.id, key: s.key });
  }
  if ("effectStyleId" in n && n.effectStyleId) {
    const s = figma.getStyleById(n.effectStyleId);
    if (s) styles.effect.set(s.id, { name: s.name, id: s.id, key: s.key });
  }
  return false;
});

return {
  textStyles: [...styles.text.values()],
  effectStyles: [...styles.effect.values()],
};
```

### Audit auto-layout properties

Read the full layout configuration of a frame and its children:

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
function layoutInfo(n) {
  if (!("layoutMode" in n) || n.layoutMode === "NONE") return null;
  return {
    name: n.name, id: n.id,
    layoutMode: n.layoutMode,
    primaryAxisSizingMode: n.primaryAxisSizingMode,
    counterAxisSizingMode: n.counterAxisSizingMode,
    primaryAxisAlignItems: n.primaryAxisAlignItems,
    counterAxisAlignItems: n.counterAxisAlignItems,
    itemSpacing: n.itemSpacing,
    paddingTop: n.paddingTop, paddingRight: n.paddingRight,
    paddingBottom: n.paddingBottom, paddingLeft: n.paddingLeft,
    children: n.children?.length,
  };
}
const layouts = [];
root.findAll(n => {
  const info = layoutInfo(n);
  if (info) layouts.push(info);
  return false;
});
return layouts;
```

---

## Working with COMPONENT_SETs and variants

A COMPONENT_SET contains multiple COMPONENT children (variants). **Never assume there
is only one variant.** Always check `componentPropertyDefinitions` or iterate children.

```js
const compSet = await figma.getNodeByIdAsync("COMP_SET_ID");
return {
  name: compSet.name,
  propDefs: compSet.componentPropertyDefinitions,
  variants: compSet.children.map(v => ({ id: v.id, name: v.name }))
};
```

When instantiating from a COMPONENT_SET:
- Find the COMPONENT child whose `name` matches the desired property combo
  (e.g. `"size=medium, variant=outline"`)
- **Ask the user which variants they want if the task is ambiguous**

## Navigating component hierarchies

```js
let current = await figma.getNodeByIdAsync("123:456");
while (current && current.type !== "COMPONENT" && current.type !== "COMPONENT_SET") {
  current = current.parent;
}
return current ? { type: current.type, name: current.name, id: current.id } : null;
```

## Common patterns

**Select all instances of a component on the page:**

```js
const componentName = "Card";
const instances = figma.currentPage.findAll(n => n.type === "INSTANCE");
const matches = [];
for (const inst of instances) {
  const main = await inst.getMainComponentAsync();
  if (main?.name === componentName || main?.parent?.name === componentName) {
    matches.push(inst);
  }
}
figma.currentPage.selection = matches;
figma.viewport.scrollAndZoomIntoView(matches);
return `Selected ${matches.length} instances of ${componentName}`;
```

**Select all direct children of selected frame:**

```js
const sel = figma.currentPage.selection[0];
if (!sel || !("children" in sel)) return "Select a frame first";
figma.currentPage.selection = [...sel.children];
return `Selected ${sel.children.length} children`;
```

**Batch-read repeated structures (icons, cards, rows, etc.):**

```js
const frame = await figma.getNodeByIdAsync("FRAME_ID");
if (!frame || !("children" in frame)) return "not a frame";
return frame.children.map(c => ({
  name: c.children?.find(n => n.type === "TEXT")?.characters,
  componentId: c.children?.find(n => n.type !== "TEXT")?.id
}));
```

This pattern works for any repeated structure — table rows, card lists, nav items.
**One script call to read N items, not N tool calls.**
