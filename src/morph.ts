/**
 * Keyed DOM morph: make the children of a container equal to an HTML string by changing the live DOM in place.
 *
 * Why not `container.innerHTML = html` on every render (what the Gen-1 mount did)? It destroys and recreates every node, so
 * focus, text selection, caret, scroll position, IME composition and any state held by a child (a nested mount, a media
 * element) are lost on each state change. Morphing reuses the nodes that are still wanted and only touches what differs.
 *
 * Identity of an element among its siblings: `data-obix-key` (configurable), else `id`. Unkeyed elements are matched by
 * position and tag. A subtree whose root carries `data-obix-mount` belongs to a nested mount and is never entered.
 * User input is respected: a form control's `value` / `checked` property is only written when the rendered *attribute* changed,
 * so text the user typed survives re-renders that did not change the field.
 *
 * The HTML is parsed inertly (`<template>`) — scripts do not run — but it is inserted as markup: render output must be trusted or
 * escaped by the component, exactly as with `innerHTML`.
 */

/** Attribute owned by the driver: marks an element whose children belong to a mount. Never synchronised from rendered HTML. */
export const MOUNT_ATTRIBUTE = "data-obix-mount";

export interface MorphOptions {
  /** Attribute that gives an element a stable identity among its siblings. Default `data-obix-key`. */
  keyAttribute?: string;
  /** Called for each element removed from the tree (the root of the removed subtree). Used to unmount nested mounts. */
  onRemove?: (element: Element) => void;
}

export interface MorphStats {
  /** Nodes created from the new markup. */
  created: number;
  /** Old nodes removed. */
  removed: number;
  /** Existing nodes that had to be re-inserted at another position (a reorder). */
  moved: number;
  /** Existing nodes kept and patched in place. */
  reused: number;
  /** Attributes added, changed or removed on reused elements. */
  attributesChanged: number;
  /** Text and comment nodes whose data changed. */
  textChanged: number;
}

interface Context {
  keyAttribute: string;
  onRemove?: (element: Element) => void;
  stats: MorphStats;
  doc: Document;
}

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT;

function keyOf(node: Node, keyAttribute: string): string | null {
  if (!isElement(node)) return null;
  return node.getAttribute(keyAttribute) ?? node.getAttribute("id");
}

function compatible(old: Node, fresh: Node): boolean {
  if (old.nodeType !== fresh.nodeType) return false;
  return isElement(old) ? old.tagName === (fresh as Element).tagName : true;
}

/** The DOM `indeterminate` property has no attribute; a checkbox declares it with `data-indeterminate` and the driver copies it onto the property. */
function markIndeterminate(root: Element): void {
  const boxes = root.matches?.("input[data-indeterminate]") ? [root, ...Array.from(root.querySelectorAll("input[data-indeterminate]"))] : Array.from(root.querySelectorAll("input[data-indeterminate]"));
  for (const box of boxes) (box as HTMLInputElement).indeterminate = true;
}

/** Morph `container`'s children to match `html`. Returns what changed. */
export function morph(container: Element, html: string, options: MorphOptions = {}): MorphStats {
  const doc = container.ownerDocument;
  const template = doc.createElement("template");
  template.innerHTML = html;
  const stats: MorphStats = { created: 0, removed: 0, moved: 0, reused: 0, attributesChanged: 0, textChanged: 0 };
  morphChildren(container, template.content, {
    keyAttribute: options.keyAttribute ?? "data-obix-key",
    onRemove: options.onRemove,
    stats,
    doc
  });
  return stats;
}

function morphChildren(parent: Element | DocumentFragment, source: Node, ctx: Context): void {
  const fresh = Array.from(source.childNodes);
  const olds = Array.from(parent.childNodes);

  // Pass 1 — decide the match of every new child (pure: nothing in the DOM changes yet).
  // Old nodes per key, in document order: duplicate keys (a mistake in the markup, or the HTML parser splitting a tree) are
  // matched first-come-first-served, so a render that repeats a key is still stable instead of recreating the extras every time.
  const keyed = new Map<string, Node[]>();
  for (const old of olds) {
    const key = keyOf(old, ctx.keyAttribute);
    if (key === null) continue;
    const group = keyed.get(key);
    if (group) group.push(old);
    else keyed.set(key, [old]);
  }
  const used = new Set<Node>();
  const matches: Array<Node | null> = [];
  let cursor = 0;
  for (const next of fresh) {
    let match: Node | null = null;
    const key = keyOf(next, ctx.keyAttribute);
    if (key !== null) {
      const candidate = keyed.get(key)?.find((old) => !used.has(old));
      if (candidate && compatible(candidate, next)) match = candidate;
    } else {
      // Unkeyed: the next unkeyed old node decides. Keyed old nodes are only ever matched by key.
      while (cursor < olds.length && (used.has(olds[cursor]) || keyOf(olds[cursor], ctx.keyAttribute) !== null)) cursor++;
      if (cursor < olds.length && compatible(olds[cursor], next)) match = olds[cursor++];
    }
    if (match) used.add(match);
    matches.push(match);
  }

  // Pass 2 — remove what nobody matched, so a stale node can never force a needless move of a kept one.
  for (const old of olds) {
    if (used.has(old)) continue;
    parent.removeChild(old);
    ctx.stats.removed++;
    if (isElement(old)) ctx.onRemove?.(old);
  }

  // Pass 3 — walk the new children in order: keep in place, re-insert (reorder) or create.
  let position: Node | null = parent.firstChild;
  fresh.forEach((next, index) => {
    const match = matches[index];
    if (match) {
      if (match === position) position = position.nextSibling;
      else {
        parent.insertBefore(match, position);
        ctx.stats.moved++;
      }
      patch(match, next, ctx);
      ctx.stats.reused++;
    } else {
      const created = ctx.doc.importNode(next, true);
      parent.insertBefore(created, position);
      if (isElement(created)) markIndeterminate(created);
      ctx.stats.created++;
    }
  });
}

function patch(old: Node, fresh: Node, ctx: Context): void {
  if (old.nodeType === TEXT || old.nodeType === COMMENT) {
    if (old.nodeValue !== fresh.nodeValue) {
      old.nodeValue = fresh.nodeValue;
      ctx.stats.textChanged++;
    }
    return;
  }
  const el = old as Element;
  const next = fresh as Element;
  const written = syncAttributes(el, next, ctx);
  if (el.hasAttribute(MOUNT_ATTRIBUTE)) return; // a nested mount owns everything below this element

  if (el.tagName === "TEXTAREA") {
    const before = (el as HTMLTextAreaElement).defaultValue;
    morphChildren(el, next, ctx);
    const after = (el as HTMLTextAreaElement).defaultValue;
    if (before !== after) (el as HTMLTextAreaElement).value = after; // the rendered value changed: the field follows it
    return;
  }
  morphChildren(el, next, ctx);

  // Form-control PROPERTIES drift from their attributes once the user interacts; write them only when the rendered attribute moved.
  if (el.tagName === "INPUT") {
    const input = el as HTMLInputElement;
    if (written.has("value")) input.value = next.getAttribute("value") ?? "";
    if (written.has("checked")) input.checked = next.hasAttribute("checked");
    if (written.has("data-indeterminate")) input.indeterminate = next.hasAttribute("data-indeterminate");
  } else if (el.tagName === "OPTION" && written.has("selected")) {
    (el as HTMLOptionElement).selected = next.hasAttribute("selected");
  }
}

/** Make `el`'s attributes equal `next`'s (except driver-owned ones). Returns the names that were written or removed. */
function syncAttributes(el: Element, next: Element, ctx: Context): Set<string> {
  const written = new Set<string>();
  for (const attribute of Array.from(next.attributes)) {
    if (attribute.name.startsWith(MOUNT_ATTRIBUTE)) continue;
    if (el.getAttribute(attribute.name) !== attribute.value) {
      el.setAttribute(attribute.name, attribute.value);
      written.add(attribute.name);
      ctx.stats.attributesChanged++;
    }
  }
  for (const attribute of Array.from(el.attributes)) {
    if (attribute.name.startsWith(MOUNT_ATTRIBUTE) || next.hasAttribute(attribute.name)) continue;
    el.removeAttribute(attribute.name);
    written.add(attribute.name);
    ctx.stats.attributesChanged++;
  }
  return written;
}
