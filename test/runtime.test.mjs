import test from "node:test";
import assert from "node:assert/strict";
import { installGlobalDocument } from "../../../scripts/mini-dom.mjs";
import { bindText, bindAttr, bindBool, bindAria, bindEvent, createBindingGroup } from "../dist/index.js";

const { document } = installGlobalDocument();

test("bindText writes textContent and re-reads on update()", () => {
  const el = document.createElement("span");
  let v = "a";
  const update = bindText(el, () => v);
  assert.equal(el.textContent, "a");
  v = "b";
  update();
  assert.equal(el.textContent, "b");
});

test("bindAttr removes on null/false, sets otherwise", () => {
  const el = document.createElement("div");
  let v = "x";
  const u = bindAttr(el, "title", () => v);
  assert.equal(el.getAttribute("title"), "x");
  v = null;
  u();
  assert.equal(el.getAttribute("title"), null);
});

test("bindBool toggles presence", () => {
  const el = document.createElement("button");
  let on = true;
  const u = bindBool(el, "disabled", () => on);
  assert.equal(el.hasAttribute("disabled"), true);
  on = false;
  u();
  assert.equal(el.hasAttribute("disabled"), false);
});

test("bindAria maps booleans to strings", () => {
  const el = document.createElement("div");
  bindAria(el, "aria-pressed", () => true);
  assert.equal(el.getAttribute("aria-pressed"), "true");
});

test("bindEvent returns a working cleanup", () => {
  const el = document.createElement("button");
  let hits = 0;
  const off = bindEvent(el, "click", () => hits++);
  el.dispatch("click");
  off();
  el.dispatch("click");
  assert.equal(hits, 1);
});

test("createBindingGroup flushes + disposes", () => {
  const g = createBindingGroup();
  let n = 0;
  g.add(() => n++);
  g.update();
  g.update();
  assert.equal(n, 2);
  g.dispose();
  g.update();
  assert.equal(n, 2);
});
