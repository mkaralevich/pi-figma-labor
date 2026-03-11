// figma-labor plugin — main thread
// Receives commands from ui.html via postMessage, executes via Plugin API,
// returns results back to ui.html.

figma.showUI(__html__, {
  width: 280,
  height: 120,
  title: "Figma Labor",
  themeColors: true,
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === "resize") {
    figma.ui.resize(280, msg.height);
    return;
  }

  const { id, command, params } = msg;
  try {
    const result = await executeCommand(command, params);
    figma.ui.postMessage({ id, result });
  } catch (err) {
    figma.ui.postMessage({ id, error: err.message });
  }
};

async function executeCommand(command, params) {
  switch (command) {

    // ── Undo ────────────────────────────────────────────────────────────────

    case "undo": {
      figma.undo();
      return { success: true };
    }

    // ── Read ────────────────────────────────────────────────────────────────

    case "get_node": {
      const node = await safeGetNodeById(params.nodeId);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      return serializeNode(node);
    }

    case "get_selection": {
      return figma.currentPage.selection.map(serializeNode);
    }

    case "get_children": {
      const node = params.nodeId
        ? await safeGetNodeById(params.nodeId)
        : figma.currentPage;
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      if (!("children" in node)) throw new Error("Node has no children");
      return node.children.map(serializeNode);
    }

    // ── Update ──────────────────────────────────────────────────────────────

    case "update_properties": {
      const node = await requireNode(params.nodeId);
      const p = params.properties || {};
      if (p.name !== undefined) node.name = p.name;
      if (p.x !== undefined) node.x = p.x;
      if (p.y !== undefined) node.y = p.y;
      if (p.opacity !== undefined) node.opacity = p.opacity;
      if (p.visible !== undefined) node.visible = p.visible;
      if (p.rotation !== undefined) node.rotation = p.rotation;
      if ((p.width !== undefined || p.height !== undefined) && "resize" in node) {
        node.resize(p.width !== undefined ? p.width : node.width, p.height !== undefined ? p.height : node.height);
      }
      return serializeNode(node);
    }

    case "resize_node": {
      const node = await requireNode(params.nodeId);
      if (!("resize" in node)) throw new Error("Node cannot be resized");
      node.resize(params.width, params.height);
      figma.viewport.scrollAndZoomIntoView([node]);
      return serializeNode(node);
    }

    case "update_fills": {
      const node = await requireNode(params.nodeId);
      if (!("fills" in node)) throw new Error("Node has no fills");
      // params.fills: [{ r, g, b, a? }]  (0–1 range)
      node.fills = params.fills.map((f) => ({
        type: "SOLID",
        color: { r: f.r, g: f.g, b: f.b },
        opacity: f.a !== undefined ? f.a : 1,
      }));
      return serializeNode(node);
    }

    case "update_text": {
      const node = await requireNode(params.nodeId);
      if (node.type !== "TEXT") throw new Error(`Node ${params.nodeId} is not a text node`);
      await figma.loadFontAsync(node.fontName);
      if (params.text !== undefined) node.characters = params.text;
      if (params.fontSize !== undefined) node.fontSize = params.fontSize;
      return serializeNode(node);
    }

    // ── Create ──────────────────────────────────────────────────────────────

    case "create_node": {
      const parent = params.parentId
        ? await figma.getNodeByIdAsync(params.parentId)
        : figma.currentPage;
      if (!parent || !("appendChild" in parent)) {
        throw new Error("Parent node not found or cannot have children");
      }

      let node;
      switch ((params.type || "").toUpperCase()) {
        case "RECTANGLE": node = figma.createRectangle(); break;
        case "ELLIPSE":   node = figma.createEllipse();   break;
        case "FRAME":     node = figma.createFrame();     break;
        case "TEXT": {
          node = figma.createText();
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          node.characters = params.text || "";
          break;
        }
        default:
          throw new Error(`Unsupported node type: ${params.type}`);
      }

      parent.appendChild(node);
      if (params.name !== undefined) node.name = params.name;
      if (params.x !== undefined) node.x = params.x;
      if (params.y !== undefined) node.y = params.y;
      if (params.width !== undefined && params.height !== undefined && "resize" in node) {
        node.resize(params.width, params.height);
      }

      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      return serializeNode(node);
    }

    // ── Delete ──────────────────────────────────────────────────────────────

    case "delete_node": {
      const node = await requireNode(params.nodeId);
      const serialized = serializeNode(node);
      node.remove();
      return { deleted: serialized };
    }

    // ── Move ────────────────────────────────────────────────────────────────

    case "move_node": {
      const node = await requireNode(params.nodeId);
      const newParent = await safeGetNodeById(params.parentId);
      if (!newParent || !("appendChild" in newParent)) {
        throw new Error("Target parent not found or cannot have children");
      }
      newParent.appendChild(node);
      if (params.index !== undefined) {
        newParent.insertChild(params.index, node);
      }
      return serializeNode(node);
    }

    // ── Utility ─────────────────────────────────────────────────────────────

    case "select_node": {
      const node = await requireNode(params.nodeId);
      if (node.type === "DOCUMENT" || node.type === "PAGE") {
        throw new Error("Cannot select document or page nodes");
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      return { success: true };
    }

    case "zoom_to_node": {
      const node = await requireNode(params.nodeId);
      if (node.type === "DOCUMENT" || node.type === "PAGE") {
        throw new Error("Cannot zoom to document or page nodes");
      }
      figma.viewport.scrollAndZoomIntoView([node]);
      return { success: true };
    }

    // ── Instance ───────────────────────────────────────────────────────────

    case "detach_instance": {
      const node = await requireNode(params.nodeId);
      if (node.type !== "INSTANCE") {
        throw new Error(`Node ${params.nodeId} is not an INSTANCE (got ${node.type})`);
      }
      const frame = node.detachInstance();
      return serializeNode(frame);
    }

    case "create_instance": {
      const component = await figma.getNodeByIdAsync(params.componentId);
      if (!component) throw new Error(`Component not found: ${params.componentId}`);
      if (component.type !== "COMPONENT") {
        throw new Error(`Node ${params.componentId} is not a COMPONENT (got ${component.type}). For a COMPONENT_SET, pass one of its variant children.`);
      }

      const instance = component.createInstance();

      if (params.parentId) {
        const parent = await figma.getNodeByIdAsync(params.parentId);
        if (!parent || !("appendChild" in parent)) throw new Error("Parent not found or cannot have children");
        parent.appendChild(instance);
      }

      if (params.x !== undefined) instance.x = params.x;
      if (params.y !== undefined) instance.y = params.y;
      if (params.name !== undefined) instance.name = params.name;

      // Set component properties (variant overrides, text overrides, etc.)
      if (params.properties && Object.keys(params.properties).length > 0) {
        instance.setProperties(params.properties);
      }

      figma.currentPage.selection = [instance];
      figma.viewport.scrollAndZoomIntoView([instance]);
      return serializeNode(instance);
    }

    // ── Node full ──────────────────────────────────────────────────────────

    case "get_node_full": {
      const node = await safeGetNodeById(params.nodeId);
      if (!node) throw new Error(`Node not found: ${params.nodeId}`);
      return serializeNodeFull(node);
    }

    // ── Layout ─────────────────────────────────────────────────────────────

    case "set_layout": {
      const node = await requireNode(params.nodeId);
      if (!("layoutMode" in node)) throw new Error("Node does not support auto-layout (must be a frame or component)");
      const p = params;
      // layoutMode must be set before alignment props
      if (p.layoutMode !== undefined) node.layoutMode = p.layoutMode;
      if (p.primaryAxisAlignItems !== undefined) node.primaryAxisAlignItems = p.primaryAxisAlignItems;
      if (p.counterAxisAlignItems !== undefined) node.counterAxisAlignItems = p.counterAxisAlignItems;
      if (p.primaryAxisSizingMode !== undefined) node.primaryAxisSizingMode = p.primaryAxisSizingMode;
      if (p.counterAxisSizingMode !== undefined) node.counterAxisSizingMode = p.counterAxisSizingMode;
      if (p.paddingTop !== undefined) node.paddingTop = p.paddingTop;
      if (p.paddingRight !== undefined) node.paddingRight = p.paddingRight;
      if (p.paddingBottom !== undefined) node.paddingBottom = p.paddingBottom;
      if (p.paddingLeft !== undefined) node.paddingLeft = p.paddingLeft;
      if (p.itemSpacing !== undefined) node.itemSpacing = p.itemSpacing;
      return serializeNodeFull(node);
    }

    case "get_component_properties": {
      const node = await requireNode(params.nodeId);
      if (!("componentPropertyDefinitions" in node)) {
        throw new Error("Node has no componentPropertyDefinitions");
      }
      return node.componentPropertyDefinitions;
    }

    case "reorder_variant_options": {
      // params: { nodeId, property, order: ["small", "medium"] }
      const node = await requireNode(params.nodeId);
      if (!("componentPropertyDefinitions" in node)) {
        throw new Error("Node has no componentPropertyDefinitions");
      }
      const defs = node.componentPropertyDefinitions;
      if (!defs[params.property]) {
        throw new Error(`Property "${params.property}" not found`);
      }
      node.editComponentProperty(params.property, { variantOptions: params.order });
      return node.componentPropertyDefinitions[params.property];
    }

    // ── Run script ─────────────────────────────────────────────────────────

    case "run_script": {
      // Pass the real figma object — wrapping it in a JS Proxy conflicts with
      // Figma's internal proxy mechanism and causes "proxy: inconsistent get"
      // on ANY async API call (getNodeByIdAsync, setCurrentPageAsync, etc.).
      //
      // safeGetNodeById is available as a helper for compound instance IDs
      // (those containing ';') which getNodeByIdAsync can't resolve reliably.
      const fn = new Function(
        "figma", "safeGetNodeById",
        `"use strict"; return (async () => { ${params.code} })()`
      );
      return await fn(figma, safeGetNodeById);
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function safeGetNodeById(id) {
  // Compound instance IDs (containing ';') cause "proxy: inconsistent get"
  // with getNodeByIdAsync. Use findOne as a reliable fallback.
  if (typeof id === 'string' && id.includes(';')) {
    const node = figma.currentPage.findOne(n => n.id === id);
    if (node) return node;
    // Fall through to getNodeByIdAsync if not on current page
  }
  return figma.getNodeByIdAsync(id);
}

async function requireNode(nodeId) {
  const node = await safeGetNodeById(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function serializeNodeFull(node) {
  const out = serializeNode(node);

  // Constraints — how this node is pinned inside its parent
  if ("constraints" in node) {
    out.constraints = node.constraints;
  }

  // Auto-layout / frame layout properties
  if ("layoutMode" in node) {
    out.layoutMode = node.layoutMode;
    out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    out.counterAxisSizingMode = node.counterAxisSizingMode;
    out.paddingTop = node.paddingTop;
    out.paddingRight = node.paddingRight;
    out.paddingBottom = node.paddingBottom;
    out.paddingLeft = node.paddingLeft;
    if (node.layoutMode !== "NONE") {
      out.primaryAxisAlignItems = node.primaryAxisAlignItems;
      out.counterAxisAlignItems = node.counterAxisAlignItems;
      out.itemSpacing = node.itemSpacing;
    }
  }

  // Size constraints (min/max)
  if ("minWidth" in node && node.minWidth !== null) out.minWidth = node.minWidth;
  if ("maxWidth" in node && node.maxWidth !== null) out.maxWidth = node.maxWidth;
  if ("minHeight" in node && node.minHeight !== null) out.minHeight = node.minHeight;
  if ("maxHeight" in node && node.maxHeight !== null) out.maxHeight = node.maxHeight;

  // Clip content
  if ("clipsContent" in node) out.clipsContent = node.clipsContent;

  // Locked
  if ("locked" in node) out.locked = node.locked;

  return out;
}

function serializeNode(node) {
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  if ("x" in node) out.x = node.x;
  if ("y" in node) out.y = node.y;
  if ("width" in node) out.width = node.width;
  if ("height" in node) out.height = node.height;
  if ("opacity" in node) out.opacity = node.opacity;
  if ("visible" in node) out.visible = node.visible;
  if ("rotation" in node) out.rotation = node.rotation;
  if (node.type === "TEXT") {
    out.characters = node.characters;
    out.fontSize = node.fontSize;
  }
  if ("fills" in node && node.fills !== figma.mixed) {
    out.fills = node.fills;
  }
  if ("children" in node) {
    out.childCount = node.children.length;
  }
  return out;
}
