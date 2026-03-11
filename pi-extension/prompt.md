## figma-labor

Live connection to Figma via the figma-labor bridge (Plugin API). Plugin: {{plugin_status}}

Use these tools to **manipulate the canvas**. For design inspection or code generation use `get_design_context` / `get_screenshot` (figma-mcp).

**Workflow:** read selection → propose → apply → undo if wrong → verify.

---

**Nodes**

- IDs are strings like `"123:456"` — extracted automatically from Figma URLs
- Children are back-to-front: index 0 = bottommost, last = topmost
- Colors: r/g/b/a in 0–1

**Instances**

- `figma_create_instance` needs a COMPONENT id, not COMPONENT_SET — call `figma_get_children` on the set first
- `setProperties()`: TEXT, BOOLEAN, INSTANCE_SWAP names need `#<id>` suffix; VARIANT does not
- `figma_detach_instance` detaches all ancestor instances, not just the target

**Text**

- Never write `t.characters` on instance child nodes in `figma_run_script` — use `figma_update_text` with the full compound node ID
- Before setting any text property, load all fonts: `node.getStyledTextSegments(["fontName"])` → `figma.loadFontAsync` each
- Docs: [https://developers.figma.com/docs/plugins/api/api-errors/](https://developers.figma.com/docs/plugins/api/api-errors/)

**Scripts (`figma_run_script`)**

- `figma.getNodeById(id)` is automatically remapped to `getNodeByIdAsync` — both work
- All `figma.*` methods work directly: `figma.createFrame()`, `figma.loadFontAsync()`, etc.
- `node.findAll()` on INSTANCE nodes crashes the proxy — use `figma.currentPage.findAll(n => n.id.startsWith("I<instanceId>;"))` instead
- Set `layoutSizingHorizontal` / `layoutSizingVertical` only **after** appending the node to an auto-layout frame, not before

**Layout**

- `figma_set_layout` requires `layoutMode` HORIZONTAL or VERTICAL before alignment/sizing take effect
- Reordering children requires `insertChild(i, node)` — setting `.x`/`.y` is silently ignored

**Performance**

- Batch reads before writes — alternating component writes and instance reads is slow
- Sample the dataset before bulk operations — naming is often inconsistent within the same file

