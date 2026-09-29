import { JSDOM } from "jsdom";

/** A fresh document per test: `{ window, document, app }` where `app` is an empty, attached container. */
export function page(body = '<div id="app"></div>') {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });
  const { window } = dom;
  return { dom, window, document: window.document, app: window.document.getElementById("app") };
}

/** Count add/removeEventListener calls on an element (or any EventTarget). */
export function spyListeners(target) {
  const log = { added: [], removed: [] };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, ...rest) => { log.added.push(type); return add(type, ...rest); };
  target.removeEventListener = (type, ...rest) => { log.removed.push(type); return remove(type, ...rest); };
  return log;
}

export function click(window, el, init = {}) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
}

export function key(window, el, k) {
  const event = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

export function type(window, input, text) {
  input.value = text;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** Seeded PRNG for reproducible random documents. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
