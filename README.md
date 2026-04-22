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

- Spin up bridge via `/figma-labor-start` command
- Footer shows `figma-labor ○` when bridge is running
- In Figma, switch to **Design Mode** (not Dev Mode — plugins are read-only there)
- Open Pi Labor plugin ([Shopify](https://www.figma.com/community/plugin/1611556075783258900/figma-labor)) | (Public TBD) to start connection
- Footer shows `figma-labor ✓` when the plugin is connected
- Ask your `pi` to do things

Use `figma-labor-stop` if you want to close connection.

## Figma MCP

Figma MCP is optional but can improve quality with tools like `take_screenshot`. Install [pi-figma-mcp](https://github.com/mkaralevich/pi-figma-mcp) extension.

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

| Tool                        | Description                                                    |
| --------------------------- | -------------------------------------------------------------- |
| `figma_get_selection`       | Get currently selected nodes                                   |
| `figma_get_node`            | Get a node by ID                                               |
| `figma_get_node_full`       | Get a node with all layout and constraint properties           |
| `figma_get_children`        | List children of a node                                        |
| `figma_get_component_props` | Get component variant definitions                              |
| `figma_update_properties`   | Change name, position, size, opacity, visibility, rotation     |
| `figma_resize_node`         | Resize a node                                                  |
| `figma_update_fills`        | Change fill colors (r/g/b/a, 0–1 range)                        |
| `figma_update_text`         | Change text content and font size                              |
| `figma_set_layout`          | Set auto-layout direction, alignment, sizing, padding, spacing |
| `figma_create_node`         | Create RECTANGLE, ELLIPSE, FRAME, or TEXT                      |
| `figma_create_instance`     | Create an instance of a component                              |
| `figma_delete_node`         | Delete a node                                                  |
| `figma_move_node`           | Move a node to a different parent                              |
| `figma_select_node`         | Select a node and zoom to it                                   |
| `figma_detach_instance`     | Detach a component instance into a plain frame                 |
| `figma_run_script`          | Run arbitrary JavaScript in the Figma plugin context           |
| `figma_undo`                | Undo the last operation                                        |

## Rebuilding the bridge

If you modify `bridge-src/src/server.ts`:

```bash
cd bridge-src && npm install && npm run build
```

This rebundles `bridge.js` into the `extensions/` directory.
