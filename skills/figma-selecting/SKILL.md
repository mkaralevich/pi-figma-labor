---
name: figma-selecting
description: Use when the user wants to find, select, filter, list, enumerate, inspect, read, extract, or batch-select nodes in Figma — by name, type, property, variant, style, text content, or spatial relationship. Covers searching the layer tree, listing node names, selecting multiple nodes, filtering by criteria, reading structure, and navigating complex component hierarchies.
---

# Figma Selecting

Instructions for finding and selecting nodes on the Figma canvas using figma-labor tools.

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
| `figma_select_node` | Select a node and zoom viewport to it |
| `figma_run_script` | Advanced queries — `findAll`, `findOne`, multi-select |

## Selecting a single node

```js
// figma_select_node is the simplest — takes a nodeId, selects it, zooms to it
figma_select_node({ nodeId: "123:456" })
```

## Selecting multiple nodes

`figma_select_node` only selects one. For multi-select, use `figma_run_script`:

```js
// Select multiple nodes by ID
const ids = ["123:456", "123:457", "123:458"];
const nodes = ids.map(id => figma.getNodeById(id)).filter(Boolean);
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
const instances = figma.currentPage.findAll(
  n => n.type === "INSTANCE" && n.mainComponent?.parent?.name === "Button"
);
```

Note: `n.mainComponent` can return null in the plugin proxy. For reliable access:
```js
// Use async variant inside figma_run_script
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

## Async node access

In `figma_run_script`, always use async node access:
```js
// Correct
const node = await figma.getNodeByIdAsync("123:456");

// Wrong — throws with documentAccess: dynamic-page
const node = figma.getNodeById("123:456");
```

This applies to all `getNodeById` calls. The sync variant is blocked by Figma's
dynamic-page document access mode.

## Scoping searches

Never search the entire page on large files. Scope to a known parent:

```js
// Search within a specific frame
const frame = figma.getNodeById("123:456");
const texts = frame.findAll(n => n.type === "TEXT");
```

**Exception:** `findAll` on INSTANCE nodes crashes the proxy. Use the page-level workaround:
```js
// Find children of a specific instance
const instanceId = "I123:456";
const children = figma.currentPage.findAll(
  n => n.id.startsWith(instanceId + ";")
);
```

## Working with COMPONENT_SETs and variants

A COMPONENT_SET contains multiple COMPONENT children (variants). **Never assume there
is only one variant.** Always check `componentPropertyDefinitions` or iterate all children.

```js
// Discover variant structure
const compSet = await figma.getNodeByIdAsync("COMP_SET_ID");
return {
  name: compSet.name,
  propDefs: compSet.componentPropertyDefinitions,
  variants: compSet.children.map(v => ({ id: v.id, name: v.name }))
};
```

When instantiating from a COMPONENT_SET:
- To get a specific variant, find the COMPONENT child whose `name` matches the
  desired property combo (e.g. `"size=medium, variant=outline"`)
- To get all variants, iterate `compSet.children` and call `variant.createInstance()`
  on each
- **Ask the user which variants they want if the task is ambiguous**

## Navigating component hierarchies

To find which component a node belongs to:
```js
let current = figma.getNodeById("123:456");
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

When a frame contains many identically-structured children, never drill into each one
with separate `figma_get_children` calls. Use a single `figma_run_script` to extract
everything in one round-trip:

```js
// Example: icon grid where each child is { COMPONENT_SET, TEXT label }
const frame = await figma.getNodeByIdAsync("FRAME_ID");
if (!frame || !("children" in frame)) return "not a frame";
return frame.children.map(c => ({
  name: c.children.find(n => n.type === "TEXT")?.characters,
  componentId: c.children.find(n => n.type !== "TEXT")?.id
}));
// → [{ name: "QuestionCircle", componentId: "2013:11858" }, ...]
```

This pattern works for any repeated structure — table rows, card lists, nav items.
Adapt the inner mapping to match the actual child layout. The key rule:
**one script call to read N items, not N tool calls.**

**Find nodes by text content:**
```js
const query = "Submit";
const texts = figma.currentPage.findAll(
  n => n.type === "TEXT" && n.characters.includes(query)
);
figma.currentPage.selection = texts;
return texts.map(t => ({ id: t.id, text: t.characters }));
```
