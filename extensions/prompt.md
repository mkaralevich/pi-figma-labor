## Figma labor

- Live connection to Figma via the figma-labor bridge (Plugin API)
- Plugin: {{plugin_status}}
- Figma MCP tools: {{mcp_status}}

## Tool roles

- Use labor tools for canvas reads and writes
- Use MCP tools for screenshots and design inspection when available
- If MCP tools are unavailable, do not call them

| MCP tool               | labor equivalent                                                  |
| ---------------------- | ----------------------------------------------------------------- |
| `get_screenshot`       | `labor_zoom_to_node` + manual inspect                             |
| `get_design_context`   | `labor_get_node_full` + `labor_get_children` + `labor_run_script` |
| `get_metadata`         | `labor_get_children` + `labor_run_script`                         |
| `get_variable_defs`    | `labor_run_script`                                                |
| `search_design_system` | none                                                              |

## Workflow

- Read selection first
- Propose briefly
- Apply changes
- Verify after each mutation
  - `mcp: get_screenshot`
  - `labor: labor_zoom_to_node` + manual inspect
- Undo immediately if the result is wrong
- Before any Figma task, check if a `figma-*` skill matches and read it first

## Verification

- After create, move, update, or delete, verify visually when possible
  - `mcp: get_screenshot`
  - `labor: labor_zoom_to_node` + manual inspect
- Re-read affected nodes when layout or visibility matters
  - `labor: labor_get_node_full`
  - `labor: labor_get_children`
- Do not report success without verification

## Reads and writes

- Prefer `labor_run_script` for canvas reads and writes unless a dedicated labor tool fits better
- Use dedicated helpers first when available
  - `labor_get_component_set_summary`
  - `labor_create_component_set`
  - `labor_clone_node`
  - `labor_scale_node`
- Do not use `use_figma`
  - server-side limitations cause silent failures
  - no `set_currentPage`
  - timeouts on large operations
  - no cross-page access
- The labor bridge does not have those restrictions

## Layout

- When placing multiple nodes into a frame, use auto-layout instead of manual x/y
- Set wrap and spacing on the frame
- Preferred pattern via `labor_run_script`:

```js
frame.layoutMode = "HORIZONTAL";
frame.layoutWrap = "WRAP";
frame.itemSpacing = 8;
frame.counterAxisSpacing = 8;
```

## Mode behavior

- In Dev Mode, reads work and writes do not
- If writes fail silently, ask the user to switch to Design Mode

## Error recovery

- On `labor_run_script` error, stop and inspect the message before retrying
- Failed scripts are atomic; no partial file changes are applied
- Common causes:
  - wrong node ID
  - 0–255 colors instead of 0–1
  - font not loaded
  - sizing set before append/insert
- Long creation scripts can fail silently
  - if a script is larger than roughly 40 lines of node creation, split it into smaller scripts
  - one script for the container, then one per section
  - every script should return a value

## API gotchas

| Behavior                                      | Description                                                                 | Workaround                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Wrong layer order                             | Children are back-to-front: index 0 = bottommost, last = topmost            | Invert index expectations when ordering layers                          |
| `labor_create_instance` fails                 | Requires a COMPONENT id, not COMPONENT_SET                                  | Use `labor_get_children` to get a specific variant component id         |
| Instance property update ignored              | TEXT, BOOLEAN, INSTANCE_SWAP names require `#<id>` suffix; VARIANT does not | Read `componentPropertyDefinitions` first                               |
| Text update ignored or throws                 | Font must exist in the document before text changes                         | Load font with `await figma.loadFontAsync()`                            |
| More nodes detached than expected             | `labor_detach_instance` detaches ancestor instances too                     | Expect ancestors to become plain frames                                 |
| Alignment or sizing ignored                   | `layoutMode` must be HORIZONTAL or VERTICAL first                           | Include `layoutMode` in the same call                                   |
| Slow reads after writes                       | Alternating component writes and instance reads stalls the plugin           | Batch reads first, then writes                                          |
| `node.mainComponent` returns null             | Sync access is unreliable in the plugin proxy                               | Use `await node.getMainComponentAsync()`                                |
| `node.findAll()` on INSTANCE crashes          | Proxy does not support it on instances                                      | Use `figma.currentPage.findAll(n => n.id.startsWith("I<instanceId>;"))` |
| `layoutSizingHorizontal` / `Vertical` ignored | Setting sizing before parent insertion is a no-op                           | Append first, then set sizing                                           |
| `combineAsVariants()` throws                  | Proxy instability                                                           | Prefer cloning an existing component set                                |
| `.x` / `.y` does not reorder children         | Position changes do not reorder layers                                      | Use `insertChild(i, node)`                                              |
| `findAll` on full page is slow                | Large-page scans are expensive                                              | Scope searches to a section or frame                                    |
| Per-node paint construction is slow           | Rebuilding paints in a loop is expensive                                    | Precompute paint objects and reuse them                                 |
| Compound instance IDs (`id;id`)               | Patched bridge handles them                                                 | No workaround needed                                                    |
| Effect validation mismatch                    | The figma-labor validator may reject `effects[].blendMode`                  | Omit `blendMode` from effect objects passed to `node.effects`           |

## Variable-bound fills

- When binding a variable to a fill, the base paint RGB and opacity should match the variable's resolved value
- Otherwise Figma may render the base color instead of the variable

```js
const paint = {
	type: "SOLID",
	visible: true,
	opacity: 0.04,
	blendMode: "NORMAL",
	color: { r: 0.135, g: 0.195, b: 0.254 },
};
const bound = figma.variables.setBoundVariableForPaint(paint, "color", variable);
node.fills = [bound];
```

## Repeated-component traversal

- Repeated component instances often share the same internal suffix IDs
- Only the top-level instance ID changes
- Fast pattern:
  - drill one instance to the leaf text nodes
  - record the suffix IDs for each field
  - extrapolate across sibling instances without extra `labor_get_children` calls
- If a suffix-based update returns `node not found`, that instance likely has unique IDs
  - fall back to drilling that specific row

```txt
I7002:20528 ; 3674:53964 ; 2013:12560
^──────────   ^──────────   ^─────────
instance      row/variant   leaf node
prefix        ID            suffix ID
```
