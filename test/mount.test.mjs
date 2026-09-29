import test from "node:test";
import assert from "node:assert/strict";
import { mount, getMounted, MOUNT_ATTRIBUTE } from "../dist/index.js";
import { ObixRuntime } from "obix-core-runtime";
import { page, click, key, type, spyListeners } from "./helpers.mjs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The documented component shape. Its actions return the FULL next state. */
function counter(initial = { count: 0, label: "Count" }) {
  return {
    state: initial,
    actions: {
      inc: (state) => ({ ...state, count: state.count + 1 }),
      set: (state, n) => ({ ...state, count: n }),
      noop: (state) => state,
    },
    render: (state) => `<button id="inc" data-obix-action="inc">${esc(state.label)}: ${state.count}</button><output>${state.count}</output>`,
  };
}

test("mount renders, marks the container, and every click goes through dispatch with no re-wiring", () => {
  const { app, window } = page();
  const c = mount(app, counter());
  assert.equal(app.querySelector("output").textContent, "0");
  assert.equal(app.hasAttribute(MOUNT_ATTRIBUTE), true);
  for (let i = 0; i < 10; i++) click(window, app.querySelector("#inc"));
  assert.equal(app.querySelector("output").textContent, "10");
  assert.equal(c.getState().count, 10);
  assert.equal(getMounted(app), c);
});

test("the button element survives every render (morph, not innerHTML): same object after 10 clicks", () => {
  const { app, window } = page();
  mount(app, counter());
  const button = app.querySelector("#inc");
  for (let i = 0; i < 10; i++) click(window, button);
  assert.equal(app.querySelector("#inc"), button);
  assert.equal(button.textContent, "Count: 10");
});

test("the listener count is constant across renders and clicks, and returns to zero on unmount", () => {
  const { app, window } = page();
  const log = spyListeners(app);
  const c = mount(app, counter());
  const afterMount = log.added.length;
  for (let i = 0; i < 25; i++) click(window, app.querySelector("#inc"));
  assert.equal(log.added.length, afterMount, "no listener is added by renders or interactions");
  assert.equal(new Set(log.added).size, log.added.length, "one listener per event type");
  c.unmount();
  assert.deepEqual([...log.removed].sort(), [...log.added].sort(), "every added listener is removed");
});

test("Gen-1 factory actions that return a PARTIAL state no longer corrupt the state (baseline P8)", () => {
  const { app, window } = page();
  const gen1 = {
    state: { label: "Save", loading: false, disabled: false },
    actions: { setLoading: (state, loading) => ({ loading }) }, // a delta, as the Gen-1 factories return
    render: (s) => `<button id="b" data-obix-action="setLoading" data-obix-arg="true" class="obix-button${s.loading ? " loading" : ""}">${esc(s.label)}</button>`,
  };
  const c = mount(app, gen1);
  click(window, app.querySelector("#b"));
  assert.deepEqual(c.getState(), { label: "Save", loading: true, disabled: false });
  assert.equal(app.querySelector("#b").className, "obix-button loading");
  assert.doesNotMatch(app.innerHTML, /undefined/);
});

test('actionStyle "component" replaces the state; "canonical" gets (state, payload, props)', () => {
  const { app } = page();
  const replace = mount(app, { state: { a: 1, b: 2 }, actions: { only: () => ({ a: 9 }) }, render: (s) => JSON.stringify(s) }, { actionStyle: "component" });
  replace.dispatch("only");
  assert.deepEqual(replace.getState(), { a: 9 });
  replace.unmount();
  const canonical = mount(app, {
    state: { n: 0 }, props: { step: 3 },
    actions: { add: (state, payload, props) => ({ n: state.n + props.step * (payload?.times ?? 1) }) },
    render: (s) => `<i>${s.n}</i>`,
  }, { actionStyle: "canonical", props: { step: 5 } });
  canonical.dispatch("add", { times: 2 });
  assert.equal(canonical.getState().n, 10, "options.props override the component's props");
  assert.throws(() => canonical.dispatch("add", 1, 2), /single payload argument/);
});

test("an action that returns a non-object under actionStyle component/canonical is rejected", () => {
  const { app } = page();
  const c = mount(app, { state: { n: 0 }, actions: { bad: () => 5 }, render: () => "" }, { actionStyle: "component" });
  assert.throws(() => c.dispatch("bad"), /must return the next state object/);
  assert.throws(() => c.dispatch("missing"), /Action 'missing' not found/);
});

test("an action that changes nothing renders and notifies nobody", () => {
  const { app, window } = page();
  let renders = 0, notified = 0;
  const c = mount(app, counter(), { onRender: () => renders++ });
  c.subscribe(() => notified++);
  const before = renders;
  c.dispatch("noop");
  c.dispatch("set", 0);
  assert.equal(renders, before);
  assert.equal(notified, 0);
  c.dispatch("inc");
  assert.equal(renders, before + 1);
  assert.equal(notified, 1);
});

test("declarative arguments: JSON, plain strings, @value, @checked, @key", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, {
    state: {},
    actions: { rec: (state, ...args) => { seen.push(args); return { ...state }; } },
    render: () => '<button id="j" data-obix-action="rec" data-obix-arg=\'{"a":[1,2]}\'>j</button>' +
      '<button id="s" data-obix-action="rec" data-obix-arg="plain">s</button>' +
      '<input id="v" data-obix-action="rec" data-obix-event="input" data-obix-arg="@value">' +
      '<input id="c" type="checkbox" data-obix-action="rec" data-obix-event="change" data-obix-arg="@checked">' +
      '<input id="k" data-obix-action="rec" data-obix-event="keydown:Enter" data-obix-arg="@key">',
  });
  click(window, app.querySelector("#j"));
  click(window, app.querySelector("#s"));
  type(window, app.querySelector("#v"), "hello");
  const box = app.querySelector("#c");
  box.checked = true;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  key(window, app.querySelector("#k"), "a");
  key(window, app.querySelector("#k"), "Enter");
  assert.deepEqual(seen, [[{ a: [1, 2] }], ["plain"], ["hello"], [true], ["Enter"]]);
});

test("aria-disabled elements never dispatch; submit is default-prevented", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, {
    state: {}, actions: { go: (s) => { seen.push("go"); return { ...s }; }, save: (s) => { seen.push("save"); return { ...s }; } },
    render: () => '<button id="d" aria-disabled="true" data-obix-action="go">x</button><form id="f" data-obix-action="save" data-obix-event="submit"><button>ok</button></form>',
  });
  click(window, app.querySelector("#d"));
  const submit = new window.Event("submit", { bubbles: true, cancelable: true });
  app.querySelector("#f").dispatchEvent(submit);
  assert.deepEqual(seen, ["save"]);
  assert.equal(submit.defaultPrevented, true);
});

test("explicit events bindings (Gen-1 mount shape): selector + action + args, and a custom handler", () => {
  const { app, window } = page();
  const c = mount(app, {
    state: { n: 0 }, actions: { add: (s, by) => ({ n: s.n + by }) },
    render: (s) => `<button class="plus">+</button><button class="reset">r</button><i>${s.n}</i>`,
  }, { events: [
    { event: "click", selector: ".plus", action: "add", args: [5] },
    { event: "click", selector: ".reset", handler: (api) => api.dispatch("add", -api.getState().n) },
  ] });
  click(window, app.querySelector(".plus"));
  click(window, app.querySelector(".plus"));
  assert.equal(c.getState().n, 10);
  click(window, app.querySelector(".reset"));
  assert.equal(c.getState().n, 0);
});

test("focus and the caret survive a render caused by typing in the same field", () => {
  const { app, window, document } = page();
  mount(app, {
    state: { text: "" },
    actions: { edit: (s, text) => ({ text }) },
    render: (s) => `<input id="f" value="" data-obix-action="edit" data-obix-event="input" data-obix-arg="@value"><p>${s.text.length} chars</p>`,
  });
  const input = app.querySelector("#f");
  input.focus();
  type(window, input, "hello");
  input.setSelectionRange(1, 3);
  type(window, input, "hello!");
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "hello!");
  assert.equal(app.querySelector("p").textContent, "6 chars");
});

test("focus is put back on the same keyed element when a render had to replace it", () => {
  const { app, document } = page();
  const c = mount(app, {
    state: { wide: false },
    actions: { flip: (s) => ({ wide: !s.wide }) },
    render: (s) => (s.wide ? '<div><input data-obix-key="q" value="abc"></div>' : '<input data-obix-key="q" value="abc">'), // structure change: the input is recreated
  });
  const first = app.querySelector("input");
  first.focus();
  first.setSelectionRange(1, 2);
  c.dispatch("flip");
  const second = app.querySelector("input");
  assert.notEqual(second, first, "the element really was replaced");
  assert.equal(document.activeElement, second);
  assert.deepEqual([second.selectionStart, second.selectionEnd], [1, 2]);
});

test("undo goes back through retained states; history is bounded", () => {
  const { app } = page();
  const c = mount(app, counter(), { history: 3 });
  for (let i = 0; i < 6; i++) c.dispatch("inc");
  c.undo(); c.undo(); c.undo(); c.undo();
  assert.equal(c.getState().count, 3, "only 3 states were retained");
  assert.equal(app.querySelector("output").textContent, "3");
});

test("setProps merges props and re-renders", () => {
  const { app } = page();
  const c = mount(app, { state: {}, actions: {}, props: { who: "world" }, render: (s, p) => `<b>hello ${p.who}</b>` });
  assert.equal(app.innerHTML, "<b>hello world</b>");
  c.setProps({ who: "OBIX" });
  assert.equal(app.innerHTML, "<b>hello OBIX</b>");
});

test("batch coalesces several dispatches into one render", async () => {
  const { app } = page();
  let renders = 0;
  const c = mount(app, counter(), { batch: true, onRender: () => renders++ });
  const start = renders;
  c.dispatch("inc"); c.dispatch("inc"); c.dispatch("inc");
  assert.equal(renders, start, "nothing rendered yet");
  await Promise.resolve();
  assert.equal(renders, start + 1);
  assert.equal(app.querySelector("output").textContent, "3");
});

test("a hook that keeps changing the state is stopped, not looped forever", () => {
  const { app } = page();
  const c = mount(app, counter());
  const off = c.subscribe(() => {});
  off();
  let armed = false;
  const looping = mount(page().app, counter(), { afterRender: (s, container) => { if (armed) looping.dispatch("inc"); } });
  armed = true;
  assert.throws(() => looping.dispatch("inc"), /did not settle/);
});

test("mounting the same container twice is refused; unmount frees it; unmount is idempotent", () => {
  const { app } = page();
  const a = mount(app, counter());
  assert.throws(() => mount(app, counter()), /already has a mounted component/);
  a.unmount(); a.unmount();
  assert.equal(a.mounted, false);
  assert.equal(app.innerHTML, "", "the container is emptied");
  assert.equal(app.hasAttribute(MOUNT_ATTRIBUTE), false);
  assert.throws(() => a.dispatch("inc"), /unmounted/);
  const b = mount(app, counter());
  assert.equal(b.mounted, true);
});

test("clearOnUnmount:false leaves the rendered DOM (the Gen-1 behaviour) but removes listeners", () => {
  const { app, window } = page();
  const c = mount(app, counter(), { clearOnUnmount: false });
  c.unmount();
  assert.ok(app.querySelector("#inc"));
  click(window, app.querySelector("#inc"));
  assert.equal(app.querySelector("output").textContent, "0");
});

test("server-rendered markup is adopted in place on the first render", () => {
  const { app } = page('<div id="app"><button id="inc" data-obix-action="inc">Count: 0</button><output>0</output></div>');
  const button = app.querySelector("#inc");
  const c = mount(app, counter());
  assert.equal(app.querySelector("#inc"), button);
  c.dispatch("inc");
  assert.equal(app.querySelector("#inc"), button);
  assert.equal(button.textContent, "Count: 1");
});

test("nested mounts: the child owns its subtree, is untouched by parent renders, and is unmounted when the parent drops it", () => {
  const { app, window } = page();
  let child;
  const parent = mount(app, {
    state: { show: true, n: 0 },
    actions: { hide: (s) => ({ ...s, show: false }), bump: (s) => ({ ...s, n: s.n + 1 }) },
    render: (s) => `<h1 data-obix-action="bump" id="h">${s.n}</h1>${s.show ? '<div id="slot" data-obix-key="slot"></div>' : ""}`,
  }, { afterRender: (s, container) => { const slot = container.querySelector("#slot"); if (slot && !getMounted(slot)) child = mount(slot, counter()); } });
  assert.ok(child, "the child mounted from afterRender");
  const childButton = app.querySelector("#slot #inc");
  click(window, childButton);
  assert.equal(child.getState().count, 1, "the child handles its own click");
  assert.equal(parent.getState().n, 0, "the parent's delegator ignored the child's element");
  click(window, app.querySelector("#h"));
  assert.equal(app.querySelector("#slot #inc"), childButton, "a parent render left the child's DOM alone");
  assert.equal(childButton.textContent, "Count: 1");
  parent.dispatch("hide");
  assert.equal(child.mounted, false, "removing the child's container unmounted the child");
  assert.equal(app.querySelector("#slot"), null);
});

test("unmounting a parent unmounts its children first", () => {
  const { app } = page();
  let child;
  const parent = mount(app, { state: {}, actions: {}, render: () => '<div id="slot"></div>' }, { afterRender: (s, c) => { const slot = c.querySelector("#slot"); if (!getMounted(slot)) child = mount(slot, counter()); } });
  parent.unmount();
  assert.equal(child.mounted, false);
});

// ── managed runtime instances ────────────────────────────────────────────────────────────────────
function runtimeWith(actionStyle) {
  const rt = new ObixRuntime({ stabilityThreshold: 1000 }, [], { onDiagnostic: () => undefined });
  rt.register({
    name: "Counter", state: { count: 0 }, actionStyle,
    actions: actionStyle === "component"
      ? { inc: (s) => ({ ...s, count: s.count + 1 }) }
      : { inc: () => ({ count: 1 }), set: (n) => ({ count: n }) },
    render: (s) => `<button id="inc" data-obix-action="inc">+</button><output>${s.count}</output>`,
  });
  return rt;
}

test("managed instance: MOUNTED is announced once, after the first render is in the document", () => {
  const { app } = page();
  const rt = runtimeWith();
  const inst = rt.create("Counter");
  const seen = [];
  rt.onLifecycle((e) => seen.push([e.hook, app.querySelector("output")?.textContent ?? null]));
  mount(app, { runtime: rt, instanceId: inst.id });
  assert.deepEqual(seen, [["MOUNTED", "0"]]);
});

test("managed instance: clicks go through the runtime, UPDATED re-renders, revisions grow, undo works", () => {
  const { app, window } = page();
  const rt = runtimeWith("component");
  const inst = rt.create("Counter");
  const c = mount(app, { runtime: rt, instanceId: inst.id });
  const button = app.querySelector("#inc");
  click(window, button); click(window, button); click(window, button);
  assert.equal(app.querySelector("output").textContent, "3");
  assert.equal(inst.revision, 3);
  assert.equal(app.querySelector("#inc"), button);
  c.undo();
  assert.equal(app.querySelector("output").textContent, "2");
  assert.equal(inst.revisions.length, 3);
});

test("managed instance: a halted instance ignores clicks; resume re-renders", () => {
  const { app, window } = page();
  const rt = runtimeWith("component");
  const inst = rt.create("Counter");
  mount(app, { runtime: rt, instanceId: inst.id });
  click(window, app.querySelector("#inc"));
  rt.halt(inst.id);
  click(window, app.querySelector("#inc"));
  assert.equal(app.querySelector("output").textContent, "1");
  rt.resume(inst.id);
  click(window, app.querySelector("#inc"));
  assert.equal(app.querySelector("output").textContent, "2");
});

test("managed instance: destroying the instance unmounts the component and releases the runtime subscription", () => {
  const { app, window } = page();
  const rt = runtimeWith("component");
  const inst = rt.create("Counter");
  const log = spyListeners(app);
  const c = mount(app, { runtime: rt, instanceId: inst.id });
  rt.destroy(inst.id);
  assert.equal(c.mounted, false);
  assert.equal(app.innerHTML, "");
  assert.deepEqual([...log.removed].sort(), [...log.added].sort());
  // a second, independent instance is unaffected and still delivers to its own mount
  const other = rt.create("Counter");
  const app2 = page().app;
  const c2 = mount(app2, { runtime: rt, instanceId: other.id });
  c2.dispatch("inc");
  assert.equal(app2.querySelector("output").textContent, "1");
});

test("managed instance: unmount removes the runtime subscription (later updates render nothing)", () => {
  const { app } = page();
  const rt = runtimeWith("component");
  const inst = rt.create("Counter");
  let renders = 0;
  const c = mount(app, { runtime: rt, instanceId: inst.id }, { onRender: () => renders++, clearOnUnmount: false });
  c.unmount();
  const before = renders;
  rt.update(inst.id, "inc");
  assert.equal(renders, before);
});
