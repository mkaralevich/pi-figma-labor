# Figma Labor — Proxy, Timeout & API Issues

Field notes from bulk avatar fill replacement across two heavy pages (~500+ instances each).

---

## 1. `proxy: inconsistent get`

**Error:** `figma-labor error: proxy: inconsistent get`

**When it happens:**
- Calling `figma.getNodeByIdAsync(id)` on deeply nested instance IDs (e.g. `I15871:46332;11631:115617;11631:111887`)
- Accessing `.children`, `.fills`, or other properties on nodes obtained via `getNodeByIdAsync` in the same script
- Calling `combineAsVariants()` or `figma.createComponent()`
- Any script that mixes `await getNodeByIdAsync()` with property traversal on the returned node

**When it does NOT happen:**
- `figma.currentPage.findAll(predicate)` — always works for locating nodes
- `figma.currentPage.findAllWithCriteria({ types: [...] })` — works for type-based search
- Accessing `.fills`, `.name`, `.width`, `.children`, `.parent` on nodes returned by `findAll` — always works
- `node.clone()` on nodes found via `findAll` — works
- `node.findOne()` / `node.findAll()` on nodes found via page-level `findAll` — works

**Root cause hypothesis:**
`getNodeByIdAsync` returns a proxy object that has stale or inconsistent internal state, especially for nodes inside instances (compound IDs with `;`). The proxy may reference a page-loading context that conflicts with subsequent property reads. `findAll` returns nodes through a different code path that doesn't have this issue.

**Workaround:**
Never use `getNodeByIdAsync` for nested instance IDs. Instead:
```js
// ❌ Fails
const node = await figma.getNodeByIdAsync('I15871:46332;11631:115617;11631:111887');
node.fills = [newFill]; // proxy: inconsistent get

// ✅ Works
const all = figma.currentPage.findAll(n => n.name === 'Avatar' && n.width === 44);
const target = all.find(n => n.id === 'I15871:46332;11631:115617;11631:111887');
target.fills = [newFill];
```

**Possible library fix:**
- The `run_script` tool could intercept `getNodeByIdAsync` calls and transparently rewrite them to use `findAll` + ID match when the ID contains `;` (instance compound IDs)
- Or: expose a `figma_batch_update` tool that accepts `{ selector, property, value }` and handles node resolution internally

---

## 2. Command timeout (10s limit)

**Error:** `figma-labor error: Command "run_script" timed out after 10000ms`

**When it happens:**
- `findAll` on a page with many nodes (500+ matches, thousands of total nodes) takes 7-9s alone, leaving <1-3s for actual work
- Subsequent calls to `findAll` get progressively slower as the page accumulates modified nodes
- Pages with many sections/frames compound the problem — "Wallet" page with 8 sections and 518 avatars was much worse than "polaris" page with 499

**Scaling behavior observed:**
| Page | Total 44×44 Avatars | findAll time | Safe batch size |
|------|---------------------|-------------|-----------------|
| polaris (Now) | 499 | ~3-4s | 80 nodes/batch |
| Wallet | 518 | ~7-9s | 10-20 nodes/batch |

The Wallet page has more total nodes (SECTIONs with deep nesting) even though avatar count is similar.

**Workarounds found:**

### a) Section-by-section processing (best)
Instead of `figma.currentPage.findAll(...)`, scope to individual sections:
```js
// ❌ Slow — searches entire page
const avatars = figma.currentPage.findAll(n => n.name === 'Avatar' && n.width === 44);

// ✅ Fast — searches one section
const sec = figma.currentPage.children.find(c => c.id === '12305:47819');
const avatars = sec.findAll(n => n.name === 'Avatar' && n.width === 44);
```
This reduced processing from 10-per-batch to 80+ per batch on the Wallet page.

### b) Pre-compute the fill object once
```js
// ✅ Create the paint + bind variable once, reuse for all nodes
const bound = figma.variables.setBoundVariableForPaint(
  {type:'SOLID', visible:true, opacity:0.04, blendMode:'NORMAL', color:{r:0.135,g:0.195,b:0.254}},
  'color', variable
);
for (const a of avatars) a.fills = [bound]; // Just assignment, no computation
```

### c) Index-based batching with stored IDs
```js
// Script 1: collect and cache
const ids = avatars.map(a => a.id);
figma.root.setPluginData('avatarIds', JSON.stringify(ids));

// Script 2+: process by index without re-scanning
// (only works if getNodeByIdAsync works for the IDs — fails for instance compound IDs)
```

**Possible library fixes:**
- Increase timeout to 30s for `run_script` (configurable?)
- Add a `figma_batch_update_fills` tool that handles pagination internally: accepts a selector + fill value, processes all matches in a single long-running operation with progress callbacks
- Expose `findAll` as a standalone tool that returns IDs, then a separate `batch_set_property` tool that operates on those IDs

---

## 3. Variable-bound fills render wrong color

**Problem:** Setting a fill with `figma.util.solidPaint('#FF0000')` then binding a variable via `setBoundVariableForPaint` results in the fill appearing RED, not the variable's resolved color.

**Why:** `solidPaint('#FF0000')` sets the base RGB to red. `setBoundVariableForPaint` adds the variable alias to `boundVariables.color` but does NOT update the underlying RGB values or opacity. Figma uses the base RGB as fallback/display, so it renders red.

**The fix:** Always use the correct base color matching the variable's resolved value:
```js
// ❌ Shows red
let f = figma.util.solidPaint('#FF0000');
f = figma.variables.setBoundVariableForPaint(f, 'color', sunkenVar);
// Result: red circle with variable "bound" but not visually applied

// ✅ Shows correct color
const f = {
  type: 'SOLID',
  visible: true,
  opacity: 0.04,  // Must match variable's alpha
  blendMode: 'NORMAL',
  color: { r: 0.135, g: 0.195, b: 0.254 }  // Must match variable's RGB
};
const bound = figma.variables.setBoundVariableForPaint(f, 'color', sunkenVar);
```

**Additional issue — variable color caching:**
Even with the correct approach, some nodes showed `surface/sunken` in the inspector but rendered with wrong color. Toggling to a different variable and back fixed it. This was unique to the first page; using the correct base color from the start on the second page avoided the issue entirely.

**Possible library fix:**
- A `figma_set_variable_fill` tool that accepts a variable ID, automatically resolves its current value (RGB + alpha), constructs the paint with correct base color + opacity, binds the variable, and applies it — all in one step
- This eliminates the footgun of mismatched base color vs variable value

---

## 4. `combineAsVariants()` — proxy error

**Error:** `proxy: inconsistent get` when calling `figma.combineAsVariants([comp1, comp2], parent)`

**Workaround:** Clone an existing COMPONENT_SET instead:
```js
// ❌ Fails
const set = figma.combineAsVariants([comp1, comp2], parent); // proxy error

// ✅ Works — clone existing set, swap vector content
const template = sets.find(s => s.name === 'jason/icons/CalendarNow');
const clone = template.clone(); // COMPONENT_SET with same variant structure
// Replace children's vectors, rename
```

---

## 5. `mainComponent` sync access blocked

**Error:** `Cannot call with documentAccess: dynamic-page. Use node.getMainComponentAsync instead.`

Accessing `.mainComponent` (sync) on instances fails. Must use `await node.getMainComponentAsync()`.

---

## Summary of recommended library improvements

1. **`figma_batch_update_fills`** tool — selector + fill value, handles pagination/batching internally
2. **`figma_set_variable_fill`** tool — takes variable ID, auto-resolves value, constructs correct paint
3. **Configurable timeout** for `run_script` (default 10s → option for 30s+)
4. **`getNodeByIdAsync` fallback** — detect compound instance IDs and use `findAll` + ID match transparently
5. **Section-scoped search** — a `figma_find_nodes` tool that accepts a scope node ID + predicate, returns matching IDs (separate from modification)
