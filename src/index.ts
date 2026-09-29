/**
 * obix-runtime
 *
 * The browser binding runtime and NOTHING else. No component business model,
 * no VDOM, no router, no DI, no store. Every DOM access lives inside a function
 * body — importing this module runs no DOM code, so a tree-shaker keeps only
 * the helpers a given component actually uses.
 *
 * Budget: the tree-shaken bundle of what a component imports is <= 4 KB
 * minified + gzipped (enforced by scripts/check-runtime-budget.mjs).
 */

export type Reader<T = unknown> = () => T;
export type Updater = () => void;
export type Cleanup = () => void;

/** Bind an element's text content to a reader. Returns its updater. */
export function bindText(node: Node, read: Reader): Updater {
  const update: Updater = () => {
    const v = read();
    node.textContent = v == null ? "" : String(v);
  };
  update();
  return update;
}

/** Bind a string/number attribute. `null`/`undefined`/`false` removes it. */
export function bindAttr(el: Element, name: string, read: Reader): Updater {
  const update: Updater = () => {
    const v = read();
    if (v == null || v === false) el.removeAttribute(name);
    else el.setAttribute(name, v === true ? "" : String(v));
  };
  update();
  return update;
}

/** Bind a boolean attribute (present when truthy, absent when falsy). */
export function bindBool(el: Element, name: string, read: Reader): Updater {
  const update: Updater = () => {
    if (read()) el.setAttribute(name, "");
    else el.removeAttribute(name);
  };
  update();
  return update;
}

/** Bind an `aria-*` attribute. Booleans become the strings "true"/"false". */
export function bindAria(el: Element, name: string, read: Reader): Updater {
  const attr = name.startsWith("aria-") ? name : `aria-${name}`;
  const update: Updater = () => {
    const v = read();
    if (v == null) el.removeAttribute(attr);
    else el.setAttribute(attr, v === true ? "true" : v === false ? "false" : String(v));
  };
  update();
  return update;
}

/** Toggle an element's presence in the DOM from a boolean reader (obix:if). */
export function bindPresence(el: Element, anchor: Comment, read: Reader): Updater {
  let mounted = el.isConnected;
  const update: Updater = () => {
    const show = Boolean(read());
    if (show && !mounted) {
      anchor.parentNode?.insertBefore(el, anchor);
      mounted = true;
    } else if (!show && mounted) {
      el.remove();
      mounted = false;
    }
  };
  update();
  return update;
}

/** Attach a DOM event listener. Returns a cleanup that removes it. */
export function bindEvent(el: Element, type: string, handler: EventListener): Cleanup {
  el.addEventListener(type, handler);
  return () => el.removeEventListener(type, handler);
}

/** A flat group of updaters flushed together after each state transition. */
export interface BindingGroup {
  add(update: Updater): void;
  addCleanup(cleanup: Cleanup): void;
  update(): void;
  dispose(): void;
}

export function createBindingGroup(): BindingGroup {
  const updaters = new Set<Updater>();
  const cleanups = new Set<Cleanup>();
  return {
    add: (u) => void updaters.add(u),
    addCleanup: (c) => void cleanups.add(c),
    update: () => {
      for (const u of updaters) u();
    },
    dispose: () => {
      for (const c of cleanups) c();
      cleanups.clear();
      updaters.clear();
    },
  };
}

// ── mount / update / unmount (Stage 4) ───────────────────────────────────────────────────────────
export { morph, MOUNT_ATTRIBUTE } from "./morph.js";
export type { MorphOptions, MorphStats } from "./morph.js";
export { createDelegator } from "./delegate.js";
export type { DelegatedHandler, Delegator } from "./delegate.js";
export { getMounted, mount } from "./mount.js";
export { focusableWithin, installBehaviors } from "./behaviors.js";
export type { Behaviors } from "./behaviors.js";
export type {
  ActionStyle,
  EventBinding,
  ManagedComponent,
  ManagedRuntime,
  MountableComponent,
  MountedComponent,
  MountOptions
} from "./mount.js";
