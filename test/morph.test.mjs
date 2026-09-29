import test from "node:test";
import assert from "node:assert/strict";
import { morph, MOUNT_ATTRIBUTE } from "../dist/index.js";
import { page, mulberry32 } from "./helpers.mjs";

const ids = (parent) => Array.from(parent.children);

test("morph fills an empty container", () => {
  const { app } = page();
  const stats = morph(app, "<h1>Title</h1><p>Body</p>");
  assert.equal(app.innerHTML, "<h1>Title</h1><p>Body</p>");
  assert.deepEqual(stats, { created: 2, removed: 0, moved: 0, reused: 0, attributesChanged: 0, textChanged: 0 });
});

test("unchanged markup touches nothing; changed text patches the same nodes", () => {
  const { app } = page();
  morph(app, "<p>a</p><p>b</p>");
  const [p1, p2] = ids(app);
  const same = morph(app, "<p>a</p><p>b</p>");
  assert.deepEqual([same.created, same.removed, same.moved, same.attributesChanged, same.textChanged], [0, 0, 0, 0, 0]);
  assert.ok(same.reused >= 2);
  const changed = morph(app, "<p>a2</p><p>b</p>");
  assert.equal(changed.textChanged, 1);
  assert.equal(changed.created + changed.removed + changed.moved, 0);
  assert.deepEqual(ids(app), [p1, p2], "the same element objects are still in the container");
  assert.equal(p1.textContent, "a2");
});

test("attributes are added, changed and removed on the reused element", () => {
  const { app } = page();
  morph(app, '<button class="a" disabled>x</button>');
  const button = app.firstElementChild;
  const stats = morph(app, '<button class="b" aria-pressed="true">x</button>');
  assert.equal(app.firstElementChild, button);
  assert.equal(button.className, "b");
  assert.equal(button.hasAttribute("disabled"), false);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(stats.attributesChanged, 3);
});

test("keyed children keep their identity through a reorder, insert and removal", () => {
  const { app } = page();
  const list = (order) => `<ul>${order.map((k) => `<li data-obix-key="${k}">${k}</li>`).join("")}</ul>`;
  morph(app, list(["a", "b", "c"]));
  const byKey = Object.fromEntries(ids(app.firstElementChild).map((li) => [li.dataset.obixKey, li]));
  const reorder = morph(app, list(["c", "a", "b"]));
  assert.deepEqual(ids(app.firstElementChild).map((li) => li.dataset.obixKey), ["c", "a", "b"]);
  for (const li of ids(app.firstElementChild)) assert.equal(li, byKey[li.dataset.obixKey]);
  assert.equal(reorder.moved, 1, "moving the last item to the front is one re-insertion");
  const edit = morph(app, list(["c", "x", "b"]));
  const now = ids(app.firstElementChild);
  assert.deepEqual(now.map((li) => li.dataset.obixKey), ["c", "x", "b"]);
  assert.equal(now[0], byKey.c);
  assert.equal(now[2], byKey.b);
  assert.equal(edit.created, 1);
  assert.equal(edit.removed, 1);
  assert.equal(edit.moved, 0, "keeping the relative order of survivors needs no moves");
});

test("`id` is a key too", () => {
  const { app } = page();
  morph(app, '<input id="name"><input id="email">');
  const [name, email] = ids(app);
  morph(app, '<input id="email"><input id="name">');
  assert.deepEqual(ids(app).map((e) => e.id), ["email", "name"]);
  assert.equal(app.querySelector("#name"), name);
  assert.equal(app.querySelector("#email"), email);
});

test("a different tag at the same position replaces the element", () => {
  const { app } = page();
  morph(app, "<p>x</p>");
  const p = app.firstElementChild;
  const stats = morph(app, "<div>x</div>");
  assert.notEqual(app.firstElementChild, p);
  assert.equal(app.innerHTML, "<div>x</div>");
  assert.equal(stats.created, 1);
  assert.equal(stats.removed, 1);
});

test("an element inserted in front does not force the following siblings to be recreated", () => {
  const { app } = page();
  morph(app, "<div>one</div>");
  const div = app.firstElementChild;
  morph(app, "<p>new</p><div>one</div>");
  assert.equal(app.lastElementChild, div);
});

test("a subtree owned by a nested mount is never entered, and its marker attribute is never removed", () => {
  const { app } = page();
  morph(app, '<section><div data-obix-key="child"></div></section>');
  const child = app.querySelector("[data-obix-key=child]");
  child.setAttribute(MOUNT_ATTRIBUTE, "");
  child.innerHTML = "<b>owned by the child</b>";
  morph(app, '<section><div data-obix-key="child" class="x">parent wants this text</div></section>');
  assert.equal(app.querySelector("[data-obix-key=child]"), child);
  assert.equal(child.innerHTML, "<b>owned by the child</b>", "the child's content is untouched");
  assert.equal(child.hasAttribute(MOUNT_ATTRIBUTE), true);
  assert.equal(child.className, "x", "attributes of the host element are still the parent's");
});

test("onRemove is called for each removed element", () => {
  const { app } = page();
  morph(app, '<p data-obix-key="a">a</p><p data-obix-key="b">b</p><p data-obix-key="c">c</p>');
  const removed = [];
  morph(app, '<p data-obix-key="b">b</p>', { onRemove: (el) => removed.push(el.dataset.obixKey) });
  assert.deepEqual(removed.sort(), ["a", "c"]);
});

test("a text input keeps what the user typed unless the rendered value attribute changed", () => {
  const { app } = page();
  morph(app, '<input id="q" value="start">');
  const input = app.firstElementChild;
  input.value = "typed by the user";
  morph(app, '<input id="q" value="start" class="x">');
  assert.equal(input.value, "typed by the user");
  morph(app, '<input id="q" value="server says">');
  assert.equal(input.value, "server says");
});

test("a checkbox keeps the user's choice unless the rendered checked attribute changed", () => {
  const { app } = page();
  morph(app, '<input id="c" type="checkbox">');
  const box = app.firstElementChild;
  box.checked = true;
  morph(app, '<input id="c" type="checkbox" class="x">');
  assert.equal(box.checked, true);
  morph(app, '<input id="c" type="checkbox" checked>');
  assert.equal(box.checked, true);
  morph(app, '<input id="c" type="checkbox">');
  assert.equal(box.checked, false);
});

test("a textarea keeps what the user typed unless the rendered text changed", () => {
  const { app } = page();
  morph(app, '<textarea id="t">first</textarea>');
  const area = app.firstElementChild;
  area.value = "typed";
  morph(app, '<textarea id="t">first</textarea>');
  assert.equal(area.value, "typed");
  morph(app, '<textarea id="t">second</textarea>');
  assert.equal(area.value, "second");
});

test("the focused element stays focused, with its caret, while the text around it changes", () => {
  const { app, document } = page();
  morph(app, '<label>Name <span>0 chars</span></label><input id="name" value="">');
  const input = app.querySelector("#name");
  input.focus();
  input.value = "hello world";
  input.setSelectionRange(2, 7);
  morph(app, '<label>Name <span>11 chars</span></label><input id="name" value="">');
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "hello world");
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7]);
});

test("scripts in the markup are inert (parsed in a template)", () => {
  const { app, window } = page();
  window.__ran = false;
  morph(app, "<script>window.__ran = true</script><p>x</p>");
  assert.equal(window.__ran, false);
});

test("markup already in the container (server-rendered) is adopted, not rebuilt", () => {
  const { app } = page('<div id="app"><h1>Hi</h1><button class="btn">Go</button></div>');
  const [h1, button] = ids(app);
  const stats = morph(app, '<h1>Hi</h1><button class="btn">Go</button>');
  assert.deepEqual(ids(app), [h1, button]);
  assert.equal(stats.created + stats.removed + stats.attributesChanged + stats.textChanged, 0);
});

// ── correctness invariant on random documents ────────────────────────────────────────────────────
function randomHtml(rnd, depth = 0) {
  const tags = ["div", "span", "p", "ul", "li", "b", "section"];
  const count = 1 + Math.floor(rnd() * (depth === 0 ? 6 : 3));
  const keys = new Set();
  let out = "";
  for (let i = 0; i < count; i++) {
    const r = rnd();
    if (r < 0.2) { out += ["a", "b", " ", "x y"][Math.floor(rnd() * 4)]; continue; }
    if (r < 0.25) { out += "<!--c" + Math.floor(rnd() * 3) + "-->"; continue; }
    const tag = tags[Math.floor(rnd() * tags.length)];
    let attrs = "";
    if (rnd() < 0.5) { const k = "k" + Math.floor(rnd() * 6); if (!keys.has(k)) { keys.add(k); attrs += ` data-obix-key="${k}"`; } }
    if (rnd() < 0.4) attrs += ` class="c${Math.floor(rnd() * 3)}"`;
    if (rnd() < 0.2) attrs += ` title="t${Math.floor(rnd() * 3)}"`;
    if (rnd() < 0.1) attrs += " hidden";
    out += `<${tag}${attrs}>${depth < 3 && rnd() < 0.7 ? randomHtml(rnd, depth + 1) : "leaf"}</${tag}>`;
  }
  return out;
}

const sameChildren = (a, b) => a.childNodes.length === b.childNodes.length && Array.from(a.childNodes).every((n, i) => n.isEqualNode(b.childNodes[i]));

test("for 400 random old/new document pairs the morphed container serialises exactly like the new markup", () => {
  const rnd = mulberry32(20260924);
  const { app, document } = page();
  const reference = document.createElement("div");
  let stepsWithReuse = 0;
  let chunks = [];
  for (let i = 0; i < 400; i++) {
    // each document is the previous one edited: chunks kept, regenerated, dropped, duplicated with a new neighbour, and sometimes shuffled
    const edited = [];
    for (const chunk of chunks) {
      const r = rnd();
      if (r < 0.55) edited.push(chunk);
      else if (r < 0.7) edited.push(randomHtml(rnd, 1));
      else if (r >= 0.8) edited.push(chunk, randomHtml(rnd, 1));
    }
    if (rnd() < 0.3 || edited.length === 0) edited.push(randomHtml(rnd, 1));
    if (rnd() < 0.3) edited.sort(() => rnd() - 0.5);
    chunks = edited.slice(0, 12);
    const next = chunks.join("");
    if (i % 7 === 0) app.innerHTML = randomHtml(rnd); // arbitrary starting point, as if server-rendered
    const stats = morph(app, next);
    reference.innerHTML = next;
    // isEqualNode ignores attribute ORDER (serialisation does not): a reused element may have gained an attribute after its old ones.
    assert.ok(sameChildren(app, reference), `pair ${i}:
 got  ${app.innerHTML}
 want ${reference.innerHTML}`);
    if (stats.reused > 0) stepsWithReuse++;
    // a second morph to the same markup is a no-op on the DOM
    const again = morph(app, next);
    assert.equal(again.created + again.removed + again.moved + again.attributesChanged + again.textChanged, 0, `pair ${i} is not idempotent`);
  }
  assert.ok(stepsWithReuse > 200, `only ${stepsWithReuse} of 400 steps reused nodes: the invariant test would be vacuous`);
});
