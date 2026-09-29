import test from "node:test";
import assert from "node:assert/strict";
import { mount } from "../dist/index.js";
import { page, click, key, type } from "./helpers.mjs";

const inert = (html, state = {}) => ({ state, actions: {}, render: () => html });

// ── data-obix-on ─────────────────────────────────────────────────────────────────────────────────
test("data-obix-on: several bindings on one element, key filters, and every argument form", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, {
    state: {},
    actions: new Proxy({}, { get: (_, name) => (state, ...args) => { seen.push([name, ...args]); return { ...state }; } }),
    render: () => '<input id="f" data-obix-attr="hello" data-obix-on="input=edit(@value); keydown:Enter=commit; keydown:ArrowDown=down!; focus=touch; blur=untouch">' +
      '<button id="b" data-id="row-7" data-obix-on="click=pick(@attr:data-id)">x</button>' +
      '<button id="j" data-obix-on=\'click=obj({"a":1})\'>j</button><button id="n" data-obix-on="click=plain">n</button>',
  });
  const f = app.querySelector("#f");
  f.focus();
  type(window, f, "abc");
  key(window, f, "a");
  key(window, f, "Enter");
  const down = key(window, f, "ArrowDown");
  f.blur();
  click(window, app.querySelector("#b"));
  click(window, app.querySelector("#j"));
  click(window, app.querySelector("#n"));
  assert.deepEqual(seen, [["touch"], ["edit", "abc"], ["commit"], ["down"], ["untouch"], ["pick", "row-7"], ["obj", { a: 1 }], ["plain"]]);
  assert.equal(down.defaultPrevented, true, "the trailing ! prevents the default");
});

test("data-obix-on ignores aria-disabled elements and malformed entries", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, { state: {}, actions: { go: (s) => { seen.push("go"); return { ...s }; } }, render: () => '<button id="d" aria-disabled="true" data-obix-on="click=go">d</button><button id="m" data-obix-on="click go; ???; click=go">m</button>' });
  click(window, app.querySelector("#d"));
  click(window, app.querySelector("#m"));
  assert.deepEqual(seen, ["go"], "only the well-formed entry fires");
});

// ── roving focus ─────────────────────────────────────────────────────────────────────────────────
const tabs = (extra = "") => `<div role="tablist" data-obix-roving="horizontal" ${extra}>
  <button role="tab" id="t1" tabindex="0" data-obix-on="click=pick(@attr:id)">1</button>
  <button role="tab" id="t2" tabindex="-1" data-obix-on="click=pick(@attr:id)" aria-disabled="true">2</button>
  <button role="tab" id="t3" tabindex="-1" data-obix-on="click=pick(@attr:id)">3</button></div>`;

test("roving: arrows and Home/End move focus, skip disabled items and wrap; other keys are left alone", () => {
  const { app, window, document } = page();
  mount(app, inert(tabs()));
  const focus = (id) => app.querySelector("#" + id).focus();
  focus("t1");
  const order = [];
  for (const k of ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home", "ArrowLeft"]) { key(window, document.activeElement, k); order.push(document.activeElement.id); }
  assert.deepEqual(order, ["t3", "t1", "t3", "t3", "t1", "t3"]);
  const tab = key(window, document.activeElement, "a");
  assert.equal(tab.defaultPrevented, false);
  const vertical = key(window, document.activeElement, "ArrowDown");
  assert.equal(vertical.defaultPrevented, false, "a horizontal container ignores ArrowDown");
});

test("roving with data-obix-follow-focus also activates the focused item (selection follows focus)", () => {
  const { app, window, document } = page();
  const picked = [];
  mount(app, { state: {}, actions: { pick: (s, id) => { picked.push(id); return { ...s, id }; } }, render: (s) => tabs("data-obix-follow-focus") });
  app.querySelector("#t1").focus();
  key(window, document.activeElement, "ArrowRight");
  key(window, document.activeElement, "ArrowRight");
  assert.deepEqual(picked, ["t3", "t1"]);
});

test("roving orientation both answers to all four arrows; a container inside a nested mount is not handled by the outer mount", () => {
  const { app, window, document } = page();
  mount(app, inert('<div role="radiogroup" data-obix-roving="both"><input type="radio" role="radio" id="a"><input type="radio" role="radio" id="b"></div>'));
  app.querySelector("#a").focus();
  key(window, document.activeElement, "ArrowDown");
  assert.equal(document.activeElement.id, "b");
  key(window, document.activeElement, "ArrowLeft");
  assert.equal(document.activeElement.id, "a");
});

// ── dismiss ──────────────────────────────────────────────────────────────────────────────────────
test("Escape inside a data-obix-dismiss element dispatches its action once, and only the nearest dismissable reacts", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, {
    state: {},
    actions: { closeOuter: (s) => { seen.push("outer"); return { ...s }; }, closeInner: (s) => { seen.push("inner"); return { ...s }; } },
    render: () => '<div data-obix-dismiss="closeOuter"><div data-obix-dismiss="closeInner"><button id="b">x</button></div><button id="c">y</button></div>',
  });
  const esc = key(window, app.querySelector("#b"), "Escape");
  key(window, app.querySelector("#c"), "Escape");
  key(window, app.querySelector("#c"), "Enter");
  assert.deepEqual(seen, ["inner", "outer"]);
  assert.equal(esc.defaultPrevented, true);
});

// ── trap ─────────────────────────────────────────────────────────────────────────────────────────
function dialogApp(autofocus = true) {
  const { app, window, document } = page('<button id="opener">open</button><div id="app"></div>');
  const opener = document.getElementById("opener");
  const view = mount(document.getElementById("app"), {
    state: { open: false },
    actions: { open: (s) => ({ ...s, open: true }), close: (s) => ({ ...s, open: false }) },
    render: (s) => (s.open
      ? '<div role="dialog" aria-modal="true" aria-label="Confirm" data-obix-trap data-obix-dismiss="close"><button id="first">Cancel</button><button id="last" ' + (autofocus ? 'data-obix-autofocus ' : '') + 'data-obix-on="click=close">OK</button></div>'
      : ""),
  });
  return { window, document, opener, view };
}

test("trap: on open focus moves to [data-obix-autofocus], Tab / Shift+Tab cycle inside, Escape closes, focus returns to the opener", () => {
  const { window, document, opener, view } = dialogApp();
  opener.focus();
  view.dispatch("open");
  assert.equal(document.activeElement.id, "last", "data-obix-autofocus wins");
  const t1 = key(window, document.activeElement, "Tab");
  assert.equal(document.activeElement.id, "first", "Tab from the last item wraps to the first");
  assert.equal(t1.defaultPrevented, true);
  const shift = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(shift);
  assert.equal(document.activeElement.id, "last", "Shift+Tab from the first wraps to the last");
  key(window, document.activeElement, "Escape");
  assert.equal(view.getState().open, false);
  assert.equal(document.activeElement, opener, "focus is returned to what had it before the dialog opened");
});

test("trap: without data-obix-autofocus the first focusable gets focus; unmount while open restores focus too", () => {
  const { document, opener, view } = dialogApp(false);
  opener.focus();
  view.dispatch("open");
  assert.equal(document.activeElement.id, "first");
  view.unmount();
  assert.equal(document.activeElement, opener);
});

test("behaviors:false installs none of it", () => {
  const { app, window, document } = page();
  const seen = [];
  mount(app, { state: {}, actions: { close: (s) => { seen.push("close"); return { ...s }; } }, render: () => '<div data-obix-dismiss="close"><button id="b">x</button></div>' }, { behaviors: false });
  key(window, app.querySelector("#b"), "Escape");
  assert.deepEqual(seen, []);
});
