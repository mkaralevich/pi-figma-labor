> Made @ Shopify

# pi-figma-labor

Connects [pi-coding-agent](https://github.com/badlogic/pi-mono) to Figma.

- Uses WS connection via local bridge that comes with pi extension
- Uses [Figma plugin API](https://developers.figma.com/docs/plugins/api/api-reference/), so you can do everything it allows
- Uses [Figma MCP]([https://github.com/nicepkg/figma-mcp](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)) for screenshots and design context if available

## Install

```
pi install https://github.com/mkaralevich/pi-figma-labor
```

## Use

- Bridge auto-starts when pi launches
- In Figma, switch to Design Mode and open Pi Labor plugin ([Shopify](https://www.figma.com/community/plugin/1611556075783258900/figma-labor) | Public TBD)
- Ask your `pi` to do things

### Figma MCP

Desktop Figma MCP support is bundled in this repo. To enable:

1. Open design file
2. Switch to Dev Mode
3. Inspect panel → MCP server → Enable desktop MCP server

Optional port override:

```sh
FIGMA_MCP_PORT=3845 pi
```

### Commands


| Command              | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `/figma-labor-start` | Start bridge server manually                          |
| `/figma-labor-stop`  | Stop bridge server manually                           |
| `/figma-labor`       | Show bridge status and Figma plugin connection status |
| `/figma-mcp`         | Show Figma MCP server status and list available tools |


## How it works

```
↓ pi extension
↓ bridge server (HTTP)
↓ WebSocket
↓ Figma plugin
↓ Plugin API
. Figma canvas
```

## MCP ↔ Labor

If MCP is unvavailable, Labor will use Figma API equivalent.


| MCP tool             | labor equivalent                                                  |
| -------------------- | ----------------------------------------------------------------- |
| `get_screenshot`     | `labor_zoom_to_node` + manual inspect                             |
| `get_design_context` | `labor_get_node_full` + `labor_get_children` + `labor_run_script` |
| `get_metadata`       | `labor_get_children` + `labor_run_script`                         |
| `get_variable_defs`  | `labor_run_script`                                                |


## Available tools

Figma MCP tools are registered when the desktop MCP server is enabled.


| Tool                              | Description                                                    |
| --------------------------------- | -------------------------------------------------------------- |
| `labor_get_selection`             | Get currently selected nodes                                   |
| `labor_get_node`                  | Get a node by ID                                               |
| `labor_get_node_full`             | Get a node with all layout and constraint properties           |
| `labor_get_children`              | List children of a node                                        |
| `labor_get_component_props`       | Get component variant definitions                              |
| `labor_get_component_set_summary` | Get a component set summary                                    |
| `labor_reorder_variant_options`   | Reorder variant options on a component set                     |
| `labor_create_component_set`      | Combine components into a component set                        |
| `labor_update_properties`         | Change name, position, size, opacity, visibility, rotation     |
| `labor_resize_node`               | Resize a node                                                  |
| `labor_scale_node`                | Scale a node proportionally like Figma Scale tool              |
| `labor_clone_node`                | Clone a node                                                   |
| `labor_update_fills`              | Change fill colors (r/g/b/a, 0–1 range)                        |
| `labor_update_text`               | Change text content and font size                              |
| `labor_set_layout`                | Set auto-layout direction, alignment, sizing, padding, spacing |
| `labor_create_node`               | Create RECTANGLE, ELLIPSE, FRAME, or TEXT                      |
| `labor_create_instance`           | Create an instance of a component                              |
| `labor_delete_node`               | Delete a node                                                  |
| `labor_move_node`                 | Move a node to a different parent                              |
| `labor_select_node`               | Select a node and zoom to it                                   |
| `labor_zoom_to_node`              | Zoom the viewport to a node without selecting it               |
| `labor_detach_instance`           | Detach a component instance into a plain frame                 |
| `labor_run_script`                | Run arbitrary JavaScript in the Figma plugin context           |
| `labor_undo`                      | Undo the last operation                                        |


## Available skills


| Skill                 | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `figma-create`        | Create, clone, compose, and insert UI in Figma                  |
| `figma-design-system` | Work with variables, tokens, components, variants, and styles   |
| `figma-select`        | Find, inspect, extract, and batch-select Figma nodes            |
| `figma-prototype`     | (WIP) Prototype flows, reactions, transitions, and start points |


## Development

If you modify `bridge-src/src/server.ts`:

```bash
cd bridge-src && npm install && npm run build
```

This rebundles `bridge.js` into the `extensions/` directory.
