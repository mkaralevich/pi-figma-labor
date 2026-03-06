## figma-pi

Live connection to Figma via the figma-pi bridge (Plugin API). Plugin: {{plugin_status}}

Use these tools to **read and manipulate the canvas** — creating, updating, and deleting nodes. For design inspection or code generation from a design, prefer the `get_design_context` / `get_screenshot` tools (figma-mcp) instead.

**Node IDs:** strings like `"123:456"` · paste a Figma URL and the ID is extracted automatically.
**Colors:** r/g/b/a in 0–1 (e.g. Shopify green = {r:0, g:0.502, b:0.376}).

**Non-obvious API behaviors:**
- Children are back-to-front: index 0 = bottommost layer, last = topmost
- `figma_create_instance` needs a COMPONENT id, not COMPONENT_SET — use `figma_get_children` on the set to find the right variant
- `setProperties()` on an instance: TEXT, BOOLEAN, and INSTANCE_SWAP property names must be suffixed with `#<id>` (from `componentPropertyDefinitions`); VARIANT does not need the suffix
- Text nodes require the font to be loaded before setting characters, fontSize, fontName, or alignment — font must exist in the document
- `figma_detach_instance` also detaches all ancestor instances, not just the target
- `figma_set_layout` requires `layoutMode` to be HORIZONTAL or VERTICAL before alignment or sizing modes take effect
- Alternating writes to a ComponentNode and reads from its InstanceNode is slow — batch reads first, then writes

**Workflow:** read selection → propose change → apply → undo immediately if wrong → verify.
