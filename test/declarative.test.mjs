import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mount } from "../dist/index.js";
import { page, click, key, type } from "./helpers.mjs";

/** A component whose actions are the given functions and whose markup is `html(state)`. */
const comp = (state, actions, html) => ({ state, actions, render: (s) => html(s) });
const recorder = (seen) => new Proxy({}, { get: (_, name) => (state, ...args) => { seen.push([name, ...args]); return { ...state }; } });

// ── event options and arguments ─────────────────────────────────────────────────────────────────
test("click.self reacts to the declaring element only, not to what is inside it (a modal backdrop)", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, { state: {}, actions: recorder(seen), render: () => '<div id="backdrop" data-obix-on="click.self=close"><div id="panel"><button id="inner">x</button></div></div>' });
  click(window, app.querySelector("#inner"));
  click(window, app.querySelector("#panel"));
  assert.deepEqual(seen, []);
  click(window, app.querySelector("#backdrop"));
  assert.deepEqual(seen, [["close"]]);
});

test("@selected, @files, @form and @prop:<name> resolve from the event", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, {
    state: {},
    actions: recorder(seen),
    render: () =>
      '<select id="s" multiple data-obix-on="change=choose(@selected)"><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select>' +
      '<input id="f" type="file" data-obix-on="change=upload(@files)">' +
      '<form id="form" data-obix-on="submit=send(@form)!"><input name="who" value="ada"><input name="tag" value="x"><input name="tag" value="y"></form>' +
      '<input id="p" value="v" data-obix-on="input=prop(@prop:value)">'
  });
  const select = app.querySelector("#s");
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  const file = app.querySelector("#f");
  Object.defineProperty(file, "files", { value: [new window.File(["hello"], "a.txt", { type: "text/plain" })] });
  file.dispatchEvent(new window.Event("change", { bubbles: true }));
  const submit = new window.Event("submit", { bubbles: true, cancelable: true });
  app.querySelector("#form").dispatchEvent(submit);
  type(window, app.querySelector("#p"), "typed");
  assert.deepEqual(seen, [
    ["choose", ["a", "c"]],
    ["upload", [{ name: "a.txt", size: 5, type: "text/plain" }]],
    ["send", { who: "ada", tag: ["x", "y"] }],
    ["prop", "typed"]
  ]);
  assert.equal(submit.defaultPrevented, true);
});

// ── focus requests ──────────────────────────────────────────────────────────────────────────────
test("data-obix-then-focus: a control that disappears when used hands the focus to the element it names", () => {
  const { app, window, document } = page();
  mount(app, comp({ q: "abc" }, { clear: () => ({ q: "" }) }, (s) =>
    `<input id="q" value="${s.q}">${s.q ? '<button id="clear" data-obix-on="click=clear" data-obix-then-focus="#q">x</button>' : ""}`));
  app.querySelector("#clear").focus();
  click(window, app.querySelector("#clear"));
  assert.equal(app.querySelector("#clear"), null, "the button is gone");
  assert.equal(document.activeElement, app.querySelector("#q"));
});

test("data-obix-then-focus waits for the render of a batched mount", async () => {
  const { app, window, document } = page();
  mount(app, comp({ q: "abc" }, { clear: () => ({ q: "" }) }, (s) =>
    `<input id="q" value="${s.q}">${s.q ? '<button id="clear" data-obix-on="click=clear" data-obix-then-focus="#q">x</button>' : ""}`), { batch: true });
  await Promise.resolve();
  app.querySelector("#clear").focus();
  click(window, app.querySelector("#clear"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(app.querySelector("#clear"), null);
  assert.equal(document.activeElement, app.querySelector("#q"));
});

test("focus targets: `#id` is an exact id (ids with dots need no CSS escaping); anything else is a selector; a missing target is ignored", () => {
  const { app, window, document } = page();
  mount(app, comp({}, { noop: (s) => s }, () =>
    '<input id="a.b"><input id="cls" class="target"><button id="go1" data-obix-on="click=noop" data-obix-then-focus="#a.b">1</button>' +
    '<button id="go2" data-obix-on="click=noop" data-obix-then-focus=".target">2</button><button id="go3" data-obix-on="click=noop" data-obix-then-focus="#nope">3</button>' +
    '<button id="go4" data-obix-on="click=noop" data-obix-then-focus="[[bad">4</button>'));
  click(window, app.querySelector("#go1"));
  assert.equal(document.activeElement.id, "a.b");
  click(window, app.querySelector("#go2"));
  assert.equal(document.activeElement.id, "cls");
  app.querySelector("#go3").focus();
  click(window, app.querySelector("#go3"));
  assert.equal(document.activeElement.id, "go3", "no such id: focus stays");
  app.querySelector("#go4").focus();
  click(window, app.querySelector("#go4"));
  assert.equal(document.activeElement.id, "go4", "invalid selector: ignored, focus stays");
});

test("data-obix-dismiss-focus returns focus to an id target (Escape closes a popup opened from a trigger)", () => {
  const { app, window, document } = page();
  mount(app, comp({ open: true }, { close: () => ({ open: false }) }, (s) =>
    `<button id="trigger">menu</button>${s.open ? '<ul id="menu" data-obix-dismiss="close" data-obix-dismiss-focus="#trigger"><li><button id="item">i</button></li></ul>' : ""}`));
  app.querySelector("#item").focus();
  key(window, app.querySelector("#item"), "Escape");
  assert.equal(app.querySelector("#menu"), null);
  assert.equal(document.activeElement.id, "trigger");
});

// ── data-obix-after timers ──────────────────────────────────────────────────────────────────────
const toast = (extra = "") => (s) => (s.shown ? `<div id="t" role="status" data-obix-after="${s.spec ?? "hide:1000"}"${s.paused ? " data-obix-after-paused" : ""}${extra}>hello</div>` : "");

test("data-obix-after dispatches the action once, ms after the element appears", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { app } = page();
    const seen = [];
    mount(app, comp({ shown: true }, { hide: (s) => { seen.push("hide"); return { shown: false }; } }, toast()));
    mock.timers.tick(999);
    assert.deepEqual(seen, []);
    mock.timers.tick(1);
    assert.deepEqual(seen, ["hide"]);
    assert.equal(app.querySelector("#t"), null);
    mock.timers.tick(5000);
    assert.deepEqual(seen, ["hide"], "fires once");
  } finally {
    mock.timers.reset();
  }
});

test("data-obix-after-paused suspends the timer and resumes with the time that was left", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { app } = page();
    const seen = [];
    const m = mount(app, comp({ shown: true, paused: false }, {
      hide: () => { seen.push("hide"); return { shown: false }; },
      pause: () => ({ paused: true }),
      resume: () => ({ paused: false })
    }, toast()));
    mock.timers.tick(400);
    m.dispatch("pause");
    mock.timers.tick(10_000);
    assert.deepEqual(seen, [], "paused: nothing fires however long it takes");
    m.dispatch("resume");
    mock.timers.tick(599);
    assert.deepEqual(seen, []);
    mock.timers.tick(1);
    assert.deepEqual(seen, ["hide"], "600 ms were left");
  } finally {
    mock.timers.reset();
  }
});

test("data-obix-after: a changed declaration restarts the timer, a removed element cancels it, unmount cancels all", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { app } = page();
    const seen = [];
    const m = mount(app, comp({ shown: true, spec: "hide:1000" }, {
      hide: () => { seen.push("hide"); return { shown: false }; },
      retime: (s, spec) => ({ ...s, spec }),
      remove: () => ({ shown: false }),
      show: () => ({ shown: true, spec: "hide:1000" })
    }, toast()));
    mock.timers.tick(900);
    m.dispatch("retime", "hide:2000");
    mock.timers.tick(1999);
    assert.deepEqual(seen, [], "restarted at the new duration");
    mock.timers.tick(1);
    assert.deepEqual(seen, ["hide"]);
    m.dispatch("show");
    mock.timers.tick(500);
    m.dispatch("remove");
    mock.timers.tick(5000);
    assert.deepEqual(seen, ["hide"], "the removed element's timer never fires");
    m.dispatch("show");
    m.unmount();
    mock.timers.tick(5000);
    assert.deepEqual(seen, ["hide"], "unmount cancelled the timer");
  } finally {
    mock.timers.reset();
  }
});

// ── properties and sizing ───────────────────────────────────────────────────────────────────────
test("data-indeterminate drives the checkbox's indeterminate property in both directions", () => {
  const { app } = page();
  const m = mount(app, comp({ mixed: true }, { set: (s, mixed) => ({ mixed }) }, (s) => `<input type="checkbox" id="c"${s.mixed ? ' data-indeterminate="true"' : ""}>`));
  assert.equal(app.querySelector("#c").indeterminate, true);
  m.dispatch("set", false);
  assert.equal(app.querySelector("#c").indeterminate, false);
  m.dispatch("set", true);
  assert.equal(app.querySelector("#c").indeterminate, true);
});

test("data-obix-autoexpand grows a textarea with its content after render and while typing", () => {
  const { app, window } = page();
  let height = 40;
  Object.defineProperty(window.HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => height });
  mount(app, comp({ v: "" }, { set: (s, v) => ({ v }) }, (s) => `<textarea id="t" data-obix-autoexpand data-obix-on="input=set(@value)">${s.v}</textarea>`));
  const area = app.querySelector("#t");
  assert.equal(area.style.height, "40px");
  height = 120;
  type(window, area, "line 1\nline 2\nline 3");
  assert.equal(app.querySelector("#t").style.height, "120px");
});

// ── state-driven roving focus ───────────────────────────────────────────────────────────────────
test("data-obix-focus-scope: focus follows the marked element when it is inside the scope, and is never stolen from outside", () => {
  const { app, window, document } = page();
  const cells = [0, 1, 2];
  const m = mount(app, comp({ at: 0 }, { go: (s, at) => ({ at }) }, (s) =>
    `<div data-obix-focus-scope>${cells.map((c) => `<button id="c${c}" tabindex="${c === s.at ? 0 : -1}"${c === s.at ? " data-obix-focus" : ""}>${c}</button>`).join("")}</div><button id="outside">o</button>`));
  app.querySelector("#c0").focus();
  m.dispatch("go", 2);
  assert.equal(document.activeElement.id, "c2");
  app.querySelector("#outside").focus();
  m.dispatch("go", 1);
  assert.equal(document.activeElement.id, "outside", "focus outside the scope is left alone");
});

test("data-obix-keep-focus: pressing the mouse inside does not steal focus from the input", () => {
  const { app, window } = page();
  mount(app, comp({}, {}, () => '<input id="i"><ul data-obix-keep-focus><li id="o">option</li></ul><p id="p">other</p>'));
  const inside = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  app.querySelector("#o").dispatchEvent(inside);
  assert.equal(inside.defaultPrevented, true);
  const outside = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  app.querySelector("#p").dispatchEvent(outside);
  assert.equal(outside.defaultPrevented, false);
});

// ── media ───────────────────────────────────────────────────────────────────────────────────────
test("data-obix-media applies only the declared values that changed, so the user's own use of the controls is not fought", () => {
  const { app, window } = page();
  const calls = [];
  const proto = window.HTMLMediaElement.prototype;
  Object.defineProperty(proto, "play", { configurable: true, value() { calls.push("play"); return Promise.resolve(); } });
  Object.defineProperty(proto, "pause", { configurable: true, value() { calls.push("pause"); } });
  const m = mount(app, comp({ playing: false, volume: 0.5, muted: false, note: 0 }, { set: (s, patch) => ({ ...s, ...patch }) }, (s) =>
    `<video id="v" data-obix-media="playing=${s.playing};volume=${s.volume};muted=${s.muted}" data-note="${s.note}"></video>`));
  const video = app.querySelector("#v");
  assert.equal(video.volume, 0.5);
  assert.deepEqual(calls, ["pause"]);
  video.volume = 0.9; // the viewer used the native volume control
  m.dispatch("set", { note: 1 }); // an unrelated re-render
  assert.equal(video.volume, 0.9, "unchanged declaration: the viewer's value stands");
  m.dispatch("set", { playing: true });
  m.dispatch("set", { volume: 0.2, muted: true });
  assert.deepEqual(calls, ["pause", "play"]);
  assert.equal(video.volume, 0.2);
  assert.equal(video.muted, true);
});

// ── delegation stays constant ───────────────────────────────────────────────────────────────────
test("listener types are registered lazily from the markup and never grow with renders", () => {
  const { app, window } = page();
  const added = [];
  const original = app.addEventListener.bind(app);
  app.addEventListener = (type, ...rest) => { added.push(type); return original(type, ...rest); };
  const m = mount(app, comp({ n: 0 }, { inc: (s) => ({ n: s.n + 1 }) }, (s) => `<button id="b" data-obix-on="click=inc; mouseenter.self=inc">${s.n}</button>`));
  const afterMount = added.length;
  for (let i = 0; i < 25; i++) click(window, app.querySelector("#b"));
  assert.equal(added.length, afterMount, "25 renders added no listeners");
  assert.ok(added.includes("click") && added.includes("mouseenter"));
  assert.ok(!added.includes("keydown") || added.filter((t) => t === "keydown").length === 1);
  m.unmount();
});

// ── bubbling through nested data-obix-on ─────────────────────────────────────────────────────────
test("data-obix-on bubbles like native events: an ancestor's binding fires for events from a descendant that has bindings of its own for other events", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, {
    state: {},
    actions: recorder(seen),
    render: () => '<table data-obix-on="keydown:ArrowRight=right!; click=gridClick"><tr><td><button id="day" data-obix-on="click=pick">15</button></td></tr></table>'
  });
  const day = app.querySelector("#day");
  const arrow = key(window, day, "ArrowRight");
  click(window, day);
  assert.deepEqual(seen, [["right"], ["pick"], ["gridClick"]], "keydown reached the grid; click ran nearest first, then the ancestor");
  assert.equal(arrow.defaultPrevented, true);
});

test("data-obix-on: an element outside the mount, or inside a nested mount, is not reached by bubbling", () => {
  const { app, window } = page('<div id="outer" data-obix-on="click=leak"><div id="app"></div></div>');
  const seen = [];
  mount(app, { state: {}, actions: recorder(seen), render: () => '<button id="b" data-obix-on="click=inner">b</button>' });
  click(window, app.querySelector("#b"));
  assert.deepEqual(seen, [["inner"]]);
});

test("behaviour listeners are lazy: markup with only clicks adds one listener type; a dismiss or roving declaration adds keydown, keep-focus adds mousedown, once", () => {
  const { app, window } = page();
  const added = [];
  const original = app.addEventListener.bind(app);
  app.addEventListener = (type, ...rest) => { added.push(type); return original(type, ...rest); };
  const m = mount(app, comp({ n: 0, rich: false }, { inc: (s) => ({ ...s, n: s.n + 1 }), more: (s) => ({ ...s, rich: true }) }, (s) =>
    `<button id="b" data-obix-on="click=inc">${s.n}</button>${s.rich ? '<ul data-obix-roving="vertical" data-obix-dismiss="inc" data-obix-keep-focus><li role="menuitem" tabindex="0">a</li></ul>' : ""}`));
  assert.deepEqual(added, ["click"], "nothing but the click delegate");
  m.dispatch("more");
  assert.deepEqual([...added].sort(), ["click", "keydown", "mousedown"]);
  const count = added.length;
  m.dispatch("inc");
  m.dispatch("inc");
  assert.equal(added.length, count, "further renders add nothing");
});

test("key filters match modifiers exactly: Shift+PageUp is not PageUp, Enter is not Ctrl+Enter, Shift+Tab has its own binding", () => {
  const { app, window } = page();
  const seen = [];
  mount(app, { state: {}, actions: recorder(seen), render: () => '<input id="i" data-obix-on="keydown:PageUp=month; keydown:Shift+PageUp=year; keydown:Enter=go; keydown:Ctrl+Enter=force; keydown:Tab=fwd; keydown:Shift+Tab=back">' });
  const i = app.querySelector("#i");
  const press = (k, init = {}) => i.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  press("PageUp");
  press("PageUp", { shiftKey: true });
  press("Enter");
  press("Enter", { ctrlKey: true });
  press("Tab");
  press("Tab", { shiftKey: true });
  press("Enter", { altKey: true }); // no binding for Alt+Enter: nothing
  assert.deepEqual(seen, [["month"], ["year"], ["go"], ["force"], ["fwd"], ["back"]]);
});

test("data-obix-focus-scope takes the focus back when a render removes the focused element (a calendar paging from a long month to a short one)", () => {
  const { app, window, document } = page();
  const days = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const m = mount(app, comp({ month: "long", at: 6 }, { show: (s, month, at) => ({ month, at }) }, (s) =>
    `<div data-obix-focus-scope>${days(s.month === "long" ? 8 : 3).map((d) => `<button id="d-${s.month}-${d}" tabindex="${d === s.at ? 0 : -1}"${d === s.at ? " data-obix-focus" : ""}>${d}</button>`).join("")}</div>`));
  app.querySelector("#d-long-6").focus();
  assert.equal(document.activeElement.id, "d-long-6");
  m.dispatch("show", "short", 2); // the focused button (6th) does not exist in the short month
  assert.equal(document.activeElement.id, "d-short-2", "focus was given back to the scope's marked element instead of falling to <body>");
  const outside = page('<button id="o">o</button><div id="app"></div>');
  const n = mount(outside.app, comp({ month: "long", at: 6 }, { show: (s, month, at) => ({ month, at }) }, (s) => `<div data-obix-focus-scope><button id="x-${s.month}" data-obix-focus>x</button></div>`));
  n.dispatch("show", "short", 2);
  assert.notEqual(outside.document.activeElement.id, "x-short", "focus that was never inside the scope is not pulled in");
});
