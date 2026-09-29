import test from "node:test";
import assert from "node:assert/strict";
import { createDelegator, morph, MOUNT_ATTRIBUTE } from "../dist/index.js";
import { page, click, spyListeners } from "./helpers.mjs";

test("one DOM listener per event type, however many handlers and however many renders", () => {
  const { app, window } = page();
  const log = spyListeners(app);
  const d = createDelegator(app);
  const hits = [];
  d.on("click", "button", (e, el) => hits.push(el.id));
  d.on("click", "a", (e, el) => hits.push(el.id));
  d.on("input", "input", () => hits.push("input"));
  for (let i = 0; i < 50; i++) morph(app, `<button id="b">${i}</button><a id="a">x</a>`);
  click(window, app.querySelector("#b"));
  click(window, app.querySelector("#a"));
  assert.deepEqual(hits, ["b", "a"]);
  assert.equal(log.added.length, 2, "click + input, nothing per render");
  assert.equal(d.listenerCount, 2);
});

test("handlers keep working after the element they were 'attached' to is replaced", () => {
  const { app, window } = page();
  const d = createDelegator(app);
  let n = 0;
  d.on("click", ".go", () => n++);
  morph(app, '<p><button class="go">1</button></p>');
  click(window, app.querySelector(".go"));
  morph(app, '<div><span><button class="go">2</button></span></div>'); // structure changed: a brand new button
  click(window, app.querySelector(".go"));
  assert.equal(n, 2);
});

test("a click on a descendant of the matching element reaches the handler with the matched element", () => {
  const { app, window } = page('<div id="app"><button class="go"><span id="inner">text</span></button></div>');
  const d = createDelegator(app);
  let matched;
  d.on("click", ".go", (e, el) => { matched = el; });
  click(window, app.querySelector("#inner"));
  assert.equal(matched, app.querySelector(".go"));
});

test("elements outside the root, and the root itself, never match", () => {
  const { app, window, document } = page('<button class="go" id="outside">o</button><div id="app"></div>');
  const d = createDelegator(app);
  let n = 0;
  d.on("click", ".go, #app", () => n++);
  click(window, document.getElementById("outside"));
  click(window, app);
  assert.equal(n, 0);
});

test("elements inside a nested mount belong to it: the outer delegator ignores them", () => {
  const { app, window } = page('<div id="app"><button class="go" id="mine">a</button><div id="child"><button class="go" id="theirs">b</button></div></div>');
  app.querySelector("#child").setAttribute(MOUNT_ATTRIBUTE, "");
  const d = createDelegator(app);
  const hits = [];
  d.on("click", ".go", (e, el) => hits.push(el.id));
  click(window, app.querySelector("#theirs"));
  click(window, app.querySelector("#mine"));
  assert.deepEqual(hits, ["mine"]);
});

test("the remover returned by on() stops that handler only", () => {
  const { app, window } = page('<div id="app"><button class="go">x</button></div>');
  const d = createDelegator(app);
  const a = [], b = [];
  const offA = d.on("click", ".go", () => a.push(1));
  d.on("click", ".go", () => b.push(1));
  click(window, app.querySelector(".go"));
  offA(); offA();
  click(window, app.querySelector(".go"));
  assert.deepEqual([a.length, b.length], [1, 2]);
});

test("a handler removed while an event is being delivered is not called for it", () => {
  const { app, window } = page('<div id="app"><button class="go">x</button></div>');
  const d = createDelegator(app);
  const seen = [];
  let offSecond = () => {};
  d.on("click", ".go", () => { seen.push("first"); offSecond(); });
  offSecond = d.on("click", ".go", () => seen.push("second"));
  click(window, app.querySelector(".go"));
  assert.deepEqual(seen, ["first"]);
});

test("focus and blur are delegated through focusin / focusout", () => {
  const { app, document } = page('<div id="app"><input id="a"><input id="b"></div>');
  const d = createDelegator(app);
  const seen = [];
  d.on("focus", "input", (e, el) => seen.push(`focus ${el.id}`));
  d.on("blur", "input", (e, el) => seen.push(`blur ${el.id}`));
  app.querySelector("#a").focus();
  app.querySelector("#b").focus();
  assert.deepEqual(seen, ["focus a", "blur a", "focus b"]);
  assert.equal(document.activeElement.id, "b");
});

test("dispose removes every listener, is idempotent, and refuses new handlers", () => {
  const { app, window } = page('<div id="app"><button class="go">x</button></div>');
  const log = spyListeners(app);
  const d = createDelegator(app);
  let n = 0;
  d.on("click", ".go", () => n++);
  d.on("keydown", ".go", () => n++);
  d.dispose(); d.dispose();
  assert.deepEqual(log.removed.sort(), ["click", "keydown"]);
  click(window, app.querySelector(".go"));
  assert.equal(n, 0);
  assert.equal(d.listenerCount, 0);
  assert.throws(() => d.on("click", ".go", () => {}), /disposed/);
});
