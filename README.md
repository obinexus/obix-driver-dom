# obix-driver-dom

> Previous name: `@obinexusltd/obix-driver-dom` — OBIX packages are named without an npm scope since decision D-102 (2026-09-29); the package, its version and its exports are unchanged.

**The OBIX browser driver: `mount` / `update` / `unmount` with keyed DOM morphing and delegated events — and the small binding helpers.** Zero runtime dependencies.

```ts
import { mount } from 'obix-driver-dom';

const counter = {
  state: { count: 0 },
  actions: { inc: (state) => ({ ...state, count: state.count + 1 }) },
  render: (state) => `<button data-obix-action="inc">Clicked ${state.count}</button>`,
};

const view = mount(document.getElementById('app'), counter);
view.dispatch('inc');      // or click the button: the delegated listener routes it
view.unmount();            // listeners, subscriptions and DOM are gone
```

## `mount(container, component, options?)`

| | |
|---|---|
| **Renders by morphing** | The container's children are made equal to the HTML string by changing the live DOM in place (`morph`). Focus, caret, text selection, scroll position and nested mounts survive a render; a form control keeps what the user typed unless the rendered value changed. The old whole-container `innerHTML` replacement destroyed all of those. |
| **One listener per event type** | Events are delegated to the container. The number of DOM listeners does not grow with renders or clicks, and returns to zero on `unmount`. Nothing is re-attached after a render. |
| **Managed dispatch** | Every interaction goes through `dispatch`. A dispatch that changes nothing (shallow-equal state) renders and notifies nobody. |
| **Declarative events** | `data-obix-action="name"` dispatches on `click`; `data-obix-event` selects another event (`input`, `change`, `submit`, `keydown:Enter`, `keydown:Space`); `data-obix-arg` is the argument (JSON, a string, `@value`, `@checked`, `@key`, `@attr:name`, `@prop:name`, `@selected`, `@files`, `@form`). `data-obix-on` declares several bindings on one element (below). `aria-disabled="true"` never dispatches. `submit` is default-prevented. Explicit `events: [{ event, selector, action, args }]` bindings (the Gen-1 `mount` shape) work as well. |
| **Action styles** | Declared, never inferred from arity: `partial` (default: `(state, …args) ⇒ Partial`, merged — covers the documented full-next-state actions *and* the Gen-1 factories that return a delta, which used to corrupt the state on first dispatch), `component` (returned state replaces), `canonical` (`(state, payload, props)`). |
| **Managed instances** | `mount(container, { runtime, instanceId })` renders an `ObixRuntime` instance: clicks go through `runtime.update`, `UPDATED`/`HALTED` re-render, `DESTROYED` unmounts, and the driver announces **`MOUNTED`** (the one lifecycle hook only a mounting driver may emit) once the first render is in the document. |
| **Nested mounts** | An element with a mount owns its subtree: parent renders skip it, parent delegators ignore its events, the parent unmounting (or dropping the element) unmounts it. |
| **Other** | `undo()` (bounded `history`), `setProps`, `subscribe`, `batch` (coalesce dispatches into one microtask render), `preserveFocus` (refocus the same keyed element when a render had to replace it), `clearOnUnmount`, `afterRender(state, container)`. Existing markup in the container (server-rendered) is adopted in place on the first render. |

Render output is inserted as markup, exactly like `innerHTML`: components must escape untrusted text.

## Behaviour declared in markup (Stage 5)

The OBIX components are pure string renderers. What they need from a browser — key handling, focus management, timers — is **declared in the markup they render** and executed here, delegated, so applications wire nothing. Each behaviour's listener is added the first time the markup uses it (a click-only component costs one listener type), and none grows with renders.

| Attribute | Behaviour |
|---|---|
| `data-obix-on="click=toggle; input=change(@value); keydown:Enter=save!; mouseenter.self=show"` | Several bindings on one element. `event[.self][:key]=action[(arg)][!]`: `.self` = only when the event's target is this element (a backdrop), `:key` = a `KeyboardEvent.key` (`Space` for the space bar), optionally with modifiers that must match **exactly** (`Shift+Tab`, `Ctrl+Enter`, `Shift+PageUp` — `PageUp` does not answer `Shift+PageUp`), `!` = `preventDefault()`. Bindings **bubble** through nested declarations like native events (nearest first): a calendar grid that handles arrow keys and the day buttons inside it that handle clicks both declare `data-obix-on`. Listeners for `focus`/`blur` use `focusin`/`focusout`; non-bubbling media, `toggle`, `scroll`, `mouseenter`/`mouseleave` events are caught in the capture phase. |
| `data-obix-roving="horizontal｜vertical｜both"` (+ `data-obix-follow-focus`) | Arrow keys, Home and End move focus between the container's items (`role` tab, radio, menuitem*, option, or `data-obix-roving-item`); disabled items are skipped and the ends wrap. With `follow-focus` the newly focused item is also clicked (tabs: selection follows focus). |
| `data-obix-dismiss="action"` or `"action(arg)"` (+ `data-obix-dismiss-focus="#trigger"`) | Escape inside the element dispatches the action (close a dialog, menu, popup, tooltip); only the nearest dismissable reacts. `dismiss-focus` returns the focus to that element afterwards. |
| `data-obix-trap` (+ `data-obix-autofocus`) | Tab and Shift+Tab cycle inside the element. When it appears in a render, focus moves into it (`autofocus` first, else the first focusable) and the previously focused element is remembered; when it disappears, focus goes back (the modal dialog pattern). |
| `data-obix-focus-scope` / `data-obix-focus` | State-driven roving focus: after a render, focus follows the element marked `data-obix-focus` when focus was already inside the scope (calendar days, menu items). Focus outside the scope is never stolen; if a render removes the very element that had focus (a calendar paged from a 6-row month to a 5-row one), the scope that held it takes it back instead of letting it fall to `<body>`. |
| `data-obix-keep-focus` | A mouse press inside must not move focus (listbox options, menu items whose owner keeps DOM focus and points at them with `aria-activedescendant`). |
| `data-obix-then-focus="#id"` | After the element's action ran and rendered, focus goes to that element (`#id` is an exact id, anything else a CSS selector). For controls that vanish when used (a clear or dismiss button). Read *before* the dispatch: a positional morph may reuse the element for something else. |
| `data-obix-after="action:ms"` (+ `data-obix-after-paused`) | A timer the markup owns: `ms` after the element appears, `action` is dispatched once. While the element also carries `data-obix-after-paused` the timer is suspended and resumes with the time that was left (toast auto-dismiss that pauses on hover and focus; tooltip open/close delays). Changing the declaration restarts it; elements that leave the DOM cancel theirs; `unmount` cancels all. |
| `data-obix-autoexpand` | A `<textarea>` grows with its content while typing and after each render. |
| `data-obix-media="playing=true;volume=0.5;muted=false;time=12;captions=en"` | On a `<video>`/`<audio>`: applies only the declared values that **changed** since the last render, so a viewer's own use of the native controls is not fought. |
| `data-indeterminate` | Drives a checkbox's `indeterminate` property in both directions (HTML has no attribute for it). |

Pass `behaviors: false` to `mount` to install none of this.

## Lower-level pieces

`morph(container, html, options?)` → stats `{ created, removed, moved, reused, attributesChanged, textChanged }`; `createDelegator(root)` → `{ on(type, selector, handler, { bubble }?), dispose(), listenerCount }` (`bubble: true` calls the handler for every matching ancestor, nearest first, instead of the nearest only); `getMounted(container)`.

The original binding helpers are unchanged: `bindText`, `bindAttr`, `bindBool`, `bindAria`, `bindPresence`, `bindEvent`, `createBindingGroup`.

## Verified

- 86 unit tests in jsdom (`npm test`; behaviours, timers with a fake clock, bubbling and lazy listeners in `test/behaviors.test.mjs` and `test/declarative.test.mjs`), including a 400-case random-document invariant (the morphed container equals a fresh parse of the new markup, and morphing twice is a no-op).
- 15 real-browser tests in Microsoft Edge via Playwright (`npm run test:browser`), each property paired with a control that shows the old `innerHTML` behaviour losing it: real clicks and keyboard typing, focus/caret/selection/scroll retention, mutation volume (1 text mutation vs 601 added + 601 removed nodes for one changed row of 200), listener counts, keyboard activation, accessibility-tree state, live-region persistence, nested mounts, 100 mount/unmount cycles, managed runtime + `MOUNTED`.
- The 31 OBIX components run on this driver in Edge (`tests/browser/components-interaction.browser.test.mjs`, 29 tests): every keyboard pattern above is exercised with real key presses.
- Bundle: 17.0 KB minified, 6.7 KB gzip for the whole package including the behaviours (9.7 KB / 4.0 KB before them; the historical "≤ 4 KB" claim concerned the helpers only).

Not verified: Chrome, Firefox and WebKit (only Edge/Chromium was available); screen-reader behaviour (only the accessibility tree and DOM/ARIA state are asserted).

<!-- obix-release:begin — generated by scripts/release/prepare.mjs; edit the text above this line -->

## Installation

```bash
npm install obix-driver-dom
```

## API surface

- `obix-driver-dom` — 14 value exports: `MOUNT_ATTRIBUTE`, `bindAria`, `bindAttr`, `bindBool`, `bindEvent`, `bindPresence`, `bindText`, `createBindingGroup`, `createDelegator`, `focusableWithin`, `getMounted`, `installBehaviors`, `morph`, `mount`
- Type declarations: `./dist/index.d.ts` (and a declaration next to every JS entry point).

## Architecture role

`obix-driver-dom` is a **driver**: it performs one platform effect for OBIX components (the DOM driver `obix-driver-dom` is the one applications use directly, to mount components).

The architecture of OBIX — the package families and which packages are public API — is indexed in the umbrella: [docs/architecture.md](https://github.com/obinexus/obix/blob/main/docs/architecture.md).

## Package relationships

- Depends on (OBIX): no other OBIX package.
- Used by (OBIX): [`obix-binding-jsx`](https://github.com/obinexus/obix-binding-jsx).

## Testing

- 7 test files ship in the npm package (`test/`): the evidence of the package's contract, published so that its verification can be inspected — not runtime code (no entry point reaches them).
- **Standalone**: 6 of 7 — they read nothing outside the package.
- **Need the OBIX development / test harness**: 1 — it reads the OBIX monorepo's shared harness, oracles or fixtures, so it does **not** run from an npm install or from this package's repository alone; it is shipped for inspection and provenance:
  - `test/runtime.test.mjs` — reads ../../../scripts/mini-dom.mjs, outside the package
- Run them with `npm test` (`node --test "test/*.test.mjs"`) in the OBIX monorepo, which provides the test tooling (Node's test runner, TypeScript) and the harness.

## Documentation

- [CHANGELOG.md](CHANGELOG.md)
- The OBIX architecture index: [obix/docs/architecture.md](https://github.com/obinexus/obix/blob/main/docs/architecture.md)

## Repository

- https://github.com/obinexus/obix-driver-dom — `git@github.com:obinexus/obix-driver-dom.git`
- Issues: https://github.com/obinexus/obix-driver-dom/issues
- The repository is a clean export of the package from the OBIX monorepo. Its lineage — the sources it was recovered from and its earlier names — is `PROVENANCE.json`, shipped in this package; the repository's copy also records the monorepo commit it was exported from.

## License

MIT — see [LICENSE](LICENSE).

<!-- obix-release:end -->
