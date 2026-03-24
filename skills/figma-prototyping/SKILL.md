---
name: figma-prototyping
description: Use when the user wants to create, edit, inspect, or debug Figma prototyping interactions — flows, connections, triggers, actions, transitions, overlays, scroll behaviors, smart animate, navigation between frames, and prototype starting points.
---

# Figma Prototyping

Instructions for managing prototype interactions via `figma_run_script`. The Figma Plugin API exposes prototyping through the `reactions` property on scene nodes.

## Key concepts

| Concept | API property | Description |
|---|---|---|
| Reaction | `node.reactions` | Array of `{ trigger, actions }` on any scene node |
| Trigger | `reaction.trigger` | What starts the interaction (tap, hover, drag, etc.) |
| Action | `reaction.actions[]` | What happens (navigate, overlay, back, URL, set variable) |
| Transition | `action.transition` | Animation between states (dissolve, smart animate, etc.) |
| Flow | `figma.currentPage.flowStartingPoints` | Named entry points for prototype playback |

## Reading reactions

```js
const node = figma.getNodeById("123:456");
return JSON.stringify(node.reactions, null, 2);
```

## Reaction structure

```ts
interface Reaction {
  trigger: Trigger;
  actions: Action[];
}

interface Trigger {
  type: "ON_CLICK" | "ON_HOVER" | "ON_PRESS" | "ON_DRAG"
      | "MOUSE_ENTER" | "MOUSE_LEAVE" | "MOUSE_UP" | "MOUSE_DOWN"
      | "AFTER_TIMEOUT";
  timeout?: number;    // for AFTER_TIMEOUT, in seconds
  delay?: number;      // delay before trigger fires, in seconds
}

interface Action {
  type: "NODE" | "BACK" | "CLOSE" | "URL" | "UPDATE_MEDIA_RUNTIME";
  destinationId?: string | null;  // target frame ID for NODE
  navigation?: "NAVIGATE" | "SWAP" | "OVERLAY" | "SCROLL_TO" | "CHANGE_TO";
  transition?: Transition | null;
  preserveScrollPosition?: boolean;
  overlayRelativePosition?: { x: number; y: number };
  url?: string;  // for URL action
  resetVideoPosition?: boolean;
}

interface Transition {
  type: "DISSOLVE" | "SMART_ANIMATE" | "MOVE_IN" | "MOVE_OUT"
      | "PUSH" | "SLIDE_IN" | "SLIDE_OUT";
  easing: { type: "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT"
           | "LINEAR" | "EASE_IN_BACK" | "EASE_OUT_BACK"
           | "EASE_IN_AND_OUT_BACK" | "CUSTOM_BEZIER";
           easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number } };
  duration: number;  // in seconds
  direction?: "LEFT" | "RIGHT" | "TOP" | "BOTTOM";  // for directional transitions
}
```

## Creating a simple tap-to-navigate interaction

```js
const source = figma.getNodeById("SOURCE_ID");
const destId = "DEST_ID";

source.reactions = [
  ...source.reactions,
  {
    trigger: { type: "ON_CLICK" },
    actions: [{
      type: "NODE",
      destinationId: destId,
      navigation: "NAVIGATE",
      transition: {
        type: "DISSOLVE",
        easing: { type: "EASE_IN_AND_OUT" },
        duration: 0.3
      },
      preserveScrollPosition: false
    }]
  }
];
return "Added tap-to-navigate interaction";
```

## Creating an overlay

```js
const trigger = figma.getNodeById("TRIGGER_ID");
const overlayId = "OVERLAY_FRAME_ID";

trigger.reactions = [
  ...trigger.reactions,
  {
    trigger: { type: "ON_CLICK" },
    actions: [{
      type: "NODE",
      destinationId: overlayId,
      navigation: "OVERLAY",
      transition: {
        type: "MOVE_IN",
        direction: "BOTTOM",
        easing: { type: "EASE_OUT" },
        duration: 0.3
      },
      preserveScrollPosition: false,
      overlayRelativePosition: { x: 0, y: 0 }
    }]
  }
];
return "Added overlay interaction";
```

## Smart Animate

Smart Animate matches layers by name between source and destination frames. Ensure matching layers share the same name.

```js
const source = figma.getNodeById("SOURCE_ID");
source.reactions = [{
  trigger: { type: "ON_CLICK" },
  actions: [{
    type: "NODE",
    destinationId: "DEST_ID",
    navigation: "NAVIGATE",
    transition: {
      type: "SMART_ANIMATE",
      easing: { type: "EASE_IN_AND_OUT" },
      duration: 0.5
    },
    preserveScrollPosition: false
  }]
}];
return "Added smart animate interaction";
```

## Hover interactions

```js
const button = figma.getNodeById("BUTTON_ID");
button.reactions = [
  ...button.reactions,
  {
    trigger: { type: "MOUSE_ENTER" },
    actions: [{
      type: "NODE",
      destinationId: "HOVER_STATE_ID",
      navigation: "CHANGE_TO",
      transition: {
        type: "DISSOLVE",
        easing: { type: "EASE_OUT" },
        duration: 0.15
      }
    }]
  },
  {
    trigger: { type: "MOUSE_LEAVE" },
    actions: [{
      type: "NODE",
      destinationId: "DEFAULT_STATE_ID",
      navigation: "CHANGE_TO",
      transition: {
        type: "DISSOLVE",
        easing: { type: "EASE_OUT" },
        duration: 0.15
      }
    }]
  }
];
return "Added hover interaction";
```

## After-timeout (auto-advance)

```js
const splash = figma.getNodeById("SPLASH_ID");
splash.reactions = [{
  trigger: { type: "AFTER_TIMEOUT", timeout: 2 },
  actions: [{
    type: "NODE",
    destinationId: "HOME_ID",
    navigation: "NAVIGATE",
    transition: {
      type: "DISSOLVE",
      easing: { type: "EASE_IN_AND_OUT" },
      duration: 0.5
    }
  }]
}];
return "Added auto-advance after 2s";
```

## Back navigation

```js
const backBtn = figma.getNodeById("BACK_BTN_ID");
backBtn.reactions = [{
  trigger: { type: "ON_CLICK" },
  actions: [{ type: "BACK" }]
}];
return "Added back navigation";
```

## Close overlay

```js
const closeBtn = figma.getNodeById("CLOSE_BTN_ID");
closeBtn.reactions = [{
  trigger: { type: "ON_CLICK" },
  actions: [{ type: "CLOSE" }]
}];
return "Added close overlay";
```

## Flow starting points

```js
// List existing flows
return figma.currentPage.flowStartingPoints;

// Add a new flow starting point
const frameId = "123:456";
figma.currentPage.flowStartingPoints = [
  ...figma.currentPage.flowStartingPoints,
  { nodeId: frameId, name: "Main Flow" }
];
return "Added flow starting point";

// Remove a flow starting point
figma.currentPage.flowStartingPoints = figma.currentPage.flowStartingPoints
  .filter(f => f.nodeId !== "123:456");
```

## Removing reactions

```js
// Remove all reactions from a node
const node = figma.getNodeById("123:456");
node.reactions = [];

// Remove only ON_CLICK reactions
node.reactions = node.reactions.filter(r => r.trigger.type !== "ON_CLICK");
```

## Inspecting all connections on a page

```js
const connections = [];
figma.currentPage.findAll(n => {
  if (n.reactions?.length > 0) {
    for (const r of n.reactions) {
      for (const a of r.actions) {
        if (a.destinationId) {
          connections.push({
            from: { id: n.id, name: n.name },
            trigger: r.trigger.type,
            to: a.destinationId,
            navigation: a.navigation,
            transition: a.transition?.type
          });
        }
      }
    }
  }
  return false; // don't collect, just iterate
});
return connections;
```

## Gotchas

| Issue | Detail |
|---|---|
| `reactions` is readonly-ish | You must reassign the full array: `node.reactions = [...]`. Mutating in place won't persist. |
| `destinationId` must be a top-level frame | Navigation targets should be direct children of the page (frames), not nested nodes. |
| Smart Animate requires name matching | Layers that should animate must have identical names in source and destination frames. |
| Overlay position is relative | `overlayRelativePosition` is relative to the trigger node, not the page. |
| CHANGE_TO is for component variants | Used inside component sets to swap between variant states (hover, pressed, etc.). |
| Transition can be null | Set `transition: null` for instant transitions (no animation). |
