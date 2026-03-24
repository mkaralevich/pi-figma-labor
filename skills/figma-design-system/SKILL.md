---
name: figma-design-system
description: Use when the user wants to create, edit, or inspect design system elements in Figma — variables, tokens, color systems, spacing scales, themes, light/dark modes, components, variants, component properties, component sets, text styles, effect styles. Covers variable collections, scoping, aliasing, code syntax, component creation with combineAsVariants, INSTANCE_SWAP, and design token architecture.
---

# Figma Design System

Instructions for working with variables, tokens, components, variants, and styles
via `figma_run_script`.

**This is never a one-shot task.** Building design system elements requires multiple
`figma_run_script` calls with validation between them. Break every operation to the
smallest useful unit.

---

## Variables & tokens

### Discover before creating

**Always check what exists before creating variables.** Run a read-only script first:

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
return collections.map(c => ({
  name: c.name, id: c.id,
  varCount: c.variableIds.length,
  modes: c.modes.map(m => m.name)
}));
```

To list variables in a collection:

```js
const vars = await figma.variables.getLocalVariablesAsync();
const filtered = vars.filter(v => v.variableCollectionId === "COLLECTION_ID");
return filtered.map(v => ({
  name: v.name, id: v.id,
  resolvedType: v.resolvedType,
  scopes: v.scopes,
  valuesByMode: v.valuesByMode,
}));
```

**Important:** `getLocalVariablesAsync()` only returns variables defined in the
current file. Library/remote variables are invisible to this API. To find those,
use `search_design_system` with `includeVariables: true`, or inspect bound variables
on existing nodes (see figma-select skill).

### Create a variable collection

```js
const collection = figma.variables.createVariableCollection("Primitives");
// Rename the default mode
collection.renameMode(collection.modes[0].modeId, "Value");
return { collectionId: collection.id, modeId: collection.modes[0].modeId };
```

To add modes (e.g. Light/Dark):

```js
const collection = await figma.variables.getVariableCollectionByIdAsync("COLLECTION_ID");
const darkModeId = collection.addMode("Dark");
// First mode is Light by default
collection.renameMode(collection.modes[0].modeId, "Light");
return { lightModeId: collection.modes[0].modeId, darkModeId };
```

### Create variables

```js
const collection = await figma.variables.getVariableCollectionByIdAsync("COLLECTION_ID");
const modeId = collection.modes[0].modeId;

// Color variable
const bgPrimary = figma.variables.createVariable("color/bg/primary", collection, "COLOR");
bgPrimary.setValueForMode(modeId, { r: 1, g: 1, b: 1, a: 1 });

// Float variable (spacing, radius)
const spacingSm = figma.variables.createVariable("spacing/sm", collection, "FLOAT");
spacingSm.setValueForMode(modeId, 8);

return { bgPrimaryId: bgPrimary.id, spacingSmId: spacingSm.id };
```

### Set scopes on every variable

**Never leave scopes as `ALL_SCOPES`.** It pollutes every property picker.

| Token type | Scopes |
|---|---|
| Background colors | `["FRAME_FILL", "SHAPE_FILL"]` |
| Text colors | `["TEXT_FILL"]` |
| Border colors | `["STROKE_COLOR"]` |
| Spacing (padding, gap) | `["GAP"]` |
| Corner radius | `["CORNER_RADIUS"]` |
| Width/height | `["WIDTH_HEIGHT"]` |
| Opacity | `["OPACITY"]` |
| Font size/weight | `["FONT_SIZE", "FONT_WEIGHT"]` |
| Primitives (raw values) | `[]` (hidden from pickers) |

```js
const v = await figma.variables.getVariableByIdAsync("VAR_ID");
v.scopes = ["FRAME_FILL", "SHAPE_FILL"];
return "scopes set";
```

### Set code syntax

Code syntax enables Dev Mode round-tripping. Web syntax **must** use the `var()` wrapper:

```js
const v = await figma.variables.getVariableByIdAsync("VAR_ID");
v.setVariableCodeSyntax("WEB", "var(--color-bg-primary)");
// Android/iOS don't use wrappers
v.setVariableCodeSyntax("ANDROID", "colorBgPrimary");
v.setVariableCodeSyntax("iOS", "Color.bgPrimary");
return "code syntax set";
```

### Alias semantic to primitive variables

Never duplicate raw values in the semantic layer. Use aliases:

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

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const spacingVar = await figma.variables.getVariableByIdAsync("SPACING_VAR_ID");

// Spacing, radius, dimensions — direct binding
node.setBoundVariable("paddingLeft", spacingVar);
node.setBoundVariable("paddingRight", spacingVar);
node.setBoundVariable("itemSpacing", spacingVar);
node.setBoundVariable("topLeftRadius", spacingVar);

// Colors — requires setBoundVariableForPaint (returns NEW paint, must reassign)
const colorVar = await figma.variables.getVariableByIdAsync("COLOR_VAR_ID");
const basePaint = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
const boundPaint = figma.variables.setBoundVariableForPaint(basePaint, "color", colorVar);
node.fills = [boundPaint];

return "bindings set";
```

**Critical:** `setBoundVariableForPaint` returns a **new** paint object. You must
capture it and reassign to `node.fills`. The base paint RGB should match the
variable's resolved value.

### Token architecture patterns

| Token count | Pattern |
|---|---|
| < 50 | Single collection, 2 modes (Light/Dark) |
| 50-200 | Primitives (1 mode) + Color semantic (Light/Dark) + Spacing (1 mode) |
| 200+ | Multiple semantic collections, 4-8 modes (Light/Dark x Contrast x Brand) |

### Import library variables

For variables from published libraries:

```js
// Import by key (from search_design_system results)
const imported = await figma.variables.importVariableByKeyAsync("VARIABLE_KEY");
// Now bind it to a node
node.setBoundVariable("itemSpacing", imported);
return { id: imported.id, name: imported.name };
```

---

## Components & variants

### Discover existing components

Before creating, check what exists:

```js
const results = [];
const page = figma.currentPage;
page.findAll(n => {
  if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
    results.push({ name: n.name, type: n.type, id: n.id });
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
comp.paddingTop = 10; comp.paddingBottom = 10;
comp.paddingLeft = 16; comp.paddingRight = 16;
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

### Create variants with combineAsVariants

Create individual COMPONENT nodes first, then combine:

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
  comp.paddingTop = 10; comp.paddingBottom = 10;
  comp.paddingLeft = 16; comp.paddingRight = 16;
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

return { compSetId: compSet.id, variantIds: variants.map(v => v.id) };
```

**After `combineAsVariants`, variants stack at (0,0).** Manually grid-layout them
in a separate script:

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

### Component properties

Add TEXT, BOOLEAN, and INSTANCE_SWAP properties:

```js
const comp = await figma.getNodeByIdAsync("COMPONENT_ID");

// TEXT property — exposes a text node for override
comp.addComponentProperty("label", "TEXT", "Button");

// BOOLEAN property — shows/hides a layer
comp.addComponentProperty("showIcon", "BOOLEAN", true);

// INSTANCE_SWAP property — swaps a nested instance
// preferredValues narrows the picker to specific components
comp.addComponentProperty("icon", "INSTANCE_SWAP", "DEFAULT_COMPONENT_ID", {
  preferredValues: [
    { type: "COMPONENT", key: "ICON_COMPONENT_KEY" },
  ]
});

return "properties added";
```

**Link properties to child nodes:**

```js
const comp = await figma.getNodeByIdAsync("COMPONENT_ID");
const label = comp.findOne(n => n.type === "TEXT" && n.name === "Label");
const icon = comp.findOne(n => n.type === "INSTANCE" && n.name === "Icon");

// Link text property to the label node
label.componentPropertyReferences = { characters: "label" };

// Link boolean property to visibility
icon.componentPropertyReferences = { visible: "showIcon" };

// Link instance swap
icon.componentPropertyReferences = { mainComponent: "icon" };

return "properties linked";
```

### Override instance text with setProperties

More reliable than direct `node.characters` manipulation:

```js
const instance = await figma.getNodeByIdAsync("INSTANCE_ID");
// Read available properties
const props = instance.componentProperties;
// Keys look like "label#123:456" — use them exactly
instance.setProperties({ "label#123:456": "Click me" });
return "text overridden";
```

### INSTANCE_SWAP for icons

**Never create a variant per icon.** Use INSTANCE_SWAP instead:

```js
// Wrong: Button/icon=check, Button/icon=close, Button/icon=arrow...
// Correct: one INSTANCE_SWAP property that accepts any icon component
```

### Variant matrix limits

If Size x Style x State > 30 combinations, split into sub-components.
E.g., create `ButtonBase` with Size x Style, then a separate `ButtonState`
component that wraps it with state variants.

---

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

### Apply a text style

```js
const node = await figma.getNodeByIdAsync("TEXT_NODE_ID");
const styles = await figma.getLocalTextStylesAsync();
const heading = styles.find(s => s.name === "Heading/H1");
if (heading) {
  node.textStyleId = heading.id;
}
return "style applied";
```

### Import library text style

```js
const style = await figma.importStyleByKeyAsync("STYLE_KEY");
const node = await figma.getNodeByIdAsync("TEXT_NODE_ID");
node.textStyleId = style.id;
return "library style applied";
```

---

## Effect styles

### Create a shadow style

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
  blendMode: "NORMAL",
  showShadowBehindNode: false,
}];
return { styleId: style.id };
```

### Apply an effect style

```js
const node = await figma.getNodeByIdAsync("NODE_ID");
const styles = await figma.getLocalEffectStylesAsync();
const shadow = styles.find(s => s.name === "Shadow/Medium");
if (shadow) {
  node.effectStyleId = shadow.id;
}
return "effect applied";
```

---

## Naming conventions

Match existing file conventions. If starting fresh:

**Variables** (slash-separated):
```
color/bg/primary     color/text/secondary    color/border/default
spacing/xs  spacing/sm  spacing/md  spacing/lg  spacing/xl
radius/none  radius/sm  radius/md  radius/lg  radius/full
```

**Primitives**: `blue/50` → `blue/900`, `gray/50` → `gray/900`

**Component names**: `Button`, `Input`, `Card`, `Avatar`, `Badge`

**Variant names**: `Property=Value, Property=Value`
E.g. `Size=Medium, Style=Primary, State=Default`

---

## Workflow checklist

| Phase | Action | Validate with |
|---|---|---|
| Discovery | List existing collections, variables, components | `figma_run_script` read-only |
| Tokens | Create collections → primitives → semantics → scopes → code syntax | `figma_run_script` read-back |
| Components | Create base → variants → properties → link → layout grid | `get_screenshot` |
| Styles | Create text styles → effect styles | `figma_run_script` read-back |
| Bindings | Bind variables to component fills, spacing, radii | `get_screenshot` to verify colors |

**Validate at every step. Never build on unvalidated work.**
