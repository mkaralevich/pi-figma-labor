---
name: figma-design-system
description: Use when the user wants to create, edit, or inspect design system elements in Figma — variables, tokens, color systems, spacing scales, themes, light/dark modes, components, variants, component properties, component sets, text styles, effect styles. Covers variable collections, scoping, aliasing, code syntax, component creation with combineAsVariants, INSTANCE_SWAP, and design token architecture.
---

# Figma Design System

Work with variables, tokens, components, variants, and styles using labor tools.

## Core workflow

- Do not treat DS work as a one-shot task
- Break work into the smallest useful validated step
- Read first, then create or update
- Verify the first correct pattern before batching
- Use this verification pattern:
  - `mcp: get_screenshot`
  - `labor: labor_zoom_to_node` + manual inspect

## Discovery first

- Always check what already exists before creating anything
- Keep reads tight
- Prefer local inspection over broad scans
- Inspect existing screens and instances first when they already use the target design system
- For most DS tasks, inspect only:
  - target collection, component, or style
  - one nearby good reference
  - one existing screen or instance using the same system when available
  - then apply the same pattern

## Reuse priority

- Follow this order strictly:
  1. connected library assets already enabled in the file
  2. existing local assets in the file
  3. new local assets you create
- This applies to variables, styles, components, and variants
- Do not create new local tokens or styles until steps 1 and 2 have both been checked
- If remote discovery is limited by permissions or API access, inspect existing instances, `boundVariables`, style IDs, and remote main components before creating anything new
- If the user asks to use a design library, connected tokens, or existing styles, creating new local DS assets is a last resort

## Variables and tokens

### Discover local collections

- Read collections before creating new ones

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
return collections.map((collection) => ({
	name: collection.name,
	id: collection.id,
	varCount: collection.variableIds.length,
	modes: collection.modes.map((mode) => mode.name),
}));
```

### Discover local variables in one collection

```js
const vars = await figma.variables.getLocalVariablesAsync();
const filtered = vars.filter((variable) => variable.variableCollectionId === "COLLECTION_ID");
return filtered.map((variable) => ({
	name: variable.name,
	id: variable.id,
	resolvedType: variable.resolvedType,
	scopes: variable.scopes,
	valuesByMode: variable.valuesByMode,
}));
```

### Remote and library variables

- `getLocalVariablesAsync()` only shows variables defined in the current file
- Check remote and connected library variables before local variables when the task mentions a library, tokens, styles, or an existing design system
- For library variables:
  - `mcp: search_design_system`
  - `labor: labor_run_script` to inspect existing bound variables in the file
- If direct library enumeration is unavailable, do not assume the library is absent
  - inspect existing instances that use remote components
  - inspect `boundVariables` on fills, strokes, text, effects, and layout props
  - inspect remote main components and their children for variable bindings
  - only fall back to local variables after these checks

### Team library variables

- Native plugin API path for enabled libraries:
  - `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()`
  - `figma.teamLibrary.getVariablesInLibraryCollectionAsync(collectionKey)`
- Libraries must already be enabled in the file UI
- This is the native alternative to `mcp: search_design_system` for variable discovery

```js
const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
return collections.map((collection) => ({
	name: collection.name,
	key: collection.key,
	libraryName: collection.libraryName,
}));
```

### Create a collection

```js
const collection = figma.variables.createVariableCollection("Primitives");
collection.renameMode(collection.modes[0].modeId, "Value");
return { collectionId: collection.id, modeId: collection.modes[0].modeId };
```

### Add modes

```js
const collection = await figma.variables.getVariableCollectionByIdAsync("COLLECTION_ID");
const darkModeId = collection.addMode("Dark");
collection.renameMode(collection.modes[0].modeId, "Light");
return { lightModeId: collection.modes[0].modeId, darkModeId };
```

### Create variables

```js
const collection = await figma.variables.getVariableCollectionByIdAsync("COLLECTION_ID");
const modeId = collection.modes[0].modeId;

const bgPrimary = figma.variables.createVariable("color/bg/primary", collection, "COLOR");
bgPrimary.setValueForMode(modeId, { r: 1, g: 1, b: 1, a: 1 });

const spacingSm = figma.variables.createVariable("spacing/sm", collection, "FLOAT");
spacingSm.setValueForMode(modeId, 8);

return { bgPrimaryId: bgPrimary.id, spacingSmId: spacingSm.id };
```

### Set scopes

- Do not leave variables on `ALL_SCOPES`
- Use the narrowest practical scope

| Token type | Scopes |
|---|---|
| Background colors | `FRAME_FILL`, `SHAPE_FILL` |
| Text colors | `TEXT_FILL` |
| Border colors | `STROKE_COLOR` |
| Spacing | `GAP` |
| Corner radius | `CORNER_RADIUS` |
| Width or height | `WIDTH_HEIGHT` |
| Opacity | `OPACITY` |
| Font size or weight | `FONT_SIZE`, `FONT_WEIGHT` |
| Raw primitives | `[]` |

```js
const variable = await figma.variables.getVariableByIdAsync("VAR_ID");
variable.scopes = ["FRAME_FILL", "SHAPE_FILL"];
return "scopes set";
```

### Set code syntax

- Web syntax should use `var(...)`
- Android and iOS usually use raw token references

```js
const variable = await figma.variables.getVariableByIdAsync("VAR_ID");
variable.setVariableCodeSyntax("WEB", "var(--color-bg-primary)");
variable.setVariableCodeSyntax("ANDROID", "colorBgPrimary");
variable.setVariableCodeSyntax("iOS", "Color.bgPrimary");
return "code syntax set";
```

### Alias semantic tokens to primitives

- Do not duplicate raw values in semantic tokens
- Alias semantics to primitives

```js
const semanticCollection = await figma.variables.getVariableCollectionByIdAsync("SEMANTIC_COLLECTION_ID");
const lightModeId = semanticCollection.modes[0].modeId;
const darkModeId = semanticCollection.modes[1].modeId;

const primitiveWhite = await figma.variables.getVariableByIdAsync("PRIMITIVE_WHITE_ID");
const primitiveGray900 = await figma.variables.getVariableByIdAsync("PRIMITIVE_GRAY900_ID");

const bgPrimary = figma.variables.createVariable("color/bg/primary", semanticCollection, "COLOR");
bgPrimary.setValueForMode(lightModeId, { type: "VARIABLE_ALIAS", id: primitiveWhite.id });
bgPrimary.setValueForMode(darkModeId, { type: "VARIABLE_ALIAS", id: primitiveGray900.id });

return { id: bgPrimary.id };
```

### Bind variables to nodes

- Spacing, radius, and dimensions use direct binding
- Paints require `setBoundVariableForPaint()` and reassignment

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const spacingVar = await figma.variables.getVariableByIdAsync("SPACING_VAR_ID");
node.setBoundVariable("paddingLeft", spacingVar);
node.setBoundVariable("paddingRight", spacingVar);
node.setBoundVariable("itemSpacing", spacingVar);
node.setBoundVariable("topLeftRadius", spacingVar);

const colorVar = await figma.variables.getVariableByIdAsync("COLOR_VAR_ID");
const basePaint = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
const boundPaint = figma.variables.setBoundVariableForPaint(basePaint, "color", colorVar);
node.fills = [boundPaint];

return "bindings set";
```

### Inspect bound variables

- Audit existing DS files through `boundVariables`
- Useful reads:
  - `node.boundVariables`
  - `style.boundVariables`
  - `variable.resolveForConsumer(node)`

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
return {
	boundVariables: node.boundVariables,
	fills: node.fills,
	strokes: node.strokes,
};
```

### Typography variables

- Typography tokens can bind to:
  - `fontFamily`
  - `fontStyle`
  - `fontWeight`
  - `lineHeight`
  - `letterSpacing`
  - `paragraphSpacing`
  - `paragraphIndent`
- For partial text ranges, use `setRangeBoundVariable()`
- For audits, use `getRangeBoundVariable()` or `getStyledTextSegments(['boundVariables'])`
- Text styles can also bind typography variables with `TextStyle.setBoundVariable()`

```js
const collection = figma.variables.createVariableCollection("type");
const modeId = collection.modes[0].modeId;
const fontFamilyVar = figma.variables.createVariable("font/family/base", collection, "STRING");
fontFamilyVar.setValueForMode(modeId, "Roboto");

await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Roboto", style: "Regular" });

const text = figma.createText();
text.characters = "Hello world";
text.setBoundVariable("fontFamily", fontFamilyVar);

return { textId: text.id, boundVariables: text.boundVariables };
```

### Variable-bound effects and layout grids

- Effects and layout grids use helper functions plus immutable reassignment
- Useful for shadow, blur, and grid token systems

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const radiusVar = await figma.variables.getVariableByIdAsync("RADIUS_VAR_ID");
const countVar = await figma.variables.getVariableByIdAsync("COUNT_VAR_ID");

const effects = JSON.parse(JSON.stringify(node.effects));
effects[0] = figma.variables.setBoundVariableForEffect(effects[0], "radius", radiusVar);
node.effects = effects;

const grids = JSON.parse(JSON.stringify(node.layoutGrids));
grids[0] = figma.variables.setBoundVariableForLayoutGrid(grids[0], "count", countVar);
node.layoutGrids = grids;

return "effect and grid bindings set";
```

### Import library variables

```js
const imported = await figma.variables.importVariableByKeyAsync("VARIABLE_KEY");
node.setBoundVariable("itemSpacing", imported);
return { id: imported.id, name: imported.name };
```

## Token architecture

- Small system:
  - one collection
  - two modes: light and dark
- Medium system:
  - primitives
  - semantic color
  - spacing
- Large system:
  - multiple semantic collections
  - multiple modes by theme, contrast, or brand

## Extended collections

- Enterprise-only feature
- Use extended collections for theming on top of a parent collection
- Key APIs:
  - `collection.extend(name)`
  - `figma.variables.extendLibraryCollectionByKeyAsync(key, name)`
  - `variable.valuesByModeForCollectionAsync(extendedCollection)`
  - `extendedCollection.variableOverrides`
- Use overrides instead of duplicating the parent collection

```js
const base = figma.variables.createVariableCollection("semantic");
const extended = base.extend("semantic/dark");
const modeId = extended.modes[0].modeId;
const variable = figma.variables.createVariable("color/text/primary", base, "COLOR");
variable.setValueForMode(base.modes[0].modeId, { r: 0, g: 0, b: 0, a: 1 });
variable.setValueForMode(modeId, { r: 1, g: 1, b: 1, a: 1 });
return { baseId: base.id, extendedId: extended.id };
```

## Components and variants

### Discovery

- Prefer dedicated labor tools when they fit
  - `labor_get_component_set_summary`
  - `labor_create_component_set`
- Good sequence:
  - inspect the target component
  - inspect one nearby reference set
  - create one working variant set
  - verify it
  - reuse the same recipe

```js
const results = [];
figma.currentPage.findAll((node) => {
	if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
		results.push({ name: node.name, type: node.type, id: node.id });
	}
	return false;
});
return results;
```

### Create a basic component

```js
await figma.loadFontAsync({ family: "Inter Variable", style: "Medium" });

const comp = figma.createComponent();
comp.name = "Button";
comp.layoutMode = "HORIZONTAL";
comp.primaryAxisSizingMode = "AUTO";
comp.counterAxisSizingMode = "AUTO";
comp.counterAxisAlignItems = "CENTER";
comp.paddingTop = 10;
comp.paddingBottom = 10;
comp.paddingLeft = 16;
comp.paddingRight = 16;
comp.cornerRadius = 8;
comp.fills = [{ type: "SOLID", color: { r: 0.24, g: 0.36, b: 0.96 } }];

const label = figma.createText();
label.fontName = { family: "Inter Variable", style: "Medium" };
label.characters = "Button";
label.fontSize = 14;
label.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
comp.appendChild(label);

return { componentId: comp.id };
```

### Create variants

- Create separate `COMPONENT` nodes first
- Then combine them into a set
- If only combining is missing, prefer `labor_create_component_set`

```js
await figma.loadFontAsync({ family: "Inter Variable", style: "Medium" });

const variants = [];
const configs = [
	{ variant: "Primary", fill: { r: 0.24, g: 0.36, b: 0.96 }, textFill: { r: 1, g: 1, b: 1 } },
	{ variant: "Secondary", fill: { r: 0.95, g: 0.95, b: 0.97 }, textFill: { r: 0, g: 0, b: 0 } },
];

for (const cfg of configs) {
	const comp = figma.createComponent();
	comp.name = `Variant=${cfg.variant}`;
	comp.layoutMode = "HORIZONTAL";
	comp.primaryAxisSizingMode = "AUTO";
	comp.counterAxisSizingMode = "AUTO";
	comp.counterAxisAlignItems = "CENTER";
	comp.paddingTop = 10;
	comp.paddingBottom = 10;
	comp.paddingLeft = 16;
	comp.paddingRight = 16;
	comp.cornerRadius = 8;
	comp.fills = [{ type: "SOLID", color: cfg.fill }];

	const label = figma.createText();
	label.fontName = { family: "Inter Variable", style: "Medium" };
	label.characters = "Button";
	label.fontSize = 14;
	label.fills = [{ type: "SOLID", color: cfg.textFill }];
	comp.appendChild(label);

	variants.push(comp);
}

const compSet = figma.combineAsVariants(variants, figma.currentPage);
compSet.name = "Button";
return { compSetId: compSet.id, variantIds: variants.map((variant) => variant.id) };
```

### Layout variants after combine

- `combineAsVariants()` often stacks children at `(0,0)`
- Re-layout in a second script

```js
const compSet = await figma.getNodeByIdAsync("COMP_SET_ID");
let x = 0;
for (const child of compSet.children) {
	child.x = x;
	child.y = 0;
	x += child.width + 20;
}
compSet.resize(x - 20, compSet.children[0].height);
return "variants laid out";
```

### Icon size variants

- For icon size work:
  - read the source icon structure
  - read one reference set that already uses `size`
  - create one set
  - verify it
  - repeat for others
- Common pattern:
  - keep original as medium
  - clone for small and large
  - resize frame
  - rescale inner vector or group
  - recenter content
  - update stroke weights
  - combine into variants

```js
const original = await figma.getNodeByIdAsync("ICON_COMPONENT_ID");

const setStrokes = (node, stroke) => {
	if ("children" in node) node.children.forEach((child) => setStrokes(child, stroke));
	if (node.type === "VECTOR") node.strokeWeight = stroke;
};

const configs = [
	{ name: "size=medium", size: 24, scale: 1, stroke: 1.5, node: original },
	{ name: "size=small", size: 16, scale: 16 / 24, stroke: 1.2, node: original.clone() },
	{ name: "size=large", size: 36, scale: 36 / 24, stroke: 1.8, node: original.clone() },
];

for (const current of configs) {
	const comp = current.node;
	const icon = comp.children[0];
	comp.name = current.name;
	comp.resizeWithoutConstraints(current.size, current.size);
	if (current.scale !== 1) icon.rescale(current.scale);
	icon.x = (current.size - icon.width) / 2;
	icon.y = (current.size - icon.height) / 2;
	setStrokes(comp, current.stroke);
}

const set = figma.combineAsVariants(configs.map((config) => config.node), original.parent);
set.name = "icons/MyIcon";
return { setId: set.id };
```

## Component properties

### Add properties

- Use text properties for labels
- Use boolean properties for visibility
- Use instance swap instead of icon-per-variant patterns

```js
const comp = await figma.getNodeByIdAsync("COMPONENT_ID");
comp.addComponentProperty("label", "TEXT", "Button");
comp.addComponentProperty("showIcon", "BOOLEAN", true);
comp.addComponentProperty("icon", "INSTANCE_SWAP", "DEFAULT_COMPONENT_ID", {
	preferredValues: [{ type: "COMPONENT", key: "ICON_COMPONENT_KEY" }],
});
return "properties added";
```

### Link properties to child nodes

```js
const comp = await figma.getNodeByIdAsync("COMPONENT_ID");
const label = comp.findOne((node) => node.type === "TEXT" && node.name === "Label");
const icon = comp.findOne((node) => node.type === "INSTANCE" && node.name === "Icon");

label.componentPropertyReferences = { characters: "label" };
icon.componentPropertyReferences = { visible: "showIcon" };
icon.componentPropertyReferences = { mainComponent: "icon" };

return "properties linked";
```

### Component property tokens

- Component property definitions can also be tokenized
- Inspect `componentPropertyDefinitions[property].boundVariables.defaultValue`
- Useful when default prop values should follow tokens

```js
const comp = await figma.getNodeByIdAsync("COMPONENT_ID");
return comp.componentPropertyDefinitions;
```

### Override instance properties

- `instance.setProperties()` is usually more reliable than editing inner text directly
- Use exact property keys such as `label#123:456`

```js
const instance = await figma.getNodeByIdAsync("INSTANCE_ID");
instance.setProperties({ "label#123:456": "Click me" });
return "text overridden";
```

### Variant matrix rule

- If combinations go much beyond 30, split the component
- Example:
  - `ButtonBase` for size and style
  - wrapper or state component for state handling

## Text styles

### Create a text style

```js
await figma.loadFontAsync({ family: "Inter Variable", style: "Bold" });

const style = figma.createTextStyle();
style.name = "Heading/H1";
style.fontName = { family: "Inter Variable", style: "Bold" };
style.fontSize = 32;
style.lineHeight = { unit: "PIXELS", value: 40 };
style.letterSpacing = { unit: "PIXELS", value: -0.5 };

return { styleId: style.id, name: style.name };
```

### Apply a local text style

```js
const node = await figma.getNodeByIdAsync("TEXT_NODE_ID");
const styles = await figma.getLocalTextStylesAsync();
const heading = styles.find((style) => style.name === "Heading/H1");
if (heading) node.textStyleId = heading.id;
return "style applied";
```

### Import a library text style

```js
const style = await figma.importStyleByKeyAsync("STYLE_KEY");
const node = await figma.getNodeByIdAsync("TEXT_NODE_ID");
node.textStyleId = style.id;
return "library style applied";
```

## Paint styles

### Create a paint style

- Use paint styles for reusable fills or color styles
- Paint styles are not limited to solid colors

```js
const style = figma.createPaintStyle();
style.name = "Color/Surface/Primary";
style.paints = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
return { styleId: style.id };
```

### Apply a paint style

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const styles = await figma.getLocalPaintStylesAsync();
const style = styles.find((item) => item.name === "Color/Surface/Primary");
if (style) node.fillStyleId = style.id;
return "paint style applied";
```

## Effect styles

- Current figma-labor validator may reject `effects[].blendMode`
- Workaround: omit `blendMode` from effect objects even if official Figma docs show it

### Create an effect style

```js
const style = figma.createEffectStyle();
style.name = "Shadow/Medium";
style.effects = [{
	type: "DROP_SHADOW",
	visible: true,
	radius: 16,
	color: { r: 0, g: 0, b: 0, a: 0.1 },
	offset: { x: 0, y: 4 },
	spread: 0,
	showShadowBehindNode: false,
}];
return { styleId: style.id };
```

### Apply an effect style

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const styles = await figma.getLocalEffectStylesAsync();
const shadow = styles.find((style) => style.name === "Shadow/Medium");
if (shadow) node.effectStyleId = shadow.id;
return "effect applied";
```

## Naming patterns

- Match the local file when it already has conventions
- If starting fresh, use concise patterns

### Variables

```txt
color/bg/primary
color/text/secondary
color/border/default
spacing/xs
spacing/sm
spacing/md
spacing/lg
radius/none
radius/sm
radius/md
radius/lg
radius/full
```

### Primitives

```txt
blue/50 → blue/900
gray/50 → gray/900
```

### Components

```txt
Button
Input
Card
Avatar
Badge
```

### Variants

```txt
Size=Medium, Style=Primary, State=Default
```

## Validation checklist

| Phase | Action | Validate with |
|---|---|---|
| Discovery | list collections, variables, components | `labor_run_script` read-only |
| Tokens | create collections, primitives, semantics, scopes, syntax | `labor_run_script` read-back |
| Components | create base, variants, properties, links, layout | `mcp: get_screenshot` \| `labor: labor_zoom_to_node` + manual inspect |
| Styles | create text and effect styles | `labor_run_script` read-back |
| Bindings | bind colors, spacing, radii | `mcp: get_screenshot` \| `labor: labor_get_node_full` + `labor_run_script` |

## Final checks

- Validate every step before building on it
- Verify the first good component pattern before batching the rest
- Prefer one validated working recipe over repeated re-discovery
