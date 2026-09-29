/**
 * Keyboard and focus behaviours that components declare in their markup (WAI-ARIA Authoring Practices patterns), implemented once here
 * instead of in every component and application:
 *
 *  `data-obix-roving="horizontal|vertical|both"`  Arrow keys / Home / End move focus between the container's items
 *                                                  (`role` tab, radio, menuitem*, option, or `data-obix-roving-item`); disabled items are skipped and
 *                                                  the ends wrap. With `data-obix-follow-focus` the newly focused item is also clicked, so selection
 *                                                  follows focus (automatic activation: tabs, radio groups).
 *  `data-obix-dismiss="action"` or `"action(arg)"`  Escape inside the element dispatches `action` (close a dialog, menu, popup, tooltip…); with
 *                                                  `data-obix-dismiss-focus="#trigger"` the focus is returned to that element afterwards.
 *  `data-obix-trap`                               Tab and Shift+Tab cycle within the element. When such an element appears in a render, focus moves into it
 *                                                  (`data-obix-autofocus` first, else the first focusable, else the element itself) and the previously
 *                                                  focused element is remembered; when it disappears, focus returns there (modal dialog pattern).
 *
 *  `data-obix-focus-scope` / `data-obix-focus`                 State-driven roving focus: after a render, focus follows the element marked `data-obix-focus` when it is inside
 *                                                  the scope it was already in (calendar days, menu items). `data-obix-autoexpand` on a <textarea> grows it with its content.
 *
 *  `data-obix-then-focus="#id"` (on an element with `data-obix-on`)   After the actions of that element ran and the resulting render is done, focus moves to the element
 *                                                  with that id (`#id` is an exact id, any other value a CSS selector). For controls that vanish when used: a clear
 *                                                  button, a dismiss button.
 *  `data-obix-after="action:ms"`                  A timer the markup owns: `ms` after the element appears in a render, `action` is dispatched once. While the element
 *                                                  also carries `data-obix-after-paused` the timer is suspended and resumes with the time that was left (toast auto-dismiss
 *                                                  that pauses on hover and focus). Timers of elements that leave the DOM are cancelled; unmounting cancels all of them.
 *
 *  `data-obix-media="playing=true;volume=0.5;muted=false;time=12;captions=en"`  On a <video>/<audio>: applies the declared playback state to the element after a
 *                                                  render — only the keys whose declared value CHANGED since the last render, so the user's own use of the native
 *                                                  controls is not fought. The reverse direction (element → state) is ordinary delegated events
 *                                                  (`play=…; pause=…; volumechange=…`).
 *
 * Everything is delegated through the mount's delegator: no listener is added per element, and nothing needs cleaning when elements go away.
 */
import type { Delegator } from "./delegate.js";

export interface Behaviors {
  /** Call just before each render: remembers which focus scope holds the focus, so it can be given back if the render removes the focused element. */
  beforeRender(): void;
  /** Call after each render: moves focus into / out of trapping elements, runs pending focus requests, syncs timers. */
  afterRender(): void;
  /** Focus the element `spec` names (`#id` or a selector) — now, or after the next render when one is already scheduled. */
  focusTarget(spec: string): void;
  /** Restore focus if a trap is still open, then forget everything. */
  dispose(): void;
}

const ROVING_ITEMS = '[role="tab"],[role="radio"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[data-obix-roving-item]';
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

const isUsable = (el: Element): boolean =>
  !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true" && !(el as HTMLElement).closest("[hidden]");

export function focusableWithin(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isUsable);
}

function rovingItems(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ROVING_ITEMS)).filter(
    (el) => isUsable(el) && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true"
  );
}

const KEYS: Record<string, { next: string[]; prev: string[] }> = {
  horizontal: { next: ["ArrowRight"], prev: ["ArrowLeft"] },
  vertical: { next: ["ArrowDown"], prev: ["ArrowUp"] },
  both: { next: ["ArrowRight", "ArrowDown"], prev: ["ArrowLeft", "ArrowUp"] }
};

export function installBehaviors(
  root: Element,
  delegator: Delegator,
  dispatch: (action: string, ...args: unknown[]) => void,
  renderPending: () => boolean = () => false
): Behaviors {
  const doc = root.ownerDocument;

  // Focus requests (data-obix-then-focus, data-obix-dismiss-focus). When a render is still scheduled (batched mounts) the focus waits for it.
  let pendingFocus: string | null = null;
  const resolveTarget = (spec: string): HTMLElement | null => {
    if (/^#\S+$/.test(spec)) return doc.getElementById(spec.slice(1)); // exact id: needs no CSS escaping
    try {
      return root.querySelector<HTMLElement>(spec);
    } catch {
      return null; // not a valid selector
    }
  };
  const focusNow = (spec: string): void => resolveTarget(spec)?.focus({ preventScroll: true });
  const focusTarget = (spec: string): void => {
    if (renderPending()) pendingFocus = spec;
    else focusNow(spec);
  };

  // Each behaviour's delegated listener is added the first time the rendered markup uses it, so a component that declares no dismiss, roving,
  // trap, keep-focus or autoexpand costs no listener at all (the count depends on the markup, never on renders or elements).
  const lazy: Array<{ selector: string; install: () => void; on: boolean }> = [];
  const declare = (selector: string, install: () => void): void => void lazy.push({ selector, install, on: false });
  const activate = (): void => {
    for (const entry of lazy) {
      if (entry.on || !root.querySelector(entry.selector)) continue;
      entry.on = true;
      entry.install();
    }
  };

  // Escape → dismiss action
  declare("[data-obix-dismiss]", () =>
    delegator.on("keydown", "[data-obix-dismiss]", (event, match) => {
    if ((event as KeyboardEvent).key !== "Escape" || event.defaultPrevented) return;
    const spec = /^\s*([\w.-]+)\s*(?:\((.*)\))?\s*$/.exec(match.getAttribute("data-obix-dismiss") ?? "");
    if (!spec) return;
    event.preventDefault();
    let arg: unknown;
    if (spec[2] !== undefined) {
      try {
        arg = JSON.parse(spec[2]);
      } catch {
        arg = spec[2];
      }
    }
    dispatch(spec[1] as string, ...(spec[2] === undefined ? [] : [arg]));
    // a menu or popup that closed under the keyboard hands the focus back to its trigger
    const back = match.getAttribute("data-obix-dismiss-focus");
    if (back) focusTarget(back);
    }));

  // data-obix-keep-focus: pressing the mouse inside must not steal focus from the control that owns the popup (listbox options, menu items)
  declare("[data-obix-keep-focus]", () => delegator.on("mousedown", "[data-obix-keep-focus]", (event) => event.preventDefault()));

  // Roving focus
  declare("[data-obix-roving]", () =>
    delegator.on("keydown", "[data-obix-roving]", (event, container) => {
    const key = (event as KeyboardEvent).key;
    if ((event as KeyboardEvent).altKey || (event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey) return;
    const orientation = container.getAttribute("data-obix-roving") || "both";
    const map = KEYS[orientation] ?? KEYS.both;
    const items = rovingItems(container);
    if (!items.length) return;
    const current = items.findIndex((item) => item === event.target || item.contains(event.target as Node));
    let target: number | null = null;
    if (map.next.includes(key)) target = current < 0 ? 0 : (current + 1) % items.length;
    else if (map.prev.includes(key)) target = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (key === "Home") target = 0;
    else if (key === "End") target = items.length - 1;
    if (target === null) return;
    event.preventDefault();
    const next = items[target];
    next.focus();
    if (container.hasAttribute("data-obix-follow-focus")) next.click();
    }));

  // Tab cycling inside a trap
  declare("[data-obix-trap]", () =>
    delegator.on("keydown", "[data-obix-trap]", (event, trap) => {
    if ((event as KeyboardEvent).key !== "Tab") return;
    const items = focusableWithin(trap);
    if (!items.length) {
      event.preventDefault();
      (trap as HTMLElement).focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if ((event as KeyboardEvent).shiftKey && (active === first || active === trap || !trap.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!(event as KeyboardEvent).shiftKey && (active === last || !trap.contains(active))) {
      event.preventDefault();
      first.focus();
    }
    }));

  // Media state → element (only what changed since the last render)
  const appliedMedia = new WeakMap<Element, Record<string, string>>();
  const syncMedia = (): void => {
    for (const el of Array.from(root.querySelectorAll<HTMLMediaElement>("[data-obix-media]"))) {
      const declared: Record<string, string> = {};
      for (const pair of (el.getAttribute("data-obix-media") ?? "").split(";")) {
        const at = pair.indexOf("=");
        if (at > 0) declared[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      const before = appliedMedia.get(el) ?? {};
      appliedMedia.set(el, declared);
      const changed = (key: string): boolean => key in declared && declared[key] !== before[key];
      try {
        if (changed("volume") && !Number.isNaN(Number(declared.volume))) el.volume = Math.min(1, Math.max(0, Number(declared.volume)));
        if (changed("muted")) el.muted = declared.muted === "true";
        if (changed("time") && !Number.isNaN(Number(declared.time))) el.currentTime = Number(declared.time);
        if (changed("captions")) {
          // "off" hides every text track; a language shows the caption/subtitle track of that language
          for (const track of Array.from(el.textTracks ?? [])) track.mode = declared.captions !== "off" && track.language === declared.captions && (track.kind === "captions" || track.kind === "subtitles") ? "showing" : "hidden";
        }
        if (changed("playing")) {
          if (declared.playing === "true") void Promise.resolve(el.play()).catch(() => undefined); // autoplay policies may refuse; the state stays what the app declared
          else el.pause();
        }
      } catch {
        /* a host without media support (jsdom) or an element that is not media */
      }
    }
  };

  // Textarea auto-expand (data-obix-autoexpand): grow with the content as the user types and after each render
  const expand = (el: Element): void => {
    const area = el as HTMLTextAreaElement;
    area.style.height = "auto";
    if (area.scrollHeight) area.style.height = `${area.scrollHeight}px`;
  };
  declare("textarea[data-obix-autoexpand]", () => delegator.on("input", "textarea[data-obix-autoexpand]", (_event, match) => expand(match)));

  // State-driven focus: when a render moved the "focus target" of a widget (data-obix-focus) and focus is currently inside that widget
  // (data-obix-focus-scope), follow it. This is how a component keeps roving focus (calendar day, menu item, …) in its state.
  // A render can remove the very element that had focus (paging a calendar from a 6-row month to a 5-row one): the browser then drops focus
  // to <body>. The scope that held it just before the render (by position among the scopes) takes it back.
  let scopeHadFocus = -1;
  const scopes = (): Element[] => Array.from(root.querySelectorAll("[data-obix-focus-scope]"));
  const rememberScope = (): void => {
    const active = doc.activeElement;
    scopeHadFocus = active && active !== doc.body ? scopes().findIndex((scope) => scope.contains(active)) : -1;
  };
  const followFocus = (): void => {
    const active = doc.activeElement;
    const all = scopes();
    const lost = !active || active === doc.body;
    const had = scopeHadFocus;
    scopeHadFocus = -1;
    for (let i = 0; i < all.length; i++) {
      const scope = all[i] as Element;
      if (!(active && scope.contains(active)) && !(lost && had === i)) continue;
      const target = scope.querySelector<HTMLElement>("[data-obix-focus]");
      if (target && target !== active) target.focus({ preventScroll: true });
      break;
    }
  };

  // Timers owned by the markup (data-obix-after="action:ms", paused by data-obix-after-paused)
  interface Timer {
    spec: string;
    action: string;
    remaining: number;
    startedAt: number;
    handle: ReturnType<typeof setTimeout> | null;
    fired: boolean;
  }
  const timers = new Map<Element, Timer>();
  let disposed = false;
  const stop = (t: Timer): void => {
    if (t.handle !== null) globalThis.clearTimeout(t.handle);
    t.handle = null;
  };
  const syncTimers = (): void => {
    const present = new Set(Array.from(root.querySelectorAll("[data-obix-after]")));
    for (const [el, t] of timers) {
      if (present.has(el)) continue;
      stop(t);
      timers.delete(el);
    }
    for (const el of present) {
      const spec = el.getAttribute("data-obix-after") ?? "";
      const parsed = /^\s*([\w.-]+)\s*:\s*(\d+)\s*$/.exec(spec);
      if (!parsed) continue;
      let t = timers.get(el);
      if (t && t.spec !== spec) {
        stop(t); // a different declaration is a different timer
        t = undefined;
      }
      if (!t) {
        t = { spec, action: parsed[1] as string, remaining: Number(parsed[2]), startedAt: 0, handle: null, fired: false };
        timers.set(el, t);
      }
      if (t.fired) continue;
      const timer = t;
      if (el.hasAttribute("data-obix-after-paused")) {
        if (timer.handle !== null) {
          stop(timer);
          timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
        }
      } else if (timer.handle === null) {
        timer.startedAt = Date.now();
        timer.handle = globalThis.setTimeout(() => {
          timer.handle = null;
          timer.fired = true;
          if (!disposed) dispatch(timer.action);
        }, timer.remaining);
      }
    }
  };

  // Trap entry / exit around renders
  let trap: Element | null = null;
  let returnTo: HTMLElement | null = null;

  const restore = (): void => {
    const target = returnTo;
    returnTo = null;
    if (target && target.isConnected && typeof target.focus === "function") target.focus({ preventScroll: true });
  };

  return {
    beforeRender: rememberScope,
    afterRender() {
      activate();
      syncMedia();
      syncTimers();
      followFocus();
      for (const area of Array.from(root.querySelectorAll("textarea[data-obix-autoexpand]"))) expand(area);
      const present = root.querySelector("[data-obix-trap]");
      if (present && present !== trap) {
        const active = doc.activeElement as HTMLElement | null;
        if (!returnTo || !root.contains(returnTo)) returnTo = active && active !== doc.body && !present.contains(active) ? active : returnTo;
        trap = present;
        const start = present.querySelector<HTMLElement>("[data-obix-autofocus]") ?? focusableWithin(present)[0] ?? (present as HTMLElement);
        if (start === present && !present.hasAttribute("tabindex")) present.setAttribute("tabindex", "-1");
        start.focus({ preventScroll: true });
      } else if (!present && trap) {
        trap = null;
        restore();
      }
      if (pendingFocus !== null) {
        const spec = pendingFocus;
        pendingFocus = null;
        focusNow(spec);
      }
    },
    focusTarget,
    dispose() {
      disposed = true;
      for (const t of timers.values()) stop(t);
      timers.clear();
      pendingFocus = null;
      if (trap) restore();
      trap = null;
      returnTo = null;
    }
  };
}
