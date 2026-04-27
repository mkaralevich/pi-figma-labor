> Made @ Shopify

# pi-figma-labor

Connects [pi-coding-agent](https://github.com/badlogic/pi-mono) to Figma.

- Uses WS connection via local bridge that comes with pi extension
- Uses [Figma plugin API](https://developers.figma.com/docs/plugins/api/api-reference/), so you can do everything it allows

## Install

Message `pi`:

```
Install this pi-extension https://github.com/mkaralevich/pi-figma-labor
```

Or place extension in your `/extensions` folder

## Use

- Bridge auto-starts when pi launches
- If needed, you can still start it manually with `/figma-labor-start`
- Footer shows a single `figma-labor` status:

| Status | Meaning |
| --- | --- |
| `○` | no bridge, no MCP |
| `◐` | bridge, no MCP |
| `◑` | no bridge, MCP |
| `✓` | bridge + MCP |
- In Figma, switch to **Design Mode** (not Dev Mode — plugins are read-only there)
- Open Pi Labor plugin ([Shopify](https://www.figma.com/community/plugin/1611556075783258900/figma-labor)) | (Public TBD) to start connection
- Ask your `pi` to do things

Use `figma-labor-stop` if you want to close connection.

## Figma MCP

Desktop Figma MCP support is bundled in this repo.

Enable it in Figma desktop app:
1. Open a Design file
2. Switch to Dev Mode
3. Inspect panel → MCP server → Enable desktop MCP server
4. Check status with `/figma-mcp`

Optional port override:

```sh
FIGMA_MCP_PORT=3845 pi
```

## MCP ↔ labor map

| MCP tool | labor equivalent |
| --- | --- |
| `get_screenshot` | `labor_zoom_to_node` + manual inspect |
| `get_design_context` | `labor_get_node_full` + `labor_get_children` + `labor_run_script` |
| `get_metadata` | `labor_get_children` + `labor_run_script` |
| `get_variable_defs` | `labor_run_script` |
| `search_design_system` | none |

## How it works

```
↓ pi extension
↓ bridge server (HTTP)
↓ WebSocket
↓ Figma plugin
↓ Plugin API
. Figma canvas
```

## Tools

Dynamic MCP tools are registered when the desktop MCP server is enabled. Typical refs in docs use this format: `mcp: get_screenshot | labor: labor_zoom_to_node`.


| Tool                            | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| `labor_get_selection`           | Get currently selected nodes                                   |
| `labor_get_node`                | Get a node by ID                                               |
| `labor_get_node_full`           | Get a node with all layout and constraint properties           |
| `labor_get_children`            | List children of a node                                        |
| `labor_get_component_props`     | Get component variant definitions                              |
| `labor_get_component_set_summary` | Get a component set summary                                  |
| `labor_reorder_variant_options` | Reorder variant options on a component set                     |
| `labor_create_component_set`    | Combine components into a component set                        |
| `labor_update_properties`       | Change name, position, size, opacity, visibility, rotation     |
| `labor_resize_node`             | Resize a node                                                  |
| `labor_scale_node`              | Scale a node proportionally like Figma Scale tool              |
| `labor_clone_node`              | Clone a node                                                   |
| `labor_update_fills`            | Change fill colors (r/g/b/a, 0–1 range)                        |
| `labor_update_text`             | Change text content and font size                              |
| `labor_set_layout`              | Set auto-layout direction, alignment, sizing, padding, spacing |
| `labor_create_node`             | Create RECTANGLE, ELLIPSE, FRAME, or TEXT                      |
| `labor_create_instance`         | Create an instance of a component                              |
| `labor_delete_node`             | Delete a node                                                  |
| `labor_move_node`               | Move a node to a different parent                              |
| `labor_select_node`             | Select a node and zoom to it                                   |
| `labor_zoom_to_node`            | Zoom the viewport to a node without selecting it               |
| `labor_detach_instance`         | Detach a component instance into a plain frame                 |
| `labor_run_script`              | Run arbitrary JavaScript in the Figma plugin context           |
| `labor_undo`                    | Undo the last operation                                        |

## Rebuilding the bridge

If you modify `bridge-src/src/server.ts`:

```bash
cd bridge-src && npm install && npm run build
```

This rebundles `bridge.js` into the `extensions/` directory.
