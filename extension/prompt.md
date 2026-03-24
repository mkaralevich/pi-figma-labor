## figma-labor

Live connection to Figma via the figma-labor bridge (Plugin API). Plugin: {{plugin_status}}

Use these tools to **manipulate the canvas**. For design inspection or code generation use `get_design_context` / `get_screenshot` (figma-mcp).

**Workflow:** read selection → propose → apply → **verify with `get_screenshot`** → undo if wrong.

**Before starting any Figma task, check if a `figma-*` skill matches and read it first.** Skills contain optimized patterns that prevent wasted tool calls.

**Verification:** after any canvas mutation (create, move, update, delete), call `get_screenshot` on the affected node to visually confirm the result. Do not report success without verifying. Common issues that only screenshots catch: overlapping nodes, wrong positioning, clipped content, invisible fills.

**Layout rule:** when placing multiple nodes into a frame, always use auto-layout (`layoutMode`, `layoutWrap`, `itemSpacing`) instead of manual x/y positioning. Auto-layout prevents overlaps and adapts to varying node sizes. Set it via `figma_run_script`:
```js
frame.layoutMode = "HORIZONTAL";
frame.layoutWrap = "WRAP";
frame.itemSpacing = 8;
frame.counterAxisSpacing = 8;
```

**Note:** If the Figma MCP remote server is connected (`use_figma` tool available), prefer it over the bridge tools for canvas writes. `use_figma` executes Plugin API JS server-side — same capability as `figma_run_script` but without needing the local bridge/plugin. The bridge tools remain as a fallback.

**Non-obvious API behaviors:**

| Behavior | Description | Workaround |
|---|---|---|
| Wrong layer order | Children are back-to-front: index 0 = bottommost, last = topmost | Invert index expectations when ordering layers |
| `figma_create_instance` fails | Requires a COMPONENT id, not COMPONENT_SET | Call `figma_get_children` on the set to find the target variant's id |
| Instance property update silently ignored | TEXT, BOOLEAN, INSTANCE_SWAP names must be suffixed with `#<id>` from `componentPropertyDefinitions`; VARIANT does not | Read `componentPropertyDefinitions` to get the full keyed names |
| Text update throws or is ignored | Font must exist in the document before setting characters, fontSize, fontName, or alignment | Load the font first via `await figma.loadFontAsync()` in `figma_run_script` |
| More nodes detached than expected | `figma_detach_instance` detaches all ancestor instances, not just the target | Expect ancestors to become plain frames too |
| Alignment/sizing ignored after `figma_set_layout` | `layoutMode` must be HORIZONTAL or VERTICAL before alignment or sizing modes apply | Always include `layoutMode` in the same call |
| Slow reads after writes | Alternating writes to a ComponentNode and reads from its InstanceNode stalls the plugin | Batch all reads first, then all writes |

**`figma_run_script` — key rules:**

| Behavior | Description | Workaround |
|---|---|---|
| `node.mainComponent` returns null | Sync access is unreliable in the plugin proxy | Use `await node.getMainComponentAsync()` |
| `node.findAll()` on INSTANCE crashes | Proxy does not support `findAll` on instance nodes | Use `figma.currentPage.findAll(n => n.id.startsWith("I<instanceId>;"))` |
| `layoutSizingHorizontal`/`Vertical` ignored | Setting sizing before the node is in an auto-layout frame is a no-op | Append the node to its parent first, then set sizing |
| `combineAsVariants()` throws "proxy: inconsistent get" | Known proxy instability | Clone an existing COMPONENT_SET instead |
| `.x`/`.y` assignment does not reorder children | Setting position to reorder is silently ignored | Use `insertChild(i, node)` |
| `findAll` on entire page is slow | Scanning the full page is expensive on large files | Scope `findAll` to a section or frame |
| Per-node paint construction is slow | Calling `solidPaint()` or `setBoundVariableForPaint()` per iteration creates objects on every loop | Pre-compute fill/paint objects once and reuse |
| Compound instance IDs (`id;id`) in `getNodeById` | Both sync and async variants are patched to handle `;`-delimited IDs | No action needed — falls back to `findOne` automatically |

**Variable-bound fills — correct pattern:**
When binding a design variable to a fill, the base paint RGB+opacity MUST match the variable's resolved value. Otherwise Figma renders the base color, not the variable.
```js
// Correct — base color matches variable value
const paint = { type:'SOLID', visible:true, opacity:0.04, blendMode:'NORMAL',
  color: { r:0.135, g:0.195, b:0.254 } }; // matches variable's actual RGB
const bound = figma.variables.setBoundVariableForPaint(paint, 'color', variable);
node.fills = [bound];

// Wrong — solidPaint('#FF0000') sets red base, variable won't display
```

**Repeated-component traversal:**
When a list is built from repeated component instances (e.g. rows, cards), all instances share
the same internal suffix IDs. Only the top-level instance ID differs.

Node ID anatomy:
```
I7002:20528 ; 3674:53964 ; 2013:12560
^──────────   ^──────────   ^─────────
instance      row/variant   leaf node
prefix        ID            suffix ID
```

Rule: drill ONE instance to leaf text nodes, note the suffix IDs for each field, then extrapolate
across all sibling instances without further `figma_get_children` calls.

```
// 7 rows share the same internal structure — suffix IDs are identical
I7002:20528;3674:53964;2013:12560  → row 1, merchant name
I7002:20528;3674:53965;2013:12560  → row 2, merchant name  (only middle segment changes)
```

If a suffix-based update returns "node not found", the component uses unique IDs per instance
(e.g. manually detached). Fall back to drilling that specific row.
