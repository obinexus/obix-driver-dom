/**
 * mount / update / unmount — the DOM projection of an OBIX component.
 *
 * `mount(container, component, options)` renders the component's HTML into `container` by morphing (focus, selection, scroll and
 * nested mounts survive), listens for events through ONE delegated listener per event type (the count does not grow with renders or
 * clicks), routes every interaction through `dispatch` (there is no app-level re-wiring), and cleans up completely on `unmount`.
 *
 * A component is either
 *   - a plain `{ state, actions, render }` object (the documented component shape; `props` optional), or
 *   - a managed runtime instance `{ runtime, instanceId }` (an `ObixRuntime`): state and actions live in the runtime, the driver renders
 *     `UPDATED`/`HALTED` events, follows `DESTROYED`, and announces `MOUNTED` — the one lifecycle hook only a mounting driver may emit.
 *
 * Actions of a plain component are called according to an explicit `actionStyle` (never guessed from arity):
 *   - `partial` (default)  `(state, ...args) ⇒ Partial<state>`, merged. Covers the documented full-next-state actions AND the Gen-1 factories that
 *                          return a delta; replacing the state with a delta is what corrupted Gen-1 components on first dispatch (baseline P8).
 *   - `component`          `(state, ...args) ⇒ nextState`, replaces the state.
 *   - `canonical`          `(state, payload, props) ⇒ nextState` (Draft 0.2.1 Amendment §4); one payload argument.
 *
 * Declarative events: an element with `data-obix-action="name"` dispatches `name` on `click` (or the event in `data-obix-event`,
 * e.g. `input`, `change`, `submit`, `keydown:Enter`). `data-obix-arg` gives the argument: JSON, a plain string, or `@value`, `@checked`,
 * `@key` (read from the event target / event) or `@attr:name`. `aria-disabled="true"` elements never dispatch. `submit` is default-prevented.
 * `data-obix-on="click=toggle; input=change(@value); keydown:Enter=save!; blur=touch"` declares several bindings on one element (`!` = preventDefault).
 * Keyboard/focus patterns are declared with `data-obix-roving`, `data-obix-dismiss` and `data-obix-trap` (behaviors.ts).
 * Explicit `events` bindings (selector, action or handler) are supported as well — this is the Gen-1 `mount` shape.
 */
import { createDelegator, type Delegator } from "./delegate.js";
import { installBehaviors, type Behaviors } from "./behaviors.js";
import { MOUNT_ATTRIBUTE, morph, type MorphStats } from "./morph.js";

export type ActionStyle = "partial" | "component" | "canonical";

/** The documented component shape. */
export interface MountableComponent<S extends object = Record<string, unknown>> {
  state: S;
  actions: Record<string, (...args: any[]) => any>;
  render: (state: S, props?: any) => string;
  props?: Record<string, unknown>;
}

/** Structural view of an `ObixRuntime` (this package has no dependencies, so it does not import the class). */
export interface ManagedRuntime {
  getInstance(instanceId: string): { currentState: any; definition: { render: (state: any, props?: any) => string } } | null;
  update(instanceId: string, actionName: string, ...args: any[]): unknown;
  onLifecycle(handler: (event: { hook: string; instanceId: string }) => void): () => void;
  undo?(instanceId: string): unknown;
  announceMounted?(instanceId: string): void;
}

export interface ManagedComponent {
  runtime: ManagedRuntime;
  instanceId: string;
}

export interface EventBinding<S extends object> {
  event: string;
  selector: string;
  /** Dispatch this action… */
  action?: string;
  /** …with these arguments (or the result of this function)… */
  args?: unknown[] | ((event: Event, match: Element) => unknown[]);
  /** …or run this instead. */
  handler?: (api: MountedComponent<S>, event: Event, match: Element) => void;
  preventDefault?: boolean;
}

export interface MountOptions<S extends object> {
  props?: Record<string, unknown>;
  actionStyle?: ActionStyle;
  events?: EventBinding<S>[];
  /** Event types to delegate up front. Types declared by the rendered markup (`data-obix-on`, `data-obix-event`) are added automatically. */
  declarativeEvents?: string[];
  /** Identity attribute for keyed morphing. Default `data-obix-key`. */
  keyAttribute?: string;
  /** Retained states for `undo()` on a plain component. Default 50. */
  history?: number;
  /** Install the keyboard/focus behaviours declared in markup (`data-obix-roving`, `-dismiss`, `-trap`; see behaviors.ts). Default true. */
  behaviors?: boolean;
  /** Coalesce several dispatches in one task into one render (microtask). Default false: render synchronously. */
  batch?: boolean;
  /** Put the focus back (with its selection) on the same element after a render that had to replace or move it. Default true. */
  preserveFocus?: boolean;
  /** Empty the container on unmount. Default true. */
  clearOnUnmount?: boolean;
  /** Called with each rendered HTML string. */
  onRender?: (html: string, state: S, stats: MorphStats) => void;
  /** Called after each render, with the container: mount nested components here. */
  afterRender?: (state: S, container: Element) => void;
  /** Called once, after the first render is in the document. */
  onMounted?: (api: MountedComponent<S>) => void;
}

export interface MountedComponent<S extends object> {
  readonly container: Element;
  /** True until `unmount()` (or the managed instance is destroyed). */
  readonly mounted: boolean;
  getState(): S;
  getProps(): Readonly<Record<string, unknown>>;
  /** Apply an action; returns the resulting state. */
  dispatch(actionName: string, ...args: any[]): S;
  /** Merge new props and re-render (plain components). */
  setProps(props: Record<string, unknown>): void;
  /** Re-render now; returns the HTML that was rendered. */
  render(): string;
  /** Go back one retained state. */
  undo(): S;
  /** Called after every state change. Returns an unsubscribe. */
  subscribe(listener: (state: S) => void): () => void;
  /** Remove listeners and subscriptions, unmount nested mounts and (by default) empty the container. Idempotent. */
  unmount(): void;
}

const mounts = new WeakMap<Element, MountedComponent<any>>();

/** The mount that currently owns `container`, if any. */
export function getMounted<S extends object = Record<string, unknown>>(container: Element): MountedComponent<S> | undefined {
  return mounts.get(container);
}

const MAX_RERENDERS = 100;

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function shallowEqual(a: object, b: object): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const isManaged = (c: unknown): c is ManagedComponent => !!c && typeof c === "object" && "runtime" in c && "instanceId" in c;

/**
 * `Enter`, `Space`, `ArrowDown`, … or with modifiers: `Shift+Tab`, `Ctrl+Enter`, `Alt+ArrowDown`, `Meta+k`. The modifiers must match exactly:
 * `PageUp` does not answer `Shift+PageUp` (a different command), and `Enter` does not answer `Ctrl+Enter`.
 */
function keyMatches(event: Event, wanted: string): boolean {
  const e = event as KeyboardEvent;
  const parts = wanted === "+" ? ["+"] : wanted.split("+");
  const name = parts.pop() as string;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  if (e.shiftKey !== mods.has("shift") || e.altKey !== mods.has("alt") || e.ctrlKey !== (mods.has("ctrl") || mods.has("control")) || e.metaKey !== (mods.has("meta") || mods.has("cmd"))) return false;
  return name === "Space" ? e.key === " " || e.key === "Spacebar" : e.key === name;
}

/** Argument syntax shared by `data-obix-arg` and `data-obix-on`: `@value`, `@checked`, `@key`, `@attr:name` (an attribute of the element that declared the binding), `@prop:name` (a property of the event target, e.g. a media element's `volume`), `@selected` (values of a <select>), `@files` (file descriptors), `@form` (the owning form's fields), JSON, or a plain string. */
function resolveArg(raw: string, match: Element, event: Event): unknown {
  const target = event.target as (Element & { value?: unknown; checked?: unknown }) | null;
  if (raw === "@value") return target?.value;
  if (raw === "@checked") return target?.checked;
  if (raw === "@key") return (event as KeyboardEvent).key;
  if (raw.startsWith("@attr:")) return match.getAttribute(raw.slice(6));
  if (raw.startsWith("@prop:")) return (target as Record<string, unknown> | null)?.[raw.slice(6)];
  if (raw === "@selected") {
    // the values chosen in a <select> (all of them when it is `multiple`)
    const options = (target as HTMLSelectElement | null)?.selectedOptions;
    return options ? Array.from(options).map((o) => o.value) : [];
  }
  if (raw === "@files") {
    // plain descriptors of the files of a file input or of a drop (the File objects stay in the browser's input / the event)
    const list = (target as HTMLInputElement | null)?.files ?? (event as DragEvent).dataTransfer?.files;
    return list ? Array.from(list).map((f) => ({ name: f.name, size: f.size, type: f.type })) : [];
  }
  if (raw === "@form") {
    // the fields of the form that owns the event target, as a plain object (repeated names collect into arrays)
    const form = (target?.closest?.("form") ?? (event.currentTarget as Element | null)?.closest?.("form")) as HTMLFormElement | null;
    const out: Record<string, unknown> = {};
    if (form) {
      // the form's own window's FormData (the global one may belong to another realm, e.g. a test document)
      const FormDataOf = (form.ownerDocument.defaultView as (Window & typeof globalThis) | null)?.FormData ?? FormData;
      for (const [name, value] of new FormDataOf(form)) {
        const text = typeof value === "string" ? value : value.name;
        out[name] = name in out ? ([] as unknown[]).concat(out[name], text) : text;
      }
    }
    return out;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readArgs(match: Element, event: Event): unknown[] {
  const raw = match.getAttribute("data-obix-arg");
  return raw === null ? [] : [resolveArg(raw, match, event)];
}

interface OnBinding {
  event: string;
  /** `click.self=…`: only when the event's target is the declaring element itself (a backdrop, not what is inside it). */
  self: boolean;
  key: string | undefined;
  action: string;
  arg: string | undefined;
  prevent: boolean;
}

const onCache = new Map<string, OnBinding[]>();

/** `data-obix-on="click=toggle; input=change(@value); keydown:Enter=submit!; blur=touch"` — several bindings on one element. `!` prevents the default action. */
function parseOn(source: string): OnBinding[] {
  const cached = onCache.get(source);
  if (cached) return cached;
  const parsed: OnBinding[] = [];
  for (const part of source.split(";")) {
    const m = /^\s*([A-Za-z]+)(\.self)?(?::([^=\s]+))?\s*=\s*([A-Za-z_][\w.-]*)(!)?\s*(?:\((.*)\))?\s*(!)?\s*$/.exec(part);
    if (m) parsed.push({ event: m[1], self: !!m[2], key: m[3], action: m[4], arg: m[6], prevent: !!(m[5] || m[7]) });
  }
  onCache.set(source, parsed);
  return parsed;
}

interface Source<S extends object> {
  getState(): S;
  getProps(): Readonly<Record<string, unknown>>;
  setProps(props: Record<string, unknown>): boolean;
  dispatch(actionName: string, args: unknown[]): boolean;
  undo(): boolean;
  render(state: S): string;
  /** Tell the mount that something changed outside `dispatch` (managed instances). Returns the unsubscribe. */
  watch(changed: () => void, destroyed: () => void): () => void;
}

function plainSource<S extends object>(component: MountableComponent<S>, options: MountOptions<S>): Source<S> {
  const style: ActionStyle = options.actionStyle ?? "partial";
  const limit = Math.max(1, options.history ?? 50);
  let state = component.state;
  let props: Readonly<Record<string, unknown>> = Object.freeze({ ...(component.props ?? {}), ...(options.props ?? {}) });
  const past: S[] = [];
  return {
    getState: () => state,
    getProps: () => props,
    setProps(next) {
      props = Object.freeze({ ...props, ...next });
      return true;
    },
    dispatch(actionName, args) {
      const action = component.actions[actionName];
      if (typeof action !== "function") throw new Error(`Action '${actionName}' not found on component`);
      const where = `Action '${actionName}' (actionStyle '${style}')`;
      let next: S;
      if (style === "partial") {
        next = { ...state, ...(action(state, ...args) ?? {}) };
      } else if (style === "component") {
        const result = action(state, ...args);
        if (!isPlain(result)) throw new TypeError(`${where} must return the next state object`);
        next = result as S;
      } else {
        if (args.length > 1) throw new TypeError(`${where} takes a single payload argument, got ${args.length}`);
        const result = action(state, args[0], props);
        if (!isPlain(result)) throw new TypeError(`${where} must return the next state object`);
        next = result as S;
      }
      if (shallowEqual(state, next)) return false; // nothing changed: nobody is notified, nothing renders
      past.push(state);
      if (past.length > limit) past.shift();
      state = next;
      return true;
    },
    undo() {
      const previous = past.pop();
      if (previous === undefined) return false;
      state = previous;
      return true;
    },
    render: (s) => component.render(s, props),
    watch: () => () => undefined
  };
}

function managedSource<S extends object>(managed: ManagedComponent, options: MountOptions<S>): Source<S> {
  const { runtime, instanceId } = managed;
  let lastState: S | undefined;
  const instance = () => runtime.getInstance(instanceId);
  return {
    getState: () => (lastState = (instance()?.currentState as S | undefined) ?? lastState ?? ({} as S)),
    getProps: () => Object.freeze({ ...(options.props ?? {}) }),
    setProps: () => false,
    dispatch(actionName, args) {
      const before = instance()?.currentState;
      runtime.update(instanceId, actionName, ...args);
      return instance()?.currentState !== before;
    },
    undo() {
      const before = instance()?.currentState;
      runtime.undo?.(instanceId);
      return instance()?.currentState !== before;
    },
    render: (s) => {
      const definition = instance()?.definition;
      if (!definition) return "";
      return definition.render(s, options.props);
    },
    watch(changed, destroyed) {
      return runtime.onLifecycle((event) => {
        if (event.instanceId !== instanceId) return;
        if (event.hook === "UPDATED" || event.hook === "HALTED") changed();
        else if (event.hook === "DESTROYED") destroyed();
      });
    }
  };
}

const cssString = (value: string): string => value.replace(/["\\]/g, "\\$&");

interface SavedFocus {
  element: Element;
  key: string | null;
  selection: { start: number; end: number; direction: "forward" | "backward" | "none" } | null;
}

function captureFocus(container: Element, keyAttribute: string): SavedFocus | null {
  const doc = container.ownerDocument;
  const active = doc.activeElement;
  if (!active || active === doc.body || active === container || !container.contains(active)) return null;
  let selection: SavedFocus["selection"] = null;
  try {
    const field = active as HTMLInputElement;
    if (typeof field.selectionStart === "number" && typeof field.selectionEnd === "number") {
      selection = { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? "none" };
    }
  } catch {
    /* input types without a selection (checkbox, number, …) throw on access */
  }
  return { element: active, key: active.getAttribute(keyAttribute) ?? active.getAttribute("id"), selection };
}

function restoreFocus(container: Element, saved: SavedFocus | null, keyAttribute: string): void {
  if (!saved) return;
  const doc = container.ownerDocument;
  if (doc.activeElement === saved.element) return; // the element survived and kept focus: nothing to do
  let target: Element | null = container.contains(saved.element) ? saved.element : null;
  if (!target && saved.key !== null) {
    target = container.querySelector(`[${keyAttribute}="${cssString(saved.key)}"]`) ?? container.querySelector(`[id="${cssString(saved.key)}"]`);
  }
  const focusable = target as (HTMLElement & Partial<HTMLInputElement>) | null;
  if (!focusable || typeof focusable.focus !== "function") return;
  focusable.focus({ preventScroll: true });
  if (saved.selection && typeof focusable.setSelectionRange === "function") {
    try {
      focusable.setSelectionRange(saved.selection.start, saved.selection.end, saved.selection.direction);
    } catch {
      /* not selectable */
    }
  }
}

export function mount<S extends object = Record<string, unknown>>(
  container: Element,
  component: MountableComponent<S> | ManagedComponent,
  options: MountOptions<S> = {}
): MountedComponent<S> {
  if (mounts.has(container)) throw new Error("this container already has a mounted component; unmount it first");
  const keyAttribute = options.keyAttribute ?? "data-obix-key";
  const source: Source<S> = isManaged(component)
    ? managedSource<S>(component, options)
    : plainSource<S>(component as MountableComponent<S>, options);
  const delegator: Delegator = createDelegator(container);
  const listeners = new Set<(state: S) => void>();
  let active = true;
  let rendering = false;
  let dirty = false;
  let scheduled = false;
  let firstRender = true;
  let stopWatching: () => void = () => undefined;
  let ensureWired: () => void = () => undefined;

  const unmountNested = (element: Element): void => {
    const nested = [element, ...Array.from(element.querySelectorAll(`[${MOUNT_ATTRIBUTE}]`))];
    for (const node of nested) if (node !== container) mounts.get(node)?.unmount();
  };

  const renderNow = (): string => {
    if (!active) return "";
    if (rendering) {
      dirty = true;
      return "";
    }
    rendering = true;
    let html = "";
    try {
      let rounds = 0;
      do {
        dirty = false;
        if (++rounds > MAX_RERENDERS) throw new Error(`render did not settle after ${MAX_RERENDERS} rounds: an afterRender/onRender hook keeps changing the state`);
        const state = source.getState();
        html = source.render(state);
        behaviors?.beforeRender();
        const saved = options.preserveFocus === false ? null : captureFocus(container, keyAttribute);
        const stats = morph(container, html, { keyAttribute, onRemove: unmountNested });
        restoreFocus(container, saved, keyAttribute);
        options.onRender?.(html, state, stats);
        ensureWired();
        behaviors?.afterRender();
        options.afterRender?.(state, container);
      } while (dirty && active);
    } finally {
      rendering = false;
    }
    return html;
  };

  const requestRender = (): void => {
    if (!active) return;
    if (!options.batch) {
      renderNow();
      return;
    }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderNow();
    });
  };

  const changed = (): void => {
    if (!active) return;
    const state = source.getState();
    for (const listener of [...listeners]) listener(state);
    requestRender();
  };

  const api: MountedComponent<S> = {
    container,
    get mounted() {
      return active;
    },
    getState: () => source.getState(),
    getProps: () => source.getProps(),
    dispatch(actionName, ...args) {
      if (!active) throw new Error("this component is unmounted");
      // A managed instance announces its own changes through its lifecycle events; a plain one is told here.
      if (source.dispatch(actionName, args) && !isManaged(component)) changed();
      return source.getState();
    },
    setProps(props) {
      if (active && source.setProps(props)) requestRender();
    },
    render: () => renderNow(),
    undo() {
      if (active && source.undo() && !isManaged(component)) changed();
      return source.getState();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    unmount() {
      if (!active) return;
      active = false;
      stopWatching();
      behaviors?.dispose();
      delegator.dispose();
      unmountNested(container);
      listeners.clear();
      mounts.delete(container);
      container.removeAttribute(MOUNT_ATTRIBUTE);
      if (options.clearOnUnmount !== false) while (container.firstChild) container.removeChild(container.firstChild);
    }
  };

  // Wiring: explicit bindings first, then the declarative `data-obix-action` convention.
  for (const binding of options.events ?? []) {
    delegator.on(binding.event, binding.selector, (event, match) => {
      if (!active) return;
      if (binding.preventDefault) event.preventDefault();
      if (binding.handler) return binding.handler(api, event, match);
      if (!binding.action) return;
      const args = typeof binding.args === "function" ? binding.args(event, match) : binding.args ?? [];
      api.dispatch(binding.action, ...args);
    });
  }
  // Delegated listeners are added lazily, per event type, the first time the rendered markup declares that type (`data-obix-on` /
  // `data-obix-event`). A component that only uses clicks costs one listener; the count depends on the markup, never on the number of
  // renders, clicks or elements. `declarativeEvents` pre-registers types explicitly.
  const wired = new Set<string>();
  const wire = (type: string): void => {
    if (wired.has(type)) return;
    wired.add(type);
    delegator.on(type, "[data-obix-action]", (event, match) => {
      if (!active || match.getAttribute("aria-disabled") === "true") return;
      const [eventType, keyFilter] = (match.getAttribute("data-obix-event") ?? "click").split(":");
      if (eventType !== type || (keyFilter && !keyMatches(event, keyFilter))) return;
      const prevent = match.getAttribute("data-obix-prevent");
      if (prevent === "true" || (type === "submit" && prevent !== "false")) event.preventDefault();
      const then = match.getAttribute("data-obix-then-focus");
      api.dispatch(match.getAttribute("data-obix-action") as string, ...readArgs(match, event));
      if (then) behaviors?.focusTarget(then);
    });
    delegator.on(type, "[data-obix-on]", (event, match) => {
      if (!active || match.getAttribute("aria-disabled") === "true") return;
      for (const binding of parseOn(match.getAttribute("data-obix-on") ?? "")) {
        if (binding.event !== type || (binding.key && !keyMatches(event, binding.key)) || (binding.self && event.target !== match)) continue;
        if (binding.prevent || type === "submit") event.preventDefault();
        // read before dispatching: the render may reuse this very element for something else (positional morph), taking the attribute with it
        const then = match.getAttribute("data-obix-then-focus");
        api.dispatch(binding.action, ...(binding.arg === undefined ? [] : [resolveArg(binding.arg, match, event)]));
        // the control that was used may be gone after the render (clear / dismiss buttons): send the focus somewhere sensible
        if (then) behaviors?.focusTarget(then);
      }
    }, { bubble: true });
  };
  ensureWired = () => {
    for (const el of Array.from(container.querySelectorAll("[data-obix-on]"))) for (const b of parseOn(el.getAttribute("data-obix-on") ?? "")) wire(b.event);
    for (const el of Array.from(container.querySelectorAll("[data-obix-action]"))) wire((el.getAttribute("data-obix-event") ?? "click").split(":")[0] as string);
  };
  for (const type of options.declarativeEvents ?? []) wire(type);
  const behaviors: Behaviors | null = options.behaviors === false ? null : installBehaviors(container, delegator, (action, ...args) => api.dispatch(action, ...(args as any[])), () => scheduled);

  container.setAttribute(MOUNT_ATTRIBUTE, "");
  mounts.set(container, api);
  stopWatching = source.watch(changed, () => api.unmount());
  renderNow();

  if (firstRender && active) {
    firstRender = false;
    if (isManaged(component)) component.runtime.announceMounted?.(component.instanceId);
    options.onMounted?.(api);
  }
  return api;
}
