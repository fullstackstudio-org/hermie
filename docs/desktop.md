# Hermie Desktop

`apps/desktop` is a downloadable Hermie client for macOS, Windows and Linux, built with Tauri 2 on
the system webview (WKWebView, WebView2, WebKitGTK). It is a shell: one window, one webview,
pointed at a Hermie Web instance an operator already runs. Why that shape and not a bundled export
that talks to a gateway directly is [ADR-0027](adr/0027-desktop-is-a-webview-over-hermie-web.md).

> **The Hermie Web this shell was built against is removed.** The standalone Node server (0.1.x)
> that served the page the shell loads is gone from this repository and from our gateways, and
> [ADR-0030](adr/0030-web-client-served-by-the-plugin.md) amends ADR-0027: the page the shell loads is
> now the gateway's own web client, `https://<gateway>/dashboard-plugins/hermie/app/index.html`, served
> by the `hermie` plugin. The shell's code, its strings and the rest of this page still say "Hermie
> Web" and describe the old server; re-pointing the shell at the new client, and what that does to
> the bridge's origin rules, is open work. The manual test matrix at the bottom is a record of the
> runs against the old server, not of the new client.

This page is filled in task by task, alongside the code. A section with nothing under it yet says
so rather than being left out — the same rule applies to
the manual test matrix at the bottom.

## What v1 does not do

- No direct gateway connection without Hermie Web; no address step; no native PKCE; no Cloudflare
  service token; no extra headers. Put Access in front of Hermie Web instead.
- No notifications while the app is not running; no Web Push in the shell.
- No multiple windows, no tabs, no per-gateway windows; no picture-in-picture of two gateways.
- No store distribution (Mac App Store, Microsoft Store, Snap, Flatpak, Homebrew cask, winget); no
  `.rpm`.
- No app lock / biometrics; no keychain; no proxy settings UI (the webview uses the system proxy).
- No translation of the shell's two pages beyond English (the app page is translated already).
- No Intel-only or ARM-only Mac build: one universal DMG.

## Running it locally

```sh
npm run fake-gateway -- --auth cookie               # or your own gateway
npm run client:dev                                   # the web client, on localhost:5173
HERMIE_WEB_URL=http://localhost:5173/dashboard-plugins/hermie/app/ npm run desktop   # not yet re-tested against the new client
```

`npm run desktop` is `tauri dev`; `npm run desktop:build` is `tauri build`. Without `HERMIE_WEB_URL`
set, the window opens on the bundled placeholder page (`connect.html`) instead — there is no gateway
list yet (Task 3 builds it); the environment variable is the only way in for now.

**`HERMIE_WEB_URL` is read by debug builds only.** A release binary ignores it and opens the
placeholder page whatever the environment says. The variable does not only choose the first page: it
becomes a configured gateway, which is an origin the shell grants the bridge to, and an environment
variable is not something the reader configured. In a debug build the value goes through the same
validator a typed address does, so the dev bed is not a way past any of those rules; a value that
fails is logged and ignored, and the shell starts with nothing granted.

The Tauri CLI is a build-time tool, not an npm dependency the shared `node_modules` can carry (this
repository never runs `npm install` inside an agent worktree). Install it once with:

```sh
cargo install tauri-cli --version "^2" --locked
```

and either run `cargo tauri dev` / `cargo tauri build --debug` directly from `apps/desktop`, or, once
a real `npm install` has populated `node_modules/.bin/tauri` from `@tauri-apps/cli` in
`apps/desktop/package.json`, the `npm run desktop*` scripts above.

## The bridge

The page the shell shows is the unmodified browser build a Hermie Web serves. The shell adds a
bridge the page can feature-detect, and everything about it is optional in both directions: an
operator updates their Hermie Web on their own cadence and the shell updates on its own, so "a page
newer than the shell" and "a shell newer than the page" are both permanent, normal states.

### The marker

Before any page script runs, the shell sets:

```js
window.__HERMIE_DESKTOP__ = Object.freeze({ version: 1, platform: 'macos' | 'windows' | 'linux' })
```

That is the whole of "am I in the shell". The app reads it through
`expo/hermie/src/platform/desktop-shell.ts`, which exports `RUNS_IN_DESKTOP_SHELL` and
`DESKTOP_SHELL_PLATFORM` as constants beside `RUNS_IN_BROWSER` and `RUNS_ON_MAC`. A marker whose
shape the app does not recognise — no version, a platform it has never heard of — reads as "not in
the shell", which leaves the app in its plain-browser behaviour rather than branching on a value it
cannot interpret.

The marker is injected on **every** page the window loads, the identity provider's included. It is
an announcement, not a credential; what actually gates the bridge is the ACL, below.

**On Windows it reaches every frame, not only the top one.** Tauri asks for a main-frame-only
initialization script, and WKWebView and WebKitGTK honour that, but wry's WebView2 backend
implements initialization scripts with `AddScriptToExecuteOnDocumentCreated`, which runs in every
frame and does not consult the flag. So on Windows a third-party iframe inside the app page sees
this marker and Tauri's own globals. That is an accepted residual and not a way in: an `invoke` from
such a frame is refused before any command runs, because the ACL matches the **calling frame's**
origin against the gateways the reader configured. What leaks is "this page is inside Hermie's
desktop shell".

### The six commands

`window.__TAURI__.core.invoke(...)` (the shell sets `withGlobalTauri`; `expo/hermie` imports nothing
Tauri, at module scope or otherwise, so a browser tab's bundle never grows a line for this). Each
answers `{ ok: true, … }` or `{ ok: false, reason }` and never rejects of its own accord.

| Command                | Args                                            | Purpose                                                                 |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `hermie_shell_info`    | —                                               | `{ version, platform, bridge: 1, gatewayId, gatewayName }`              |
| `hermie_set_menu`      | `{ titles: MenuBarTitles, chats: [] }`          | Rebuild the native Chats menu (first nine chats). Stub until Task 6.    |
| `hermie_notify`        | `{ notification: { id, title, body?, link? } }` | OS notification; click focuses the window. Stub until Task 5.           |
| `hermie_set_badge`     | `{ count: number \| null }`                     | Dock badge / overlay icon / tray tooltip. Stub until Task 5.            |
| `hermie_open_gateways` | —                                               | Show the shell's gateway picker. Stub until Task 3.                     |
| `hermie_close_handled` | `{ handled: boolean }`                          | Answer a `close` shortcut; `false` hides the window. Stub until Task 6. |

Six, and exactly six. A seventh is a deliberate design change, not a routine edit —
Task 7 has one candidate (`hermie_save_file`, only if a platform's webview turns out not to raise a
download event for `blob:` URLs).

`version` is the SHELL's version, which `scripts/set-version.mjs` keeps equal to the app's. It is
not the version of the page, which is Hermie Web's and may legitimately differ. `bridge` is the
contract's own number and is what the app keys behaviour on; an incompatible change bumps it and the
app keeps the old path for one release.

### The four events

Tauri events on the main window. A page on an origin you have not configured **cannot register a
Tauri event listener at all** — `plugin:event|listen` is refused by the ACL — so it receives none of
these, and none of Tauri's own window events either. A page that is on a configured origin can also
listen to Tauri's own window events (`tauri://focus`, `tauri://resize`, `tauri://close-requested`,
…): `core:event:allow-listen` cannot be scoped to event names. That is accepted — it is the app, and
none of those payloads carries anything it does not already know.

| Event               | Payload                                                        |
| ------------------- | -------------------------------------------------------------- |
| `hermie://shortcut` | `ShortcutEvent` `{ action, typing: false }`, from a menu item. |
| `hermie://link`     | `{ url: 'hermie://…' }`, a deep link or notification click.    |
| `hermie://gateway`  | `{ id, name }`, after a switch and before the navigation.      |
| `hermie://focus`    | `{}`, the window regained focus.                               |

### Who may use the bridge

This is the security core of the feature. The shell navigates one webview across origins **on
purpose** — signing in walks through an identity provider's pages, a Cloudflare Access page, or
Hermie Web's own OIDC issuer, and every one of those is a page the shell loaded. So "which page is
asking" has to be answered per call, and only one component in Tauri can answer it honestly.

**The ACL is the boundary.** There is no capability file for remote origins.
`apps/desktop/src-tauri/capabilities/` holds `local-pages.json` and nothing else; for every entry in
the gateway list the shell registers one **runtime** capability instead —
`src-tauri/src/bridge.rs::grant`, via `Manager::add_capability`:

- identifier `remote-app:<id>`;
- `local(false)`, so it can never reach the shell's own pages;
- `window("main")`, the one window there is;
- one `remote` pattern that is **exactly that entry's origin** — lowercased host, and the port
  written only when it is not the scheme's default, because a `Url` drops a default port when it
  parses and a URLPattern with no port component matches the default port only (verified against
  `tauri-utils` 2.9.3's `RemoteUrlPattern`, not assumed). An IPv6 host's colons are escaped, because
  `http://[::1]:9120` is a tokenizer error as a pattern;
- exactly the eight permissions in `bridge::REMOTE_PERMISSIONS`: the six commands plus
  `core:event:allow-listen` and `core:event:allow-unlisten`. Nothing else — no `fs`, no `shell`, no
  `dialog`, no `opener`, no `core:window`, and not even the notification plugin's own permission
  (the shell's `hermie_notify` wraps it).

Grants are made in `setup()` for every stored entry, **before** the window is navigated anywhere, and
in `gateways::add` for a new one (Task 3). Every entry is granted, not only the active one: switching
is a navigation, and a call from the page that was live a moment ago is still the app's.

Why the ACL and not the command: `RuntimeAuthority::resolve_access` runs before the command and
matches `InvokeRequest.url`, which is the **calling frame's** URL — read from the IPC request's
`Origin` header on the fetch path and from wry's message-source URI on the `postMessage` fallback,
neither of which page script can set. A command only ever sees `webview.url()`, the **top frame**.
Those answers come apart in exactly two ways that matter, and both were live holes in the first
version of this bridge: a cross-origin iframe on Windows (see the marker section), and a page that
fires calls and then navigates the window to a configured origin so the in-flight calls land after
the navigation commits.

**A grant cannot be withdrawn**, so forgetting a gateway relaunches the shell: `gateways::forget`
writes the store, clears the browsing data and calls `AppHandle::restart()` (Task 3 builds it; the
connect page's confirmation says the window will reopen). The invariant that buys is exact — the set
of granted origins equals the stored list at every moment a page can run. Switching and adding do not
restart.

**The guard is the second layer, and it can only refuse.** Every command also takes
`tauri::ipc::Request` and calls `bridge::guard`, which (1) requires the **top frame** to be on a
configured origin, and (2) requires an `Origin` header, when the request carries one, to name a
configured origin too. A header that is present and does not parse is a refusal. The refusal is
`{ ok: false, reason: 'origin' }` and says nothing about which check said no.

The header may only ever _refuse_. On the fetch path it is browser-set and script-proof (`Origin` is
a forbidden header name), but Tauri falls back to `postMessage` whenever the fetch to the `ipc`
scheme fails — a page CSP whose `connect-src` blocks it, for instance — and on that path the headers
are whatever the page put in `invoke`'s options. A command cannot tell which path a request took, so
a forged header can make the forger's own call stricter and never looser. What the second layer is
actually _for_ is the reverse framing shape: a configured Hermie Web embedded inside an unconfigured
top page passes the ACL on its own origin, and the top-frame check refuses it. `emit_to_app` in
`src-tauri/src/lib.rs` keeps the same top-frame check at emit time, split out as `should_emit` so it
is unit-tested.

From an unconfigured origin an `invoke` therefore **rejects** (Tauri's own ACL error) rather than
answering `{ ok: false }`. The app-side facade treats a rejection and a refusal alike, as "no".

**Every URL goes through one validator** (`src-tauri/src/gateways.rs::validate`), whatever it came
from — typed on the connect page, read back from `gateways.json`, or set in `HERMIE_WEB_URL`. It
requires `http`/`https` and a host, and refuses userinfo, a query, a fragment, a trailing dot on the
host (`host.` and `host` are different origins), a host with any character outside `[a-z0-9.-]` or a
bracketed IP literal, `tauri://localhost`, any `*.localhost`, and the dev server's own
`http://localhost:1420` — Tauri would call a page on those local and hand it `core:default`. Bare
`localhost` is allowed; it is where a dev Hermie Web runs, and it stays a different origin from
`127.0.0.1`. The last rule is the one that makes the rest exact: the resulting origin pattern must
parse as a `RemoteUrlPattern`, because `add_capability` parses and unwraps it internally and a bad
pattern would otherwise panic at a reader's launch. A stored entry that fails validation on load is
skipped and logged, never granted and never navigated to.

`cargo test` in `apps/desktop/src-tauri` covers all of this, and the part that matters is covered
**through the ACL**: `src/acl.rs` builds an app on `tauri::test::mock_builder()` with the real
`tauri::generate_context!()` and sends real IPC requests, because `mock_context` carries no app ACL
manifest and Tauri then skips the ACL for app commands entirely — a suite built on it would pass with
every capability deleted.

### The app-side seams

Everything in `expo/hermie` that knows about the shell is gated on the marker and is a no-op in a
plain tab and on native.

- `src/platform/desktop-shell.ts` — the constants and the typed facade. Reads globals lazily; imports
  nothing Tauri.
- `src/gateway/client.ts` (`attachLifecycle`) and `src/features/chats/ChatRuntime.tsx` — **the shell
  never pauses its connection and never stops its polls**, exactly as the iPad-build Mac app does.
  This matters more here than on the Mac: this is the browser build, and react-native-web reports
  AppState `background` whenever `document.hidden`, so a window that is merely minimised, hidden with
  ⌘H or covered by another window would otherwise tear its socket down on every ⌘Tab. It is also the
  window where a live socket has a second job — it is what raises notifications (Task 5), since a
  webview has no Push API. A browser **tab** still pauses, which is right: a background tab may be
  throttled to a halt.

The menu and shortcut subscription, the deep-link subscription, the notifier and the Settings rows
are Tasks 5 and 6; each is built against the contract above.

## Gateways

The connect page, the list of Hermie Web URLs, the Gateway menu. Not built yet — Task 3.

## Sign-in

The auth matrix (ungated, gateway password, gateway OAuth, the built-in OIDC issuer, Cloudflare
Access), one row per mode, dated. Not built yet — Task 4.

## Notifications

The decision table for when a live-connection event becomes an OS notification, and the badge.
Not built yet — Task 5.

## Menu bar, shortcuts, window state, deep links

Task 1 covers the Edit menu roles (Cut/Copy/Paste reaching the webview) and window state
persistence only — see the matrix below. The Chats menu built from the page's own shortcut table,
the rest of the native menu, and `hermie://` deep links are not built yet — Task 6.

## Files: drop, paste, picker, downloads, external links

Drag-and-drop, the picker, downloads and reveal, external links to the system browser. Not built
yet — Task 7 (paste is covered in Task 1's matrix below, since it is what the shell exists for).

## Known limits

- `cargo tauri build --debug`'s DMG step (`hdiutil create` inside `bundle_dmg.sh`) hung
  indefinitely in the sandboxed agent worktree this task was built in — the raw `.dmg` was written
  in full (46 MB, matching the payload) and then `hdiutil` never returned, with no further disk
  activity. `cargo check` and the `.app` bundle it produces are unaffected: `Hermie.app` built,
  carried the right `Info.plist` (identifier, name, version, `icon.icns`, `LSMinimumSystemVersion`),
  and ran correctly through the whole manual pass below. Reasoned, not watched: this looks like a
  disk-arbitration restriction specific to the sandbox (`diskarbitrationd`, which `hdiutil` needs),
  not a bug in the desktop shell's own config — Task 8, which does real DMG signing/notarization on
  the owner's own Mac, is where this gets a real answer.

## Manual verification matrix

One row per platform, dated, for what has actually been watched happen — not inferred from reading
the code. "Reasoned, not watched" is written as such rather than left blank and rather than claimed
as tested.

### Task 1 — scaffold, macOS (2026-09-22)

Bed: `packages/fake-gateway` in cookie-auth mode on `127.0.0.1:9119` and Hermie Web on
`127.0.0.1:9120` (both via `npm run web`), the shell launched as
`HERMIE_WEB_URL=http://127.0.0.1:9120 ./Hermie.app/Contents/MacOS/hermie-desktop` — the built debug
binary directly, since `npm run desktop` needs a real `npm install` in the main checkout to
populate `node_modules/.bin/tauri` (see "Running it locally" above; this agent's worktree shares
`node_modules` with the main checkout and never runs `npm install` itself).

| Check                                   | Result                | Notes                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window opens on `HERMIE_WEB_URL`        | Pass                  | Opened straight to the Hermie Web sign-in page at 1100×760, real title bar reading "Hermie".                                                                                                                                                                                                                   |
| Sign in, connection test, onboarding    | Pass                  | Not a Task 1 acceptance criterion, but walked end to end (password sign-in, REST/WebSocket/profiles test, notifications step, done) to reach a chat — the shell is a plain webview here, nothing shell-specific to it.                                                                                         |
| Drag-select text in a bubble, then ⌘C   | Pass                  | Selected "I am researcher, at your service." in a bot's bubble with a mouse drag and copied it; `pbpaste` afterwards returned exactly that string. This is the one the whole task exists for: `dragDropEnabled: false` plus the Edit menu's native Copy role is what makes it possible in a bare Tauri window. |
| ⌘V pastes into the composer             | Pass                  | Pasted the same string into the message field; it landed as typed text and the send button enabled.                                                                                                                                                                                                            |
| Window size/position survive a relaunch | Pass                  | Moved the window to (164, 143) and resized it to 886×617, quit with ⌘Q, relaunched: `CGWindowListCopyWindowInfo` reported the identical bounds on the new process — `tauri-plugin-window-state`.                                                                                                               |
| Cookie session survives a relaunch      | Reasoned, not watched | Not this task's job (Task 4's auth matrix covers it) and not confirmed either way here — the fake gateway's own session had already expired by the second launch, which reads as that test session's short lifetime, not the shell.                                                                            |

Window-only screenshot (`screencapture -l <windowid>`, never the whole screen) of the paste landing
in the composer, taken after the copy above: see the handoff for this task for the file path (it
lives in the agent's scratch directory, not the repository).

### Task 2 — the bridge and the origin guard, macOS (2026-09-22)

> **Superseded by Task 2b, below.** The trust model this table describes was the wrong one: the
> guard compared the WINDOW's URL while Tauri's ACL compares the CALLING FRAME's, and the static
> `https://*:*` capability meant the ACL said yes to every origin. Two rows here read differently
> now and were re-run: "all six commands from another origin" (a rejection from the ACL, not
> `{ ok: false }`) and "`core:event:allow-listen` from an unconfigured origin" (refused, not
> "Pass (by design)"). The rest of the table still stands. It is kept rather than edited because
> what it recorded did happen.

Bed: a two-origin probe harness rather than the app, because the property under test is about the
WINDOW's current URL and needs two origins in one shell session. Two plain Node servers on
`127.0.0.1:9121` and `127.0.0.1:9122` serve the same page, which reads `window.__HERMIE_DESKTOP__`,
calls all six `hermie_*` commands plus two commands the capability does not carry
(`plugin:opener|open_url`, `plugin:fs|read_text_file`), registers an event listener, POSTs the
result to its own server, and then navigates the window to the other port. The shell ran as
`HERMIE_WEB_URL=http://127.0.0.1:9121 ./target/debug/hermie-desktop`, so `:9121` is the configured
Hermie Web and `:9122` is not. The page-load path was then re-checked against the real bed
(`packages/fake-gateway` on `:9119` plus Hermie Web on `:9120`).

| Check                                                 | Result                | Notes                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marker on the configured origin                       | Pass                  | `{ platform: 'macos', version: 1 }`, and frozen: assigning `version = 99` left it at `1`.                                                                                                                                                             |
| All six commands from the configured origin           | Pass                  | Each answered `{ ok: true }`; `hermie_shell_info` answered `{ ok: true, version: '0.1.0', platform: 'macos', bridge: 1, gatewayId: 'dev', gatewayName: '127.0.0.1' }`.                                                                                |
| All six commands from another origin                  | Pass                  | After a real top-level navigation to `http://127.0.0.1:9122/` in the same window, every one answered `{ ok: false, reason: 'origin' }` — same host, different port, which is the case a path-only check would miss.                                   |
| Commands outside the capability                       | Pass                  | `plugin:opener\|open_url` and `plugin:fs\|read_text_file` were REJECTED by Tauri's ACL from both origins ("not allowed", "Plugin not found") — they never reach a command body at all.                                                                |
| `core:event:allow-listen` from an unconfigured origin | Pass (by design)      | Registering a listener succeeds from any http(s) origin, because the capability grants it and capabilities are static. What that page must never get is a delivered event, and that is `emit_to_app`'s job.                                           |
| An event actually withheld from an unconfigured page  | Reasoned, not watched | Nothing emits yet — the four events are Tasks 5 and 6. `emit_to_app` runs the same `bridge::guard` the commands do, and the guard itself is covered by `cargo test`; this row gets watched in Task 5.                                                 |
| The real app page still loads, with the bridge on     | Pass                  | Against Hermie Web on `:9120`: the export built from this branch opened on onboarding step 1 ("Inloggen", "Geleverd door Hermie Web, verbonden met 127.0.0.1:9119"), so the injected marker script breaks nothing.                                    |
| The shell never pauses its socket                     | Reasoned, not watched | Covered by Jest on both seams (`__tests__/mac-lifecycle.test.ts`, `__tests__/chat-runtime.test.tsx`), each mocked shell-on and shell-off. Watching it means a signed-in session, a hidden window and a reply arriving into it, which is Task 5's bed. |

Window-only screenshot (`screencapture -l <windowid>`) of the app page in the shell: in the agent's
scratch directory, not the repository — see the handoff for this task.

### Task 2b — the ACL as the boundary, macOS (2026-09-22)

Bed: the same two-origin harness, extended. Two plain Node servers on `127.0.0.1:9121`
(configured) and `127.0.0.1:9122` (not configured) serve one page that reads
`window.__HERMIE_DESKTOP__`, invokes all six `hermie_*` commands, invokes three commands the grant
deliberately leaves out (`plugin:opener|open_url`, `plugin:fs|read_text_file`,
`plugin:window|set_title`), registers a `tauri://focus` listener, and POSTs every outcome back to
its own server. The configured page then navigates the window to `:9122`; the page there, after
reporting, fires all six commands again **without awaiting** and navigates the window straight back
to `:9121`, shipping whatever the promises settled to with `navigator.sendBeacon` on `pagehide` —
the race the old model lost. The shell ran as
`HERMIE_WEB_URL=http://127.0.0.1:9121 ./target/debug/hermie-desktop`.

| Check                                                | Result                | Notes                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All six commands from the configured origin          | Pass                  | Each resolved; `hermie_shell_info` answered `{ ok: true, version: '0.1.0', platform: 'macos', bridge: 1, gatewayId: 'dev', gatewayName: '127.0.0.1' }`.                                                                                                                           |
| `listen` from the configured origin                  | Pass                  | `plugin:event\|listen` for `tauri://focus` resolved with an unlisten function.                                                                                                                                                                                                    |
| All six commands from the unconfigured origin        | Pass                  | Every one **rejected** by the ACL, not answered: _"hermie\_\* not allowed on window "main", webview "main", URL: http://127.0.0.1:9122/ — allowed on: [windows: "main", URL: http://127.0.0.1:9121]"_. No command body runs at all, so none of the six can answer anything.       |
| `listen` from the unconfigured origin                | Pass                  | _"event.listen not allowed on window "main", webview "main", URL: http://127.0.0.1:9122/"_. This is what "receives no event" means: the page holds no listener, so neither the shell's four events nor Tauri's own window events can reach it. The Task 2 row said the opposite.  |
| The invoke-then-navigate race                        | Pass                  | Six calls fired from `:9122` and the window sent to `:9121` in the same task: all six rejected, each naming `:9122` as the URL. The ACL reads the calling frame, so there is nothing for the navigation to win.                                                                   |
| Commands outside the grant, from BOTH origins        | Pass                  | `plugin:opener\|open_url` and `plugin:window\|set_title` rejected ("not allowed. Permissions associated with this command: …") and `plugin:fs\|read_text_file` rejected ("Plugin not found") — the eight permissions are the whole surface.                                       |
| Marker in the shell                                  | Pass                  | `{ platform: 'macos', version: 1 }` on both origins, as designed: it is an announcement, not what gates anything.                                                                                                                                                                 |
| A release build ignores `HERMIE_WEB_URL`             | Pass                  | `cargo build --release` with `HERMIE_WEB_URL=http://127.0.0.1:9121` set: the window opened on the `connect.html` placeholder and **neither** server ever received a request. `GatewayList::from_env` is `#[cfg(debug_assertions)]`, so the release binary has no code to read it. |
| Windows sub-frames / WebView2                        | —                     | Not verifiable on macOS. The shape is covered by `cargo test` (`src/acl.rs`: a call whose frame URL is unconfigured is refused while the top frame is the configured gateway), and Task 9 re-runs it on a Windows 11 VM.                                                          |
| An event actually withheld from an unconfigured page | Reasoned, not watched | Nothing emits yet — the four events are Tasks 5 and 6. `should_emit` is unit-tested against a configured and an unconfigured top frame; this row gets watched in Task 5.                                                                                                          |

Two notes on the bed itself, so the next person does not re-derive them:

- The release binary above was built with plain `cargo build --release`, which leaves Tauri's `dev`
  cfg on, so it loads the shell's own pages from the Vite dev server rather than from embedded
  assets. That has no bearing on the `HERMIE_WEB_URL` row — `--release` is what turns
  `debug_assertions` off — but it does mean Vite has to be running for the placeholder to paint.
- `tauri-plugin-single-instance` is live, so a second shell launched while one is running just
  focuses the first and exits. Kill the running one before starting another.
