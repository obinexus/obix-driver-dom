/**
 * Event delegation: ONE listener per event type on a root element, however many elements are rendered and however often they are
 * replaced. Handlers are matched by selector against the event target's ancestors, so nothing has to be re-attached after a
 * render and nothing leaks when nodes are removed. Elements inside a nested mount (`data-obix-mount`) belong to that mount and are
 * never matched by an outer delegator.
 */
import { MOUNT_ATTRIBUTE } from "./morph.js";

export type DelegatedHandler = (event: Event, match: Element) => void;

export interface Delegator {
  /**
   * Call `handler(event, matchedElement)` when an event of `type` originates inside an element matching `selector`. Returns its remover.
   * By default only the NEAREST matching ancestor is used. With `{ bubble: true }` every matching ancestor up to the root is used, nearest
   * first, as native bubbling would (stopped by `event.stopPropagation()`): a grid that handles arrow keys and the buttons inside it that
   * handle clicks both declare `data-obix-on`.
   */
  on(type: string, selector: string, handler: DelegatedHandler, options?: { bubble?: boolean }): () => void;
  /** Remove every DOM listener and forget every handler. Idempotent. */
  dispose(): void;
  /** Number of DOM listeners currently attached to the root (one per event type in use). */
  readonly listenerCount: number;
}

/**
 * Events that do not bubble but do pass through ancestors in the CAPTURE phase (`load`/`error` of images, media events, `toggle`,
 * `scroll`, `invalid`): one capturing listener on the root sees them for every descendant.
 */
const CAPTURED = new Set(["load", "error", "play", "pause", "ended", "volumechange", "timeupdate", "loadedmetadata", "loadeddata", "canplay", "seeked", "toggle", "scroll", "invalid", "mouseenter", "mouseleave"]);

/** Non-bubbling events that have a bubbling twin are delegated through it. */
const BUBBLING_TWIN: Record<string, string> = { focus: "focusin", blur: "focusout" };

interface Entry {
  selector: string;
  handler: DelegatedHandler;
  bubble: boolean;
}

export function createDelegator(root: Element): Delegator {
  const byType = new Map<string, { listener: EventListener; entries: Entry[] }>();
  let disposed = false;

  const ownedByRoot = (match: Element): boolean => {
    for (let ancestor = match.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      if (ancestor.hasAttribute(MOUNT_ATTRIBUTE)) return false;
    }
    return true;
  };

  const find = (target: EventTarget | null, selector: string): Element | null => {
    if (!target || typeof (target as Element).closest !== "function") return null;
    const match = (target as Element).closest(selector);
    return match && match !== root && root.contains(match) && ownedByRoot(match) ? match : null;
  };

  const findAll = (target: EventTarget | null, selector: string): Element[] => {
    const out: Element[] = [];
    if (!target || typeof (target as Element).closest !== "function") return out;
    for (let el: Element | null = target as Element; el && el !== root; el = el.parentElement) {
      if (el.matches(selector) && root.contains(el) && ownedByRoot(el)) out.push(el);
    }
    return out;
  };

  return {
    on(type, selector, handler, options) {
      if (disposed) throw new Error("delegator is disposed");
      const domType = BUBBLING_TWIN[type] ?? type;
      let bucket = byType.get(domType);
      if (!bucket) {
        const entries: Entry[] = [];
        const listener: EventListener = (event) => {
          for (const entry of [...entries]) {
            if (!entries.includes(entry)) continue; // removed while this event was being delivered
            if (entry.bubble) {
              for (const match of findAll(event.target, entry.selector)) {
                entry.handler(event, match);
                if (event.cancelBubble) break;
              }
            } else {
              const match = find(event.target, entry.selector);
              if (match) entry.handler(event, match);
            }
          }
        };
        bucket = { listener, entries };
        byType.set(domType, bucket);
        root.addEventListener(domType, listener, CAPTURED.has(domType));
      }
      const entry: Entry = { selector, handler, bubble: !!options?.bubble };
      bucket.entries.push(entry);
      return () => {
        const at = bucket.entries.indexOf(entry);
        if (at >= 0) bucket.entries.splice(at, 1);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [domType, bucket] of byType) {
        root.removeEventListener(domType, bucket.listener, CAPTURED.has(domType));
        bucket.entries.length = 0;
      }
      byType.clear();
    },
    get listenerCount() {
      return byType.size;
    }
  };
}
