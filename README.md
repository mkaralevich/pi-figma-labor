# figma-pi

Lets the [pi coding agent](https://github.com/badlogic/pi) read and modify Figma designs directly via the Plugin API.

## Architecture

```
pi extension → bridge server (HTTP) → WebSocket → Figma plugin → Plugin API → Figma canvas
```

- **`pi-extension/`** — pi extension. Registers Figma tools the LLM can call. Manages bridge lifecycle. Includes pre-built `bridge.js` — no separate install needed.
- **`figma-plugin/`** — Figma desktop plugin. Connects to the bridge via WebSocket, executes Plugin API commands, returns results.
- **`figma-bridge/`** — Bridge server source (Node.js HTTP + WebSocket, port 3846). Only needed if you want to modify and rebuild the bridge.

## Setup

### 1. Install the Figma plugin

In Figma desktop, install the **figma-pi** plugin from the Figma Community.

### 2. Wire up the pi extension

Copy the `pi-extension/` folder into your pi extensions folder:

```bash
cp -r pi-extension ~/.pi/agent/extensions/figma-pi
```

### 3. Use

1. Open Figma desktop and open a file
2. Run the plugin: **Menu → Plugins → Development → figma-pi**
3. Start pi — run `/figma-pi-start` to launch the bridge
4. Footer shows `figma-pi ✓` when the plugin is connected

The bridge keeps running across prompts. Use `/figma-pi stop` to shut it down, or it stops automatically when pi exits.

## Commands

| Command | Description |
|---------|-------------|
| `/figma-pi-start` | Start the bridge server |
| `/figma-pi-end` | Stop the bridge server |
| `/figma-pi` | Show connection status |

## Tools

| Tool | Description |
|------|-------------|
| `figma_get_selection` | Get currently selected nodes |
| `figma_get_node` | Get a node by ID |
| `figma_get_node_full` | Get a node with all layout and constraint properties |
| `figma_get_children` | List children of a node |
| `figma_get_component_props` | Get component variant definitions |
| `figma_update_properties` | Change name, position, size, opacity, visibility, rotation |
| `figma_resize_node` | Resize a node |
| `figma_update_fills` | Change fill colors (r/g/b/a, 0–1 range) |
| `figma_update_text` | Change text content and font size |
| `figma_set_layout` | Set auto-layout direction, alignment, sizing, padding, spacing |
| `figma_create_node` | Create RECTANGLE, ELLIPSE, FRAME, or TEXT |
| `figma_create_instance` | Create an instance of a component |
| `figma_delete_node` | Delete a node |
| `figma_move_node` | Move a node to a different parent |
| `figma_select_node` | Select a node and zoom to it |
| `figma_detach_instance` | Detach a component instance into a plain frame |
| `figma_undo` | Undo the last operation |

## Rebuilding the bridge

If you modify `figma-bridge/src/server.ts`:

```bash
cd figma-bridge && npm install && npm run build
```

This rebundles `bridge.js` into the `pi-extension/` directory.
