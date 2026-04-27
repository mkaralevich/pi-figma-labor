---
name: figma-select
description: Use when the user wants to find, select, filter, list, enumerate, inspect, read, extract, audit, or batch-select nodes in Figma — by name, type, property, variant, style, text content, variable binding, or spatial relationship. Covers searching the layer tree, listing node names, selecting multiple nodes, filtering by criteria, reading structure, extracting styles, inspecting variable bindings, and navigating complex component hierarchies.
---

# Figma Select

Find, inspect, and batch-read Figma nodes with labor tools.

## Core workflow

- Discover structure first
- Extract second
- Keep reads tight
- Prefer one discovery call and one extraction call
- Avoid drilling into many items one by one

## Discovery first

- First `labor_run_script` call should show structure
- Do not start with random property reads
- Often a shallow tree is enough to answer the task
- Good target:
  - 1 discovery call
  - 1 extraction call

```js
const root = await figma.getNodeByIdAsync("NODE_ID");

function walk(node, depth) {
	const info = { name: node.name, type: node.type, id: node.id };
	if (node.type === "TEXT") info.chars = node.characters;
	if (depth > 0 && "children" in node) {
		info.children = node.children.map((child) => walk(child, depth - 1));
	}
	return info;
}

return walk(root, 2);
```

## Core tools

| Tool | Use for |
|---|---|
| `labor_get_selection` | read current selection |
| `labor_get_children` | list direct children |
| `labor_get_node` | read basic properties of a known node |
| `labor_get_node_full` | read full layout and constraint data |
| `labor_select_node` | select one node and zoom to it |
| `labor_run_script` | advanced search, filtering, inspection, batch reads |

## Selection patterns

### Select one node

```js
labor_select_node({ nodeId: "123:456" })
```

### Select multiple nodes

```js
const ids = ["123:456", "123:457", "123:458"];
const nodes = [];
for (const id of ids) {
	const node = await figma.getNodeByIdAsync(id);
	if (node) nodes.push(node);
}
figma.currentPage.selection = nodes;
figma.viewport.scrollAndZoomIntoView(nodes);
return `Selected ${nodes.length} nodes`;
```

### Select all direct children of a selected frame

```js
const selected = figma.currentPage.selection[0];
if (!selected || !("children" in selected)) return "Select a frame first";
figma.currentPage.selection = [...selected.children];
return `Selected ${selected.children.length} children`;
```

## Search patterns

### Find by name

```js
const exact = figma.currentPage.findAll((node) => node.name === "Button");
const contains = figma.currentPage.findAll((node) => node.name.includes("icon"));
const regex = figma.currentPage.findAll((node) => /^Header\//.test(node.name));
return {
	exact: exact.length,
	contains: contains.length,
	regex: regex.length,
};
```

### Find by type

```js
const texts = figma.currentPage.findAll((node) => node.type === "TEXT");
return texts.map((node) => ({ id: node.id, name: node.name, text: node.characters }));
```

### Find instances of one component

```js
const instances = figma.currentPage.findAll((node) => node.type === "INSTANCE");
const matches = [];
for (const instance of instances) {
	const main = await instance.getMainComponentAsync();
	if (main?.name === "Button" || main?.parent?.name === "Button") {
		matches.push({ id: instance.id, name: instance.name });
	}
}
return matches;
```

### Find by property

```js
const hidden = figma.currentPage.findAll((node) => node.visible === false);
const faded = figma.currentPage.findAll((node) => node.opacity < 0.5);
const red = figma.currentPage.findAll(
	(node) =>
		"fills" in node &&
		Array.isArray(node.fills) &&
		node.fills.some(
			(fill) => fill.type === "SOLID" && fill.color.r > 0.9 && fill.color.g < 0.1
		)
);
return {
	hidden: hidden.length,
	faded: faded.length,
	red: red.length,
};
```

### Find by text content

```js
const query = "Submit";
const texts = figma.currentPage.findAll(
	(node) => node.type === "TEXT" && node.characters.includes(query)
);
return texts.map((node) => ({ id: node.id, text: node.characters }));
```

## Search rules

- Always use async node access in `labor_run_script`
- Scope searches to a known parent when possible
- Avoid full-page scans on large files
- Do not use `figma.getNodeById()`; use `await figma.getNodeByIdAsync()`
- With dynamic-page loading, node-scoped searches are safer than whole-document scans

```js
const frame = await figma.getNodeByIdAsync("123:456");
const texts = frame.findAll((node) => node.type === "TEXT");
return texts.length;
```

## Instance caveat

- `findAll()` on `INSTANCE` nodes crashes the proxy
- Use page-level suffix matching instead
- For large instance-heavy reads, enable `figma.skipInvisibleInstanceChildren = true` when invisible descendants do not matter

```js
figma.skipInvisibleInstanceChildren = true;
const instanceId = "I123:456";
const children = figma.currentPage.findAll((node) => node.id.startsWith(instanceId + ";"));
return children.map((node) => ({ id: node.id, name: node.name, type: node.type }));
```

## Inspection patterns

### Extract styles from a subtree

- Good for understanding local design language
- Common outputs:
  - fills
  - fonts
  - corner radii
  - effect types

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const styles = { fills: new Map(), effects: [], fonts: new Map(), radii: new Set() };

root.findAll((node) => {
	if ("fills" in node && Array.isArray(node.fills)) {
		for (const fill of node.fills) {
			if (fill.type === "SOLID" && fill.visible !== false) {
				const key = `${fill.color.r.toFixed(3)},${fill.color.g.toFixed(3)},${fill.color.b.toFixed(3)},${fill.opacity ?? 1}`;
				styles.fills.set(key, { color: fill.color, opacity: fill.opacity ?? 1 });
			}
		}
	}

	if ("effects" in node && node.effects?.length) {
		for (const effect of node.effects) {
			styles.effects.push({ type: effect.type, radius: effect.radius });
		}
	}

	if (node.type === "TEXT") {
		const fontName = node.fontName;
		if (fontName && fontName !== figma.mixed) {
			const key = `${fontName.family}/${fontName.style}/${node.fontSize}`;
			styles.fonts.set(key, { family: fontName.family, style: fontName.style, size: node.fontSize });
		}
	}

	if ("cornerRadius" in node && node.cornerRadius > 0) {
		styles.radii.add(node.cornerRadius);
	}

	return false;
});

return {
	fills: [...styles.fills.values()],
	fonts: [...styles.fonts.values()],
	radii: [...styles.radii],
	effectTypes: [...new Set(styles.effects.map((effect) => effect.type))],
};
```

### Extract bound variables from a subtree

- Useful for DS audits
- Reads where variables are actually consumed

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const varMap = new Map();

const nodes = root.findAll(() => true);
for (const node of nodes) {
	const boundVariables = node.boundVariables;
	if (!boundVariables) continue;

	for (const [prop, binding] of Object.entries(boundVariables)) {
		const bindings = Array.isArray(binding) ? binding : [binding];
		for (const item of bindings) {
			if (item?.id && !varMap.has(item.id)) {
				const variable = await figma.variables.getVariableByIdAsync(item.id);
				if (variable) {
					varMap.set(item.id, {
						name: variable.name,
						id: variable.id,
						key: variable.key,
						type: variable.resolvedType,
						remote: variable.remote,
						boundTo: prop,
						onNode: node.name,
					});
				}
			}
		}
	}
}

return [...varMap.values()];
```

### Extract a component map from a subtree

- Finds unique components used inside a frame
- Good for audits and migration work

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const uniqueSets = new Map();

const instances = root.findAll((node) => node.type === "INSTANCE");
for (const instance of instances) {
	const main = await instance.getMainComponentAsync();
	if (!main) continue;
	const set = main.parent?.type === "COMPONENT_SET" ? main.parent : null;
	const key = set ? set.id : main.id;
	const name = set ? set.name : main.name;

	if (!uniqueSets.has(key)) {
		uniqueSets.set(key, {
			name,
			id: key,
			isSet: !!set,
			sampleVariant: main.name,
			instanceCount: 1,
		});
	} else {
		uniqueSets.get(key).instanceCount++;
	}
}

return [...uniqueSets.values()];
```

### Extract applied styles

- Read text styles and effect styles used in a subtree

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");
const styles = { text: new Map(), effect: new Map() };

for (const node of root.findAll(() => true)) {
	if ("textStyleId" in node && node.textStyleId) {
		const style = await figma.getStyleByIdAsync(node.textStyleId);
		if (style) styles.text.set(style.id, { name: style.name, id: style.id, key: style.key });
	}
	if ("effectStyleId" in node && node.effectStyleId) {
		const style = await figma.getStyleByIdAsync(node.effectStyleId);
		if (style) styles.effect.set(style.id, { name: style.name, id: style.id, key: style.key });
	}
}

return {
	textStyles: [...styles.text.values()],
	effectStyles: [...styles.effect.values()],
};
```

### Audit auto-layout

- Read auto-layout settings on a frame and its descendants
- Good for diagnosing spacing, padding, fill, and hug issues

```js
const root = await figma.getNodeByIdAsync("FRAME_ID");

function layoutInfo(node) {
	if (!("layoutMode" in node) || node.layoutMode === "NONE") return null;
	return {
		name: node.name,
		id: node.id,
		layoutMode: node.layoutMode,
		primaryAxisSizingMode: node.primaryAxisSizingMode,
		counterAxisSizingMode: node.counterAxisSizingMode,
		primaryAxisAlignItems: node.primaryAxisAlignItems,
		counterAxisAlignItems: node.counterAxisAlignItems,
		itemSpacing: node.itemSpacing,
		paddingTop: node.paddingTop,
		paddingRight: node.paddingRight,
		paddingBottom: node.paddingBottom,
		paddingLeft: node.paddingLeft,
		children: node.children?.length,
	};
}

const layouts = [];
root.findAll((node) => {
	const info = layoutInfo(node);
	if (info) layouts.push(info);
	return false;
});
return layouts;
```

## Component sets and variants

- Never assume a `COMPONENT_SET` has only one variant
- Always read variant children or `componentPropertyDefinitions`
- If the desired variant is ambiguous, ask the user

```js
const compSet = await figma.getNodeByIdAsync("COMP_SET_ID");
return {
	name: compSet.name,
	propDefs: compSet.componentPropertyDefinitions,
	variants: compSet.children.map((child) => ({ id: child.id, name: child.name })),
};
```

## Component hierarchy navigation

```js
let current = await figma.getNodeByIdAsync("123:456");
while (current && current.type !== "COMPONENT" && current.type !== "COMPONENT_SET") {
	current = current.parent;
}
return current ? { type: current.type, name: current.name, id: current.id } : null;
```

## Batch-read repeated structures

- Read repeated rows, cards, icons, or nav items in one pass
- Do not use one tool call per item

```js
const frame = await figma.getNodeByIdAsync("FRAME_ID");
if (!frame || !("children" in frame)) return "not a frame";
return frame.children.map((child) => ({
	name: child.children?.find((node) => node.type === "TEXT")?.characters,
	componentId: child.children?.find((node) => node.type !== "TEXT")?.id,
}));
```

## Quick recipes

### Select all instances of one component on the page

```js
const componentName = "Card";
const instances = figma.currentPage.findAll((node) => node.type === "INSTANCE");
const matches = [];
for (const instance of instances) {
	const main = await instance.getMainComponentAsync();
	if (main?.name === componentName || main?.parent?.name === componentName) {
		matches.push(instance);
	}
}
figma.currentPage.selection = matches;
figma.viewport.scrollAndZoomIntoView(matches);
return `Selected ${matches.length} instances of ${componentName}`;
```

### Read current selection colors quickly

```js
const colors = figma.getSelectionColors();
return colors
	? {
		paints: colors.paints.length,
		styles: colors.styles.map((style) => ({ id: style.id, name: style.name })),
	}
	: "No selection colors";
```

### Audit selection colors

- Use `figma.getSelectionColors()` for a fast color audit of the current selection
- Good for:
  - checking raw paints
  - checking applied paint styles
  - spotting color drift before deeper inspection

```js
const colors = figma.getSelectionColors();
if (!colors) return "No selection or too many colors";
return {
	paintCount: colors.paints.length,
	styleCount: colors.styles.length,
	styles: colors.styles.map((style) => ({ name: style.name, id: style.id })),
};
```

## Final rules

- Discover before extracting
- Use async APIs
- Scope reads whenever possible
- Prefer batch reads over repeated tool calls
- Read one good reference and reuse that pattern
