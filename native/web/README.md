# Hermie in the browser

`@hermie/web-client`: a browser client of the Hermes gateway, written in React, Vite and TypeScript, with no
Expo and no React Native Web. It is meant to be a pure client, exactly like the native apps, and to be
served by the gateway itself through the `hermie` plugin, on the gateway's own origin. The decision and
the threat model that follows from it are in
[ADR-0030](../../docs/adr/0030-the-web-client-is-served-by-the-gateway-plugin.md).

**Status: a chat you can read.** What exists is the build, its checks, the boot, the frame of the app and the chat
screen: the client refuses to run in a frame, finds its gateway from its own address, probes it, reads who is
signed in on the gateway's own session, connects, shows the chat list in a two-pane layout with a router and a
theme ("The shell" below), and opens a chat in the main pane and streams it ("The chat screen" below): bubbles
with Markdown, tool calls, notices, date separators, older history, jump to latest. You can send, stop a reply and
answer a bot's approval or question from it ("The composer" and "Requests" below), and confirm a sensitive action with
a passkey that the gateway verifies itself ("Passkeys" below), and answer a bot's secret, sudo and password-manager
prompts ("Secret prompts" below), and attach files and images by the picker, a paste or a drop ("Attachments" below). It has no settings beyond the passkeys page yet, and the plugin does not serve this build. Until that
changes, the browser keeps running the Expo app's web export through Hermie Web
([docs/web.md](../../docs/web.md)); nothing here replaces it.

## Running it

```sh
npm run fake-gateway -- --auth cookie     # a stand-in gateway on 127.0.0.1:9119
npm run client:dev                        # Vite on http://localhost:5173
```

Open `http://localhost:5173/dashboard-plugins/hermie/app/index.html`. The dev server answers at the path a
gateway serves the client at, so the code that derives its base path from the URL sees what it will see in
production, and it forwards `/api`, `/auth` and `/login` (WebSocket included) to the gateway named by
`HERMIE_DEV_GATEWAY` (default `http://127.0.0.1:9119`).

The development document relaxes its Content-Security-Policy so the dev server can work (inline scripts and
styles, `ws:`, no Trusted Types). The production build never does; test against `dist/` to see the real policy.

| Command                             | What it does                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run client:dev`                | the Vite dev server (above)                                                                                      |
| `npm run client:build`              | `vite build`, then writes `dist/build.json`                                                                      |
| `npm run client:test`               | the client's unit and component tests (vitest, jsdom, Testing Library; `scripts/run-vitest.mjs`, below)          |
| `npm run client:check-bundle`       | the gate on `dist/` (below); `-- --commit <sha>` also requires `build.json` to name that commit                  |
| `npm run client:check-reproducible` | builds twice from clean and compares every file; `-- --fresh-checkout` adds a build from `git archive HEAD`      |
| `npm run client:guard-scan`         | the Hermes plugin scanner over `dist/`, fork and upstream at pinned commits (below)                              |
| `npm run client:e2e`                | the black-box and accessibility suite on the built client, in Chromium, WebKit and Firefox ("The browser suite") |
| `npm run client:e2e:perf`           | the transcript list's performance suite on the harness, in the same three engines ("The harness and the suite")  |

**Node 25 and later.** Node ships its own Web Storage there, and its `localStorage` and `sessionStorage` globals
shadow jsdom's, so the suite needs `NODE_OPTIONS=--no-webstorage`. `npm run client:test` goes through
`scripts/run-vitest.mjs`, which adds the flag when the Node it runs on accepts it (it asks Node by starting it with
the flag, not by reading a version number) and changes nothing on Node 22, which refuses the flag and would not
start. Calling `vitest` directly on Node 25 needs the flag by hand.

Types, lint and format run with the rest of the repository (`npm run typecheck`, `npm run lint`,
`npm run format`); `client:test`, the bundle gate, the plugin scanner, the reproducibility check and the
performance suite (Chromium only) also run in CI as the `web-client` job, and the browser suite runs in all three
engines as the `web-client-e2e` jobs.

## The build

`dist/` is what the plugin will carry under `dashboard/app/`, served by the dashboard's static route:
`GET <gateway>/dashboard-plugins/hermie/app/index.html`. That route serves any file with an allowed
extension, answers `Cache-Control: no-store`, sets no other header, has no single-page fallback and does not
compress. The build is shaped around that:

- **Relative URLs** (`base: './'`), hashed names under `assets/`, so the gateway may sit behind a path prefix.
- **Only extensions the route serves** (`.js .mjs .css .json .html .svg .png .jpg .jpeg .gif .webp .ico .woff2
.woff .ttf .otf`). No `.webmanifest`, `.wasm`, `.txt` or `.map`.
- **No source maps in the bundle.** They are written next to it, to `dist-maps/`, and uploaded as a CI
  artefact.
- **ASCII only.** The plugin scanner flags invisible Unicode, so the build escapes non-ASCII text instead of
  leaving it for the scanner to judge. esbuild's `charset` option does not reach a regular expression
  literal, so a small plugin in `vite.config.ts` writes whatever non-ASCII is left in the chunks as `\uXXXX`
  (the shared Markdown package has such a literal: a pair of curly quotes in a character class). It fails the
  build instead where the escape would not mean the same: after an odd run of backslashes (the character is
  already escaped) and inside a tagged template (the tag reads the raw text). A pattern's `.source` shows the
  escape, not the character; nothing here reads it. The transform is `scripts/ascii-only.mjs`.
- **No `!` followed by a backtick in a string or a pattern.** The scanner's `inline_shell_exec` pattern (an inline
  shell snippet of a Hermes skill) reads two of the Markdown code's regular expressions, which say "not followed
  by a backtick", as a command: a HIGH finding and a `caution` verdict for an import. A second plugin in
  `vite.config.ts` writes the backtick as `\x60` inside string and pattern literals (the same character, found
  with the parser, so a template that follows a `!` is not touched).
- **Nothing inlined as a `data:` URI**; the document's policy allows `data:` for images only.
- **The policy travels with the document** (`index.html`): the route sets no security headers. No inline
  script, no inline style, nothing but this origin, Trusted Types required and no Trusted Types policy allowed. `frame-ancestors` cannot be set
  from a meta element, so refusing to render in a frame is the entry module's job (see "Boot").

### `build.json`

Written by `scripts/write-build-manifest.mjs` after the build, into `dist/` beside the files it describes:

```json
{
  "files": { "index.html": { "bytes": 1243, "sha256": "..." } },
  "name": "hermie-web-client",
  "sourceCommit": "<40 hex digits>",
  "sourceRepo": "fullstackstudio-org/hermie",
  "totalBytes": 187556,
  "v": 1,
  "version": "0.2.0"
}
```

Keys are sorted, the indent is two spaces, there is a trailing newline and no timestamp. It does not list
itself. The commit comes from `git rev-parse HEAD`, or from `HERMIE_SOURCE_COMMIT` when the build runs where
there is no checkout. A build made from a tree with uncommitted changes names a commit its files were not
built from; the script warns, and such a build must not be imported.

### The bundle gate

`npm run client:check-bundle` (`scripts/web/check-bundle.mjs`) exits non-zero, listing every problem, when:

- a file has an extension the static route does not serve, or is a source map or a symbolic link;
- a file is over 900 kB, the bundle is over 3 MB, or it holds more than 80 files (decimal units);
- a `.js`, `.mjs`, `.css`, `.html`, `.json` or `.svg` file contains a non-ASCII byte;
- the JavaScript needed before the first screen (the entry and every chunk it imports statically; a dynamic
  `import()` does not count) is over 700 kB, or 230 kB gzipped;
- `index.html` has no policy, a policy that is not exactly the reference set written in the gate (every directive
  and source of the plan's W6, plus `trusted-types 'none'`; one missing or extra fails), a `<script>` or `<link>`
  before the policy element, or inline script, a style element, a `style` attribute or an inline handler;
- `build.json` is missing, malformed, not in canonical form, or does not match the files: a changed byte, a
  missing file or an unlisted file;
- a text file holds `hermie:development-only`, the stamp every development-only page (`src/dev`) puts on its
  own document: one of them was imported by the client.

It prints what it measured against each limit.

### What the first load carries

The limit is not to be raised to make room: what the first screen (signing in, the chat list, an open chat) does not
draw is kept out of the entry instead. Three things do that today.

- **Only the strings the client reads.** `src/generated/locales/<tag>.json` holds every string of the Expo app, and
  the client reads a small part of them. The build bundles only that part (`catalogueOnlyWhatIsRead` in
  `vite.config.ts`, the rule in `scripts/catalogue-reads.mjs`, its tests in `scripts/web/catalogue-reads.test.ts`):
  every read of `strings` under `src` is followed through its static property accesses, and the key or subtree it
  reaches is kept. The rule only errs towards keeping: a read it cannot follow (the tree handed on, destructured,
  read with a computed key at the root, re-exported, imported dynamically) keeps the whole catalogue, which the gate
  would then show. The unit tests and the dev server read the files whole.
- **The request sheets are a chunk of their own** (`features/requests/sheets.ts`, every sheet including the passkey
  confirmation's). `React.lazy` would suspend on each sheet's first render even with the chunk in memory, so
  `request-sheets.ts` holds the module once it has loaded and the layer draws from it in the same pass. The entry
  module fetches it right after the session starts, long before a bot can ask anything; a request that arrives first
  is a dialog with nothing in it until the chunk is there, and a failed fetch is asked for again every few seconds
  while there is a request to show.
- **The sheets' own words** (`src/i18n/sheet-strings.ts`, the same table as `web-strings.ts`) travel with them. Only
  a module that is itself loaded on demand may import that file.

To see what a chunk is made of, build and read the hidden source maps in `dist-maps/`.

### The plugin scanner

`npm run client:guard-scan` (`scripts/web/guard-scan.mjs`) runs Hermes's own plugin scanner over `dist/`, the way
the plugin repository's `guard-scan` job runs it over the tree the build is imported into (plan W3), so a finding
shows up here and not in a pull request of another repository after the import. The rules it holds to:

- it fetches `tools/` of the fork the gateways run and of upstream, each at the 40-character commit pinned in
  `scripts/web/scanner-pins.json` (the same two commits as the plugin's `.github/scanner-pins.json`; move them
  together). A branch or a tag cannot stand in for a pin, and a server that answers with another commit is an error;
- it lays `dist/` under `dashboard/app/` of a synthetic plugin tree beside a minimal `plugin.yaml`, so the scanner
  sees the paths it sees on an install, and calls `scan_plugin` and `should_allow_plugin_install` in a fresh
  `python -I -B` child per scanner (the two define the same package name; `guard-scan-run.py` refuses a `tools`
  that did not come from the checkout);
- it passes only on a verdict of `safe` that the install would allow outright (`caution` fails), for both
  scanners; there is no threshold of its own;
- a gate that cannot run does not pass: a scanner that cannot be fetched or imported, one that prints no result,
  a directory that is not a build (no `index.html` or `build.json`, almost no files) and a configuration with no
  scanner all fail; a report line that could start a workflow command is made harmless before it reaches the log.

The scanner needs Python 3.10 or newer (`GUARD_SCAN_PYTHON` names the interpreter; the runner's `python3` is
3.12) and the network. `scripts/web/guard-scan.test.ts` tests the gate against a stand-in scanner (every verdict, a
scanner that crashes or says nothing, the pins, the fetch from a local repository, what reaches the log), and with
`GUARD_SCAN_REAL=1` against the real ones: the real build passes, and a build with a planted prompt-injection
sentence does not. CI runs it that way after the gate itself.

### Reproducibility

The plugin's CI will check out the commit named in `build.json`, rebuild it somewhere else and compare
every byte, so the same commit has to give the same bytes on any machine. `npm run client:check-reproducible`
is the proof that it does, and CI runs it with `--fresh-checkout`:

1. two clean builds of the working tree, into empty directories, under different time zones and locales;
2. one more build from `git archive HEAD`, unpacked into another directory with its own `npm ci`.

Every file must be identical, not only `build.json`. Why it holds: Rollup's file hashes are of the content,
the output holds no timestamps and no absolute paths, the commit and version are the only injected values, and
`npm ci` installs the versions the lockfile pins (the build dependencies in `package.json` are pinned exactly
as well). The same sources also built to the same `build.json` under Node 22 (the version CI pins) and under
Node 26.

If a change makes the build non-reproducible, the check names the files that differ; a new Vite plugin or an
environment variable read at build time is the usual cause.

## Boot

`src/main.tsx` runs, in this order:

1. **Frame guard** (`boot/frame-guard.ts`). In a frame the body is replaced by one sentence, in the browser's
   language, and nothing else runs: no locale chunk, no storage, no request, no React.
2. **Language** (`initLocale`), so every screen after this is in the reader's language from its first frame.
3. **Base path** (`boot/base-path.ts`). The page must be at `<prefix>/dashboard-plugins/hermie/app/index.html`
   (or that directory, for an alias); the gateway is the origin plus the prefix. Anywhere else is an error
   screen that names the expected path. A route stashed before a sign-in is put back once.
4. **Probe** (`boot/auth-mode.ts`): `GET /api/status`. `auth_required: false` is a session-token gateway,
   which the client does not handle yet; it says so and stops.
5. **Identity**: `GET /api/auth/me` on the gateway's `HttpOnly` cookie session, sent `same-origin` and never
   anywhere else. A 401 is "Sign in again", which stashes the route and goes to
   `<prefix>/login?next=<this page>`; a 403 is not (the gateway says 401 for a lapsed session, so a 403 is a proxy
   or firewall in front of it, and a sign-in would reload into the same 403): it and any other failure say what
   failed, with "Try again".
6. **Signed in**: if the stored state was written for somebody else, it is cleared first
   (`claimForOwner`). Sign-out is `POST /auth/logout`, then the transcript cache and every identity-bound
   setting are cleared, then `/login`.

`boot/boot.ts` is that sequence as one function with a typed outcome (`unreachable`, `token_mode`,
`needs_signin`, `signed_in`); `main.tsx` only renders it. `boot/boot.integration.test.ts` runs it against the
fake gateway in cookie mode.

### Browser storage

Nothing in it is a credential: the session is the gateway's `HttpOnly` cookie, which the client cannot read.

| Where                                               | Key or name                                        | What                                                                  | On sign-out |
| --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | ----------- |
| `localStorage` (`platform/key-value-store.ts`)      | `hermie:<base path>:device.*`                      | device settings (scheme, tint, text size, installation id)            | kept        |
| `localStorage`                                      | `hermie:<base path>:<anything else>`               | identity-bound state (watermarks, layout, the owner's author id)      | cleared     |
| `localStorage`                                      | `hermie:<base path>:draft.<chat>`                  | what was typed in a chat and not sent                                 | cleared     |
| `localStorage`                                      | `hermie:<base path>:device.passkey.pin@<base URL>` | the gateway id pinned on the first passkey enrolment ("Passkeys")     | kept        |
| `localStorage`                                      | `hermie:<base path>:passkey.seen@<base URL>`       | the signed-in person's passkey ids this browser has seen              | cleared     |
| IndexedDB `hermie-cache` (`platform/chat-cache.ts`) | rows keyed `<base path>:<bot>`                     | transcript snapshots and the roster, in the Expo cache's record shape | cleared     |
| `sessionStorage`                                    | `hermie:<base path>:route`                         | the route, across one sign-in                                         | cleared     |

`<base path>` is the prefix, or `/` at the root, so two gateways behind different prefixes on one host keep
apart. A key is identity-bound unless it starts with `device.`, so a key nobody classified is cleared rather
than left for the next person. The language choice is one of them: `device.language`, read and written through
`platform/locale-environment.ts` (an earlier build's bare `hermie.language` key is taken over once; docs/i18n.md). A browser that refuses a store gets a page that works and forgets:
values are kept in memory, and the cache falls back to memory on its first failure.

### Seams

Nothing outside `src/platform/` and `src/boot/` touches `window`, `localStorage`, `sessionStorage`,
`indexedDB`, `navigator`, `location` or `history` (lint; the development-only pages in `src/dev`, which never
reach the bundle, are exempt). Each seam takes its browser object as an argument, so the tests hand in their
own:

| Seam                                                  | What                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `platform/key-value-store.ts`                         | `createKeyValueStore({ namespace })`: the Expo store's contract, namespaced  |
| `platform/chat-cache.ts`                              | `chatCacheFor(namespace)`: IndexedDB, falling back to memory                 |
| `platform/net-info.ts`                                | `networkWatcher`: `online` / `offline`                                       |
| `platform/visibility.ts`                              | `visibilityWatcher`: `visibilitychange`, `pagehide`, `pageshow`              |
| `platform/socket.ts`                                  | `createSocketFactory()`: the page's `WebSocket` for `GatewayConnection`      |
| `platform/layout.ts`                                  | `layoutClock`: `requestAnimationFrame` and `ResizeObserver` for the lists    |
| `platform/clipboard.ts`, `page-title.ts`, `random.ts` | copy, the tab's title, `crypto.getRandomValues`                              |
| `platform/webauthn.ts`                                | `navigator.credentials.create/get` and `crypto.subtle` for the passkey level |
| `platform/passkey-pins.ts`                            | the passkey pins (above), and other gateways' pins on this origin            |
| `platform/files.ts`                                   | a file's bytes as base64, the files of a drag, the stray-drop guard          |

## Connection

`src/core/` and `src/state/` hold the session layer, ported from the Expo app by copy (plan W7): same names,
same store shapes, and every deliberate difference noted at the top of the file it is in. None of it imports
React; screens will read the stores through `useStore`.

| File                                          | What                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `core/gateway-client.ts`                      | the connection on the cookie session, its lifecycle, and `connectGateway` (below)         |
| `core/bots-controller.ts`                     | the roster's round trips: `profiles.list`, avatars, running state, the canonical Bot Chat |
| `core/link.ts`                                | `ChatGateway`, the slice of the connection the chat layer sees                            |
| `core/advert.ts`                              | the plugin advert plus the web-only `web`, `webPush.publicKey` and `modules.web`          |
| `core/rpc-failures.ts`                        | the ring of gateway refusals a screen absorbed                                            |
| `state/connection.ts`, `bots.ts`, `plugin.ts` | zustand vanilla stores: status, roster and watermarks, advert                             |

`connectGateway({ baseUrl, credentials, storage, cache })` takes the boot's `signed_in` session and keeps one
`GatewayConnection` alive: it dials when the page is first visible, closes the socket after the page has been
hidden for more than 60 seconds, and on return dials again with a fresh ticket, which replays every session it
holds a watermark for. Network reports are advice: offline labels the status and takes a live socket down,
online cuts the backoff short, and neither stops the dial ladder (the gateway may be on the same machine). A
connection that stopped because the session lapsed (`needs_signin`) is left alone. The roster is painted from
the cache, read again on every arrival at `ready`, and the plugin advert is taken off the same answer. `stop()`
closes the socket and empties the stores; call it before signing out. The rules in full are at the top of
`core/gateway-client.ts`; `core/gateway-client.integration.test.ts` runs them against the fake gateway in
cookie mode, dropped sockets included.

## Chats

The transcript life cycle (resume, history and paging, reconcile, replay, foreign turns, send, queue, steer,
interrupt, approval and clarify answers, conversations) is the Expo app's chat controller, ported whole and
running on `@hermie/transcript` unchanged.

| File                      | What                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `core/chat-controller.ts` | `ChatController`, and `connectChats`, which runs it on the page's connection (below) |
| `core/ingest.ts`          | the one road into the chat store: wire order, one commit per frame                   |
| `core/sessions/`          | conversation model and list: canonical chat, branches, the reader's own chats        |
| `core/chats/`             | uploads, the turn claim, the own author, the read watermark, regenerate, bound chat  |
| `state/chats.ts`          | zustand vanilla store: every open chat, the queues, runtime id to bot, the live set  |

`connectChats({ client, cache, author })` takes the `GatewayClient` and the boot's `signed_in.author`, starts
the controller, and follows the page: shown, the approval and subagent polls resume; hidden, they stop, what
arrived is committed and every live chat is written to the cache. `stop()` empties the chat store; call it
before `GatewayClient.stop`. The Expo app's share outbox and Shortcuts queue have no counterpart here; their
call sites are `ChatRuntimeHooks`, which does nothing by default.

The ingest, as rules (in full at the top of `core/ingest.ts`):

- Gateway events join one queue in arrival order and are applied to the engine at the next animation frame.
  A server request joins the same queue and is applied at once, behind every event that arrived before it,
  because the channel needs its answer synchronously.
- The store's actions are routed through the ingest, and the controller reads and writes a working copy:
  every read or write drains the queue first, so an RPC answer the controller applies after an `await` lands
  behind every event that arrived before the answer, and the controller reads exactly what the Expo store
  would have handed it.
- Applying is not committing: the working copy reaches the store in one `setState` per frame, and a screen
  subscribed to the store sees one change per frame however many events it carried. While the page is hidden
  the frame is a 100 ms timer, because `requestAnimationFrame` does not run there.
- A drain is a synchronous loop and never spans an `await`; a handler that throws costs its own arrival only.

`core/chat-controller.integration.test.ts` runs it against the fake gateway in cookie mode: a chat with 1000
rows of back-history opened on the REST tail and paged back to its first row, a scripted turn, a send, an
interrupt, an approval and a clarify raised through `/__fake/request`, and a socket dropped mid-turn with no
duplicate and no lost item. The ported Expo tests run the controller on `immediateFrames`, which commits every
write at once as the Expo store did; the batching itself is `core/ingest.test.ts`'s.

## The shell

`src/features/` is what a person sees. `main.tsx` boots, starts the session once (`features/shell/session.ts`:
the connection, the chats on it and the roster's running poll, stopped in the order a sign-out needs) and
renders `<App>`; nothing under `features/` starts a connection or fetches, it reads the stores.

### Routes

One URL and the route in the fragment (plan W4; `features/shell/router.ts`, over `platform/hash-router.ts`, the
only code outside `boot/` that touches `location.hash`):

| Route                      | Heading        | Main pane today                         |
| -------------------------- | -------------- | --------------------------------------- |
| `#/`                       | Hermie         | "Pick a conversation to start..."       |
| `#/chat/<bot>`             | the bot's name | the chat (`ChatScreen`)                 |
| `#/chat/<bot>/s/<session>` | the bot's name | that conversation (`ChatScreen`)        |
| `#/settings`               | Settings       | placeholder (W-20b), a link to Passkeys |
| `#/settings/passkeys`      | Settings       | this gateway's passkeys ("Passkeys")    |
| `#/settings/<section>`     | Settings       | placeholder (W-20b)                     |
| anything else              | sent to `#/`   |                                         |

A bot name or session id is one percent-encoded segment; `parseRoute` and `formatRoute` are inverses. An unknown
route is rewritten to `#/` in place (no history entry). A route change moves focus to the main heading (not on
the first load); where the main pane is not shown (one pane, list route) the sidebar's heading takes it.

### Layout

Two panes from 900 px (the chat list, 340 px, beside the main pane), one pane below it: the list on `#/`, the main
pane with a back link on every other route. That is the stylesheet's doing (`data-pane` on the frame and a media
query), not a script's, so no frame is drawn in the wrong layout and a hidden pane is out of the tab order. The
landmarks are one `nav` (the chat list), one `main` and a `footer`; the first Tab stop is a skip link. At 320 px
the page is one column and does not scroll sideways.

The connection line sits above both panes and is silent while connected (and while the page is hidden):
connecting, reconnecting and offline are polite status text; signed out (with a "Sign in" button for the
gateway's own page) and a gateway too old for the client are alerts. A gateway with no Hermie plugin works and
gets a hint under the list that notifications need it; an operator's `modules.web: off` replaces the app with
one sentence.

### The chat list

`features/bots/`: a link per bot (`#/chat/<bot>`), in the roster's order, with the bot's picture (the data URL
the roster read) or its initial, its name, the last real message of the chat (or the gateway's preview, or the
description), the time of the last activity, an unread marker and a presence bead. The rules are the native
apps': presence is one of four states by one precedence (`presence.ts`: offline, needs input, working, online),
offline shows when the bot was last heard from instead of a stale line, unread is the roster's `last_active`
against the per-bot watermark or the count of transcript messages past it, and a preview is
`chatRowPreview` of `@hermie/transcript` with the markdown taken off. The list is one tab stop; the arrow keys,
Home and End move between rows and Enter follows the link. A row subscribes to the stores with primitive
selectors, so a streamed token re-renders its own row only.

A chat is marked read by the chat screen, not by the list (`botsStore.markSeen`; "The chat screen" below).

### The theme

`ui/theme.css` holds every colour, size and motion as custom properties (the danger ink, `--hm-danger-text`, is held to 4.5:1
like the others): light, dark or follow the browser
(`prefers-color-scheme`), plus one tint of nine. The choice is two attributes on `<html>` (`data-scheme`,
`data-tint`; `platform/theme-target.ts`, because the policy forbids inline styles), stored per base path under
`device.scheme` and `device.tint` (`state/settings.ts`, so a sign-out keeps them) and applied before the first
screen. No screen changes them yet: Settings (W-20b) will. The focus ring is the tint's ink; reduced motion is
honoured (the one animation, a bot asking for the reader, becomes a static ring); increased contrast
strengthens the lines. `ui/theme.contrast.test.ts` reads the stylesheet, resolves the properties for every
scheme and tint, and holds every text pair to 4.5:1 and every state shape to 3:1.

Accessibility is tested in jsdom with axe (`features/shell/shell.axe.test.tsx`: both schemes, every language,
every connection state, three routes); jsdom has no layout, so contrast is the test above and the one-pane
layout is checked in a browser against the fake gateway: build, put `dist/` at `<dir>/app/` and run
`npm run fake-gateway -- --auth cookie --plugin-assets <dir>`.

## The chat screen

`features/chat/` is the main pane of `#/chat/<bot>` and `#/chat/<bot>/s/<session>`. `App` hands it the page's
controller and the gateway's base URL through `ChatRuntimeContext` (the entry module is the only place that has
both) and gives it a key per route, so moving to another chat starts a screen of its own. The screen opens its
own chat: nothing in `App` does.

| File                 | What                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ChatScreen.tsx`     | the wiring: rows, scroll position, older history, read marking, announcements, the states of a chat                         |
| `use-open-chat.ts`   | opens the route's chat when the connection is `ready`, leaves it on the way out, retries after a failure                    |
| `ChatHeader.tsx`     | the line under the bot's name: its presence bead and what it is doing (the chat list's own rules)                           |
| `rows.ts`            | from `visibleItems` to the list's rows: date separators, the status line while busy, the typing row, the tool being written |
| `items/TodoList.tsx` | the bot's task list (`todo.updated`), a strip over the composer, folded to one line by default                              |
| `JumpToLatest.tsx`   | the button over the bottom of the transcript, with how many messages arrived while the reader was above                     |
| `items/*.tsx`        | one view per item kind (below), each `React.memo` on `(id, version, presentation)`                                          |
| `chat.css`           | the screen and its views, on the theme's tokens                                                                             |

**Opening.** `openChat(bot, { follow: true })` once the connection is `ready` (a call on a socket that is still
dialling rejects, so the open waits for the transition to ready, which also covers every reconnect). With a
session in the route, `openSession` says where it belongs: one of the reader's own chats or the group chat becomes
the bot's current conversation and is held under the bot's name like any other; a branch or a past conversation
opens read-only (`openConversation`, under `bot#<session>`), with a line saying so, and marks nothing read. A
failure to open is shown with "Try again". A bot the roster does not list says so. Leaving the screen calls
`closeChat` (cache write, read mark) and does not detach, and never for a chat that did not open.

**Who scrolls.** The transcript, and only the transcript: on a chat route `Layout` puts `data-screen="chat"` on
the `main`, and `chat.css` turns its `overflow` off and moves the gutters inside. `TranscriptList` measures its
rows against its own scrollport, so a second scrolling ancestor would move the rows under its anchoring without
it being told. Everything above the transcript (heading, header, notes) keeps its place; everything over it
("Loading earlier...", "Jump to latest") is absolutely positioned in the stage and is never a row, because a row
added or taken away at the top would move the anchor.

**What is shown.** `visibleItems(chat, view)`, memoised on `(itemsVersion, turn.active, view)`. `turn.active` is in
the key because the status line depends on it and ending a turn changes no item. Until the reader can change it
(the verbosity, bot-to-bot and thinking toggles are W-18b's) the view is `DEFAULT_CHAT_VIEW`: level `normal` (tool
calls as one collapsed line each), bot-to-bot shown, no reasoning. The Expo app's default is `quiet`; at `quiet`
the selectors drop the tool rows this screen is meant to show.

| Item                         | View                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                       | a bubble on the right in the tint, Markdown, clock, "Sending..." until the gateway has it; somebody else's in the group chat is on the left with their name                                                                                                                                                                                                                                                            |
| `assistant`                  | a bubble with Markdown; its thought, when thinking is shown, as one closed "Thought for 4s" line above it (`ReasoningDisclosure`); the typing dots in the same bubble until words arrive; usage and duration footer; a failure card under the words that arrived (`ErrorCard`: "Reconnecting..." when the gateway holds the turn, Retry only when the screen has something to retry with); interim and reply-to labels |
| `tool`                       | one collapsed line (`ToolCard`: family glyph, name, what it did, how long or "Running..."); a click opens the untrusted-output warning, arguments, a patch's diff and the result as plain text; silent tools (`todo`) draw nothing until they fail                                                                                                                                                                     |
| `bot_dm_in` / `bot_dm_out`   | an aside on the left, never a bubble (`BotDmAside`): one closed line (direction, `To @writer` / `From @writer`, a preview, the time, and on a dispatch the reply marker: waiting, replied or failed) that opens to the message as Markdown, how the dispatch went, the reply, and a link to the teammate's chat when this gateway has that bot; a chip when bot-to-bot is hidden                                       |
| a run of more than three DMs | one line, `5 messages with @writer · 4 replies`, that opens in place to the asides (`BotDmRollup`; the run is found by `dm-rollup.ts` before the date separators)                                                                                                                                                                                                                                                      |
| `cron_delivery`              | a card, never the owner's bubble (`CronDeliveryCard`): CRON, the job's name (or "Scheduled job" when it was redacted) and when it ran, open with the report as Markdown at `normal` and `verbose`, folded at `quiet`                                                                                                                                                                                                   |
| `subagent_group`             | a card of the fan-out's goals with each child's status as a glyph and a word (`SubagentGroupCard`; the children are read from the chat store), one line per goal when collapsed, the summary when it landed; a chip at `quiet` or with bot-to-bot hidden                                                                                                                                                               |
| `notice`, `status`           | centred, quiet lines, never a bubble; a model or personality switch, an auto-continue and a `[System: ...]` note are one sentence (`SystemLine`); any other notice with a body is a disclosure (a command's answer opens itself, an error keeps the danger tint); the latest status only while busy                                                                                                                    |
| date separator               | an `h2` row at the first row of each day (a row of its own, keyed by the day and the row it opens)                                                                                                                                                                                                                                                                                                                     |
| typing row                   | the dots, while the turn runs and the last thing drawn is the reader's own message                                                                                                                                                                                                                                                                                                                                     |
| tool being written           | "Preparing <tool>…" at the tail, in the typing row's place, from `tool.generating` until the call starts (`ToolGenerating`); the name cleaned, bounded and in a `<bdi>`                                                                                                                                                                                                                                                |
| `approval`, `clarify`        | the record of the request, a plain line saying what was asked (`OtherRow`); the request itself is answered in the request layer                                                                                                                                                                                                                                                                                        |

Every name and one-line text an agent or the gateway wrote (a handle, a job name, a tool summary, an error) is
cleaned and bounded by `displayText` and isolated in `<bdi>` (`WithName` for a sentence with a name in it); bodies
go through the Markdown renderer, which makes no HTML. `npm run client:dev`, then `/dev/items.html`, shows every
item kind in every presentation (`src/dev/item-gallery.tsx`, development only, checked by axe in
`item-gallery.axe.test.tsx`).

**The task list** is not a row: each `todo.updated` snapshot (or one a tool result or a resume carries) replaces the
last in `ChatState.todo`, so it is a strip over the composer (`TodoList`): folded, how far it is and the task in
progress; open, every task with its mark (said in words to a screen reader) and a subtask indented under its parent.
A list that is all done goes once the turn is over. A task's words are cleaned and bounded (`displayText`) and never
Markdown; a task in an undocumented shape is read as far as it can be (an unknown status is "to do").

Gateway-injected rows are notices, never the reader's own bubble. Everything the gateway or an agent wrote that is
not Markdown (tool arguments, results, notice bodies, a thought) is shown as characters.

**Headings in a message.** The page's `h1` is the bot's name and a day is an `h2`, so a message's headings are
drawn as `h3` (`Markdown`'s `headingOffset` 2 and `headingMax` 3), whatever the author wrote: a `#` is never a
second title, and a `##` written first never skips a level. The size still follows the depth that was written.

**Read marking** is the native apps' rule (`core/chats/read-watermark.ts`): a message is read when it arrives in
front of the reader, which is when the chat is open, live, the page is visible and the transcript is at the
bottom. Scrolled up, the badge is doing its job (it is the same messages "Jump to latest" counts); coming back to
the bottom reads what arrived meanwhile. It writes `markSeen(controller.readKeyFor(bot), max(now, lastMessageAt))`,
under the key of the conversation the bot is on, so reading one of the reader's own chats never marks the group
chat read. Opening and leaving mark as well, in the controller.

**Older history.** When the reader is within 0.4 of a viewport of the top, `controller.loadOlder(key)` (once per
oldest row, and not before the chat is live: a short chat is "at the top" at once). The page goes in at the front
through `prependHistory`, and the list keeps the row the reader is on.

**Said aloud.** The transcript is `role="log"` and `aria-busy` while a turn runs, so a screen reader is not read
every delta. A separate polite `role="status"` region says once, when the turn ends, "<name> replied: <the first
200 characters, Markdown taken off>". Nothing is said for a chat that is opened or was already finished.

**Tests.** Component tests drive the screen with the recorded stream scenarios (`contract/transcript/streams`):
each is replayed through the engine, the state after every step is committed to the store, and the rows on the
page are compared with what the selectors say at each recorded checkpoint. The item views have their own tests;
`chat.axe.test.tsx` runs axe in jsdom (both schemes, three languages, a conversation of every kind).
`e2e/chat.spec.ts` runs the **built** client in a browser against the fake gateway (a gateway of its own per test,
with `historyRows: 2000` for the long-history group, behind its dashboard route and cookie login; the client is built
into a temporary directory once per worker, so it is never a stale `dist/`; "The browser suite" below). The long
history's checks:

| Check                                                                                                                               | Result                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| open the chat: gap below the newest row in every frame from the first with rows; the bottom row never changes; again from the cache | 0 px; one bottom row   |
| a 40-paragraph reply streamed in by the gateway: gap in every frame, the newest row followed                                        | 0 px                   |
| scrolled up while a reply and a whole turn arrive: the row being read does not move; "Jump to latest" with a count; pressing it     | 0 px; focus on the log |
| reaching the top asks for older history and keeps the reader's place                                                                | grew; still reading    |

A short reply streamed in from the gateway is a separate test: `aria-busy` while it runs, one announcement when it
is whole. Axe, with contrast, is `e2e/a11y.spec.ts`.

```sh
npm run e2e:chromium --workspace @hermie/web-client -- chat.spec.ts   # the chat screen's suite alone
```

## The composer

`features/chat/Composer.tsx`, under the transcript in `ChatScreen` (hidden on a past conversation, which can be read
and not answered). The rules are the native apps' (`expo/hermie/src/chat-ui/Composer.tsx` and the chat screen's send);
everything that talks to the gateway is a controller method, reached through `ChatRuntimeContext`.

| File              | What                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `Composer.tsx`    | the field, Send, Stop, the completions, the draft; sends through `controller.send` and `runSlash`      |
| `QueuedStrip.tsx` | the messages parked behind a running reply, as chips with Steer, Edit and Delete                       |
| `send-key.ts`     | what a Return means: `decideKey`, the table of `expo/hermie/src/chat-ui/send-key.ts` plus the IME rule |
| `drafts.ts`       | `DraftStore` over the key-value store: one draft per chat, per base path                               |
| `composer.css`    | the composer, the completions, the queue and the attachment chips, on the theme's tokens               |

- **Return** sends, **Shift+Return** breaks the line, **Command or Control+Return** sends from anywhere. The Return that
  confirms an input method's candidate (`isComposing`, or the legacy key code 229) never sends. On a device with no
  mouse or trackpad (`platform/input-kind.ts`: `(any-pointer: fine)`) a bare Return breaks the line and the Send
  button sends, as on a phone in the native apps; the key hint is shown only where Return sends.
- **The field grows** with what is typed up to 40 % of the window, then scrolls. The height is set through the CSSOM,
  which the document's policy allows (it forbids a `style` attribute in markup, not `element.style`).
- **Draft.** Kept per chat in the key-value store under `draft.<chat>` (identity-bound, so a sign-out clears it), written
  300 ms after the last key and at once on leaving the screen or hiding the tab. A send empties it; a send that is
  refused puts the words back (ahead of anything typed meanwhile) with the reason under the field.
- **Not connected.** The field stays live (a reconnect is a good moment to write the next message); Send is off until the
  connection is `ready` and the chat has a session on the gateway. Stop is never switched off.
- **Slash commands.** A line that begins with a slash runs as a command only if `slashRouteFor` (the gateway's catalogue)
  knows the name, through `runSlash`; a `prefill` answer goes into the field. Anything else is a prompt. While the line is
  `/...` the gateway is asked what could follow (`querySlash`); only the newest answer paints. The list is a
  `listbox` the field names with `aria-controls` and `aria-activedescendant`: Up and Down move, Tab or Return take the
  item (instead of sending), Escape closes it until the reader types again.
- **Queue.** While a reply runs, a send is parked by the controller and drawn as a chip: **Steer** hands it to the running
  reply (a refusal says "too late", and the controller has already put it back), **Edit** puts it in the field ahead of
  what is there (not offered for a message with an attachment), **Delete**. Three chips are drawn, the rest are a count.
- **Stop** appears while a reply runs: `controller.stopTurn`, which sends the interrupt and marks the chat interrupted
  whatever the gateway answers, so the field is free again.
- **Turn claim.** `controller.send` claims the turn before a model turn when the advert has `context.turn_claim`; nothing
  here repeats it, and a slash command never reaches it.
- **Pinned.** A send (or a command) calls `jumpToLatest()` before the round trip, so the reader's own bubble lands where
  they are looking.
- **Attachments**: see below.

### Attachments

A file or an image goes with the next message from three ways in, which all end in the chat's attachment tray:

| File                        | What                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `core/chats/attachments.ts` | `AttachmentTray`: which road a file takes, the chips' states, `take` / `restore` for a send  |
| `core/chats/file-upload.ts` | the upload into the session's workspace (`POST /api/files/upload-stream`), now with `signal` |
| `use-attachment-tray.ts`    | one tray per chat key, made by `ChatScreen`, uploading through `controller.uploadFile`       |
| `AttachMenu.tsx`            | the attach button and the browser's file dialog (`<input type="file" multiple>`, no form)    |
| `paste.ts`                  | which pastes attach files and which are text                                                 |
| `DropZone.tsx`              | the whole chat as a drop target: a visible, announced target while files are over it         |
| `AttachmentChips.tsx`       | the chips over the field: name, thumbnail or glyph, state, Cancel / Try again / Remove       |

- **Two roads.** An image in a format the gateway takes as one (PNG, JPEG, GIF, WebP, BMP, TIFF; by its extension, or
  a nameless paste by its type) is read as base64 when it is staged and goes over the socket with the message
  (`image.attach_bytes`, 25 MiB). Anything else, an SVG, an icon and a HEIC photo included, is uploaded as it is staged
  into `<cwd>/uploads/hermie/<date>/<token>-<name>` (100 MiB) and named in the prompt by its `@file:` reference, which
  is how the agent can read it. The caps are checked before a byte moves; the gateway's own refusal (`detail`) is shown
  on the chip it concerns. No image is resized or re-encoded: the client carries no image processing.
- **Progress** is "Preparing…" or "Uploading…", then the size or the reason. There is no percentage: `fetch` reports
  no upload progress, and `XMLHttpRequest`, which does, follows redirects by itself and would replay the file and the
  session to wherever a 307 points, which `uploadFile` refuses (`redirect: 'manual'`). **Cancel** aborts the request
  (the gateway removes its temporary file); **Try again** starts the same file on a fresh path; **Remove** takes a
  chip away (an uploaded file stays on the gateway, as in the native apps).
- **What is shown is what is sent.** Send waits while a chip is still working or has failed ("Send is available once
  every attachment is ready or removed."), and is named "Send message with 2 attachments" while there are some. A
  message may be attachments and no words. A slash command takes none; they stay for the next message.
- **Once (HERM-126).** The tray is emptied by `take()` in the same synchronous step that decides to send, before
  anything is awaited, so a second Return or click landing while the first send is in flight finds nothing to send.
  A send that fails puts back exactly what it took, in order, ahead of anything staged meanwhile, with the words.
- **Paste.** Files with no text (a screenshot), or whose text is only their names (a file copied in the Finder), are
  attached; text that comes with a picture of itself (spreadsheet cells) goes into the field as text.
- **Drop.** Only a drag that carries `Files` lights the target ("Drop file to attach", said once politely). While a
  chat that takes attachments is open, a file dropped anywhere else on the page is ignored instead of being opened by
  the browser in place of the app. The keyboard's way in is the attach button.
- **Thumbnails** are `data:` URLs of the bytes already read, up to 8 MiB; larger images show the file glyph. Not
  `blob:` URLs: a recorder that copies the page (Playwright's trace) fetches a `blob:` image from inside the page, a
  connection `connect-src 'self'` refuses and reports.
- Only a chat with a composer that is attached to its session takes files: a file is uploaded into that session's
  workspace, which the resume names (`info.cwd`).

## Requests

A bot's approval or question (`clarify`) is answered in `features/requests/`, a modal layer over the whole page
(`<RequestLayer />` in `App`, beside the frame), never in the transcript, where a row scrolls away.

| File                | What                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `state/requests.ts` | `requestsStore`: the open requests of every chat, oldest first; `bindRequests(chatsStore)`                 |
| `RequestLayer.tsx`  | the dialog, focus, the inert page, the polite announcements; answers through the controller                |
| `ApprovalSheet.tsx` | the command and Allow / Deny, the gateway's `choices` less what its flags rule out; one answer for several |
| `ClarifySheet.tsx`  | one question or a stepper over a batch: choices, free text, multi-select, Lock, Skip, Cancel all           |
| `sheets.ts`         | every sheet, as one chunk; `request-sheets.ts` fetches it when the session starts and holds it             |
| `request-layer.css` | the scrim, the dialog and the sheets                                                                       |

- **One source of truth.** The store holds no request of its own: it is a view over the chat store, which is where the
  engine puts a request raised on the socket, one the gateway re-delivers from `open_requests` on resume, and the
  pending approval a resume reports. So a resume restores a request here with no code of its own, `request.cancel`
  (the item turns `cancelled`) withdraws it, and an answer (`respondApproval` and `respondClarify` mark the item
  `answered` first) takes it off in the same breath. `session.ts` binds it to the chats it starts.
- **One at a time, oldest first,** in the order requests were first seen (not the rows' order: they are in different
  chats), with "N more waiting" under the one on screen. A request for a chat that is not on screen raises the layer
  too, and the dialog names the bot ("From <name>").
- **A modal dialog.** `role="dialog"`, `aria-modal`, named by its heading, described by what is asked. The rest of the
  page is `inert` while it is open (`platform/modal-isolation.ts`: every sibling of the layer and of its ancestors),
  Tab is also kept inside by hand, and a focus that lands outside is brought back. **Escape does not dismiss, and
  neither does the scrim**: a dismissed question is one the bot waits on with nobody looking. Focus goes to the
  dialog itself (not a button) when a request appears, so a Return meant for the field presses nothing, and back to
  where the reader was when the last one is gone (the composer, when that place no longer exists).
- **Approval.** The buttons are exactly the gateway's `choices`, in its order (the engine's own set when it sent none):
  once, session, always and deny have fixed wording from the catalogue, any other keeps its own name. The buttons wake
  400 ms after the dialog appears, so a click already on its way answers nothing, and a second press of one answer is
  ignored. `acknowledgeApproval` is sent when a person can first see it.
- **What an approval offers** (PG-3). A choice the request's flags rule out is not drawn even when `choices` names it
  (`offeredChoices`): "Allow for this session" needs `allow_session`, "Always allow" needs `allow_permanent`, and a
  command the gateway's own safety check refused (`smart_denied`) offers once and deny only and says so, in fixed words,
  in the dialog's description. "Allow for this session" and "Always allow" each have a line saying what they mean,
  shown only with that choice.
- **One answer for several.** When the same bot has other approvals waiting, a box (off, asleep behind the same guard)
  gives them the same answer; ticked, it lists their commands, so nothing is allowed that was not on screen. It is
  answered request by request with `respondApproval`, never with the wire's `all: true`: the gateway applies `all` to its
  whole queue, which can hold an approval this page has not been shown. A smart-denied request is never part of it, nor
  one that does not offer the choice pressed. The tick holds for the list it was given for: when a request joins or
  leaves it, the box is unticked in the same render and a polite line in the dialog says so, with no button disabled
  under the reader's focus.
- **Clarify.** A single question with choices (radio), several (checkbox, joined with ", ") or free text, which edit the
  same one answer. A batch is a stepper: Next, Back, and Lock answer (`lockClarify`: locked on the gateway, then
  read-only). **Skip answers `''`**: on a single question, "no answer" for the bot; in a batch, that step, moving on, and
  on the last step sending every answer. Command or Control+Return in the field answers. **Cancel all** (a batch only)
  is the gateway's cancel-all, a reply with neither `answer` nor `answers` (`cancelClarify`); the card closes as
  `cancelled` under `CANCELLED_BY_READER` and nothing is announced. A single question has none: there it is the same
  reply as Skip.
- **Plain text.** The command, description, tool name, question and choices are the gateway's and an agent's words and
  are never Markdown here.
- **Said aloud.** A request that left without the reader's answer (withdrawn, or timed out) is announced in a polite
  region beside the dialog ("The request from <name> was withdrawn."); a failure to deliver an answer is an alert.
- **A `confirm` at level `passkey`** joins the same queue as an entry of its own kind (`ConfirmRequest`), held by the
  passkey model rather than the chat store; "Passkeys" below. **Secret, sudo and vault prompts** join it the same way
  (`SecureRequest`), held by the secure input model: "Secret prompts" below. A connector authorisation joins it as
  `ConnectionRequest`, held by the connections model: "Session gaps" below. A `plain` confirm is W-15.

`features/requests/RequestLayer.test.tsx` and `state/requests.test.ts` cover the above in jsdom, `requests.axe.test.tsx`
runs axe on the composer and the layer (both schemes, every language), and `e2e/chat.spec.ts` (sending and stopping)
and `e2e/requests.spec.ts` run the **built** client against the fake gateway (streaming slowly, so a turn can be
acted in the middle of):

| Check                                                                                                                           | Result                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Return sends, the bubble is painted, the reply streams (`aria-busy`), the field empties; Shift+Return breaks the line and grows | as described                    |
| Stop mid-stream: the interrupt reaches the gateway, `runningSessions` empties, no word arrives after it                         | as described                    |
| a send during a reply is a chip; Delete and Edit                                                                                | as described                    |
| the draft per chat, across leaving the chat and a reload                                                                        | kept; cleared by a send         |
| the prompt "approve" raises an approval; Allow once from the keyboard alone; Escape does not close it; focus returns            | `{choice: 'once'}`              |
| Deny; an approval for a bot whose chat is not on screen; two requests one at a time                                             | `{choice: 'deny'}`              |
| a withdrawn request closes; one raised before the page loaded is restored                                                       | closed; restored                |
| clarify: a choice with the arrow keys, free text, a three-step batch with Skip, Skip on a single question                       | `{answer}` / `{answers}` / `''` |
| one answer for three of the same bot's approvals, the others listed first; a smart-denied one offers once and deny, in no bulk  | three `{choice: 'once'}`        |
| Cancel all on a batch; a single question has Skip and no Cancel all                                                             | `{}`                            |
| the page behind the layer is inert; 320 px wide does not scroll sideways                                                        | inert; no overflow              |
| a request still open when the page is reloaded is asked again; axe (`e2e/a11y.spec.ts`) on every sheet, light and dark          | asked once more; no violation   |

### Secret prompts

`secret`, `sudo`, `vault.unlock_prompt`, `vault.code` and `vault.save_login` are answered beside the transcript engine,
as in the native apps (`core/requests/secure-input.ts`, the counterpart of `HermieCore/SecureInputCenter`): the chat
controller declines them, and the secure input model takes them from the connection, keeps what was asked in
`state/secure-input.ts` and answers on the request's own reply. The rules are the plan's ("Secret prompts in a
browser"):

- **The value is never state.** The fields are uncontrolled; Send reads the field at the press and hands the text to
  the model, which builds `{value}` and sends it. It never enters a store, React state, the transcript, the cache, a log
  or an error. The field is emptied when the answer went out, and in the commit that removes it when the prompt is
  withdrawn or expires, before it leaves the document. A unit test serialises every store after each kind is answered
  and searches for the value; the browser suite searches the markup, the address, both storages and every IndexedDB
  store.
- **Answers.** `{value}` as typed; a code without the spaces and dashes typed to read it in groups; a login as the JSON
  string `{"identifier", "password"}` built in memory. **Skip is `''`.** Nothing goes out while the connection is not
  ready: the sheet says so and keeps what was typed.
- **Fixed words.** The heading, the gateway's host, the labels, who receives the value and the buttons are the app's.
  Everything the request supplies (the prompt, the command, the variable, the password manager, the site, its address,
  the hint) is plain text in its own labelled box, cleaned and bounded first (`displayText`: no control, format,
  bidirectional or private-use characters, folded blanks, at most four combining marks, a length limit), never
  Markdown, never a link, and never woven into the app's own sentences. The bot's display name in the heading, the
  "From" line and a chat's notice is the roster's, which a bot with shell access can set: it is cleaned the same way,
  cut at 64 characters and isolated in `<bdi>`, so its characters cannot reorder the sentence around it.
- **The fields.** Masked (a login's username is not a secret and is not), `autocomplete="off"` (a one-time code is
  `one-time-code`: no password to save, and the browser may offer a code it just received), with the opt-outs of the
  common password-manager extensions, no `name`, in no `<form>`; focus goes to the dialog, not the field; the fields
  and buttons wake 400 ms after the sheet appears, and whatever reached a field before then is dropped. Escape does not
  close the sheet.
- **Known limit: the browser's own password manager.** Chromium and Safari ignore `autocomplete="off"` on a password
  field. They may offer this origin's saved password (the gateway's sign-in) in a sheet's field, and offer to save what
  was typed, a `vault.save_login` username and password above all, under the Hermie origin. The `data-*ignore` markers
  reach extensions only. What the client does about it makes it less likely, not impossible: no form and no `name`, the
  400 ms in which the fields take nothing (and are emptied when it ends), and a field emptied before it leaves the
  document, so a browser looking at it as it disappears sees nothing. A text field masked with
  `-webkit-text-security` would dodge the save offer, and was rejected: it is non-standard, a screen reader reads the
  characters aloud, the system's secure text entry is lost, and mobile keyboards learn what is typed into a text field.
  None of this is observable from the browser suite (the offer is browser chrome, not the page, and an automated
  browser starts with an empty password store), so it is stated here rather than tested.
- **Deadlines are the gateway's** (`tui_gateway/agent_callbacks.py`): 300 s for a secret (the gateway's default), 120 s
  for sudo and an unlock, 180 s for a code and a login, with a visible countdown. One first seen re-delivered (a reload,
  a resume) shows no countdown and is closed a whole timeout after it arrived, never before the gateway.
- **Ending.** `request.cancel` closes the sheet with a notice on the chat ("expired" for the gateway's `timeout`,
  "withdrawn" otherwise), and so does the deadline; nothing is sent. A prompt whose session no chat holds any more is
  answered `''`, and a sign-out answers every open one `''` before the socket closes. A cancel that arrives just after
  an answer went out says the answer may not have arrived.
- **Ended while the socket was down.** The model hears the live socket only, so the chat controller passes on what a
  reconnect learns (`ReplaySignal`): a `request.cancel` in the `session.events.since` replay closes the prompt as a
  live one would, and a prompt the resume's or replay's `open_requests` no longer lists for its session closes with a
  notice saying it ended while the connection was down. An answer to it would only be dropped by the gateway. A
  prompt first seen after that call went out is left alone: it may be newer than the list.
- **Restored** from `open_requests`: a re-delivered copy of one already answered here means the answer never arrived,
  and the sheet asks again and says so (a lost Skip in its own words). The reply goes out on the newest copy, under
  the session that copy names.
- **Waiting for its chat.** A prompt for a session no chat on this page holds yet (a resume re-delivers open requests a
  moment before it binds their session) waits, at most 16 at once, until a chat holds it or its deadline passes. The
  native apps decline such a prompt with `-32601` after 15 s; this client does not, because the gateway reads that
  error as "nobody can answer" and gives up on the request for every client, while another client of the same
  gateway, or a chat the reader is about to open, could still answer it.
- **What only the desktop app can do** (`preview.act`, `preview.read`, `terminal.read`, `window.read`, `tour`) is
  answered at once with the native apps' `-32601` and leaves one notice on its chat per request.

`core/requests/secure-input.test.ts`, `features/requests/SecureSheet.test.tsx`, `state/requests.test.ts` and
`features/shell/session.test.ts` cover it in jsdom; `e2e/secure-input.spec.ts` raises each method through
`/__fake/request` against the built client and reads the answer the fake recorded.

### Session gaps

What the gateway says beside the transcript, and what makes a reconnect honest, as in the native apps (PG-2:
`TranscriptStore+Refetch`, `TranscriptStore+Signals`, `GatewayNoticesModel`, `ConnectionRequestsModel`,
`GatewaySession+Facts`). The transcript engine stays a parity port: the chat controller picks these events off the
ingest path at their place among the chat's frames and hands them to three models through `onSessionSignal`
(`SessionSignal`); none of them reaches the engine.

- **A replay that cannot vouch for itself reads the chat again.** The connection replays every session it holds a
  watermark for after a reconnect, but reads only the events: the socket notes every `session.events.since` call on
  the way out and reads its answer on the way in (`platform/socket.ts`, `ReplayGapTap`), and an answer with
  `truncated: true` names the session to `ChatController.noteReplayGap`. The controller's own replay in a recovery
  counts as a gap when it is `truncated`, comes from another epoch, or finds a cold watermark on a session that has
  numbered events since. Either way the chat is read again in full, after its resume (`refetch`: the history
  reconciled onto what is there, ids kept, nothing doubled, the queue and the draft untouched, one read per chat at a
  time, an empty answer applying nothing). A gap reported while the socket is down, or while the chat is recovering,
  waits for that recovery; one for a chat being opened is its own history read.
- **Who the reader is** comes from `/api/auth/me` and nowhere else: the boot reads it, and the session status model
  (`core/session-status.ts`) reads it again after every reconnect, keeping a known identity when a read fails. A
  gateway that names nobody (`anonymous`), or one that could not be asked with nothing known (`failed`), gets a line in
  the sidebar (`features/notices/IdentityNote.tsx`) instead of a transcript that attributes nothing without a word.
- **`gateway.capabilities`** is read once per connection. A row's author is the gateway's word only when it
  advertises `per_message_author` (`rowAuthorsTrusted`, `features/chat/use-own-author.ts`); without it every row reads
  as the reader's own, as in the native apps.
- **Notices** (`notification.show` / `.clear`, `core/notices.ts`): keyed by `key` (else `id`), replaced in place,
  withdrawn by a clear, a `ttl` notice gone after `ttl_ms` (8 s by default), at most eight, the text cleaned and bounded
  (`displayText`, 400 characters) and drawn as plain text over the page and over a dialog
  (`features/notices/GatewayNotices.tsx`), `warn` and `error` as alerts, each with Close; a notice about one chat names
  its bot in `<bdi>`.
- **Connector authorisations** (`connection.request` / `.update`, a resume's `pending_connection`,
  `core/connections.ts`): one card per chat with the gateway's deadline, a sheet in the request layer
  (`ConnectionSheet`) with a countdown. A newer `seq` moves a card, `settled` or the deadline on this page's clock
  withdraws it, a resume that names no operation withdraws it, and an account-wide operation is not a chat's. A link is
  opened only when the person presses it, in a new tab with `noopener,noreferrer` (`platform/open-link.ts`), and only
  when it passed `authorisationLink`: `https`, a host, no user name or password before it, as the browser's own URL
  parser reads it (so `javascript:`, `data:` and `http:` never pass); its host is in the button's name and beside it,
  punycode for an international name. A refused link is said, not drawn. "Not now" and "Stop waiting" answer with
  `connection.respond` (`status: skipped`, `settled_by: continue`) in exactly the gateway's shape,
  `{profile, owner: {type: 'session', session_id}, op_id, result}`: its params are `extra="forbid"`, and the generated
  contract in `@hermes/shared`, which names the session as a top-level `session_id`, is wrong there, so the client types
  the params itself (`ConnectionRespondParams` in `core/connections.ts`). The fake gateway's `connection.respond` refuses
  any other key the same way.
- **`session.status`**: `/status` on a gateway whose command catalogue does not list it asks for the session's report
  directly and puts it in the chat as the command's answer; one that lists it runs it through `slash.exec` as before.
- **`session.resume_progress`**: a resume that says the gateway is still loading the conversation (`hydrating`) puts a
  line on the chat (`features/notices/ResumeProgressLine.tsx`); `complete` takes it away and reads the chat again,
  `failed` shows the gateway's reason until closed.

`core/chat-session-gaps.test.ts`, `core/notices.test.ts`, `core/connections.test.ts`, `core/session-status.test.ts`,
`platform/socket.test.ts`, `features/requests/ConnectionSheet.test.tsx` and `features/shell/session.test.ts` cover it in
jsdom; `e2e/session-gaps.spec.ts` drops the socket with `truncateNextReplay` set on the fake and checks the chat is read
again with every turn once (and that a replay that vouches for itself reads nothing again), and drives the notices,
a connection card (its "Not now" and "Stop waiting" through the fake's strict `connection.respond`) and the progress
line with the fake's `emit`.

## Passkeys

A `confirm` request at level `passkey` is one the gateway verifies itself: the page answers with a WebAuthn assertion
over a challenge that commits to the gateway's base URL and id, the session, the request, a fresh nonce and the exact
text shown. The construction, the wire objects and the order of the gateway's checks are
`contract/confirm-passkey/README.md`; the plan is `confirm-passkey.md` (task CP-13). The native apps do the same with
their own RP (`docs/native.md`, "Confirm at level passkey"); the phases, refusal reasons and notices here are theirs.

| File                                     | What                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `core/passkey/challenge.ts`              | base64url, the base URL, the text digest, the challenge and the enrolment code (contract §2 to §7)         |
| `core/passkey/client.ts`                 | the six `/api/auth/passkeys` routes on the cookie session, with the refusal's `error` and `reason`         |
| `core/passkey/model.ts`                  | `PasskeyModel`: frames, answers, withdrawals, advertising, enrolment, step-ups, pins, notices              |
| `state/passkeys.ts`                      | the store the model writes: confirmations and their phases, notices, the list, the capability verdict      |
| `platform/webauthn.ts`                   | the browser's ceremonies (`WebAuthnSeam`) and SHA-256                                                      |
| `platform/passkey-pins.ts`               | the pins (see "Browser storage"), and forgetting this gateway's                                            |
| `platform/socket.ts` (`ErrorDataOutbox`) | puts `data.reason` on a 4040 error frame, which the vendored channel's `fail(code, message)` cannot carry  |
| `features/requests/ConfirmSheet.tsx`     | the sheet in the request layer (in the request sheets' chunk, below)                                       |
| `features/requests/PasskeyNotices.tsx`   | the notices, over the page                                                                                 |
| `features/settings/Passkeys.tsx`         | `#/settings/passkeys`: the state, the list, add with a code, make a code, remove, forget the pin (a chunk) |

**Where it is offered.** The RP is the page's own hostname (`location.hostname`), never the registrable domain, and the
base URL is the page's origin. The page advertises the level only when all of these hold: the page is a secure context
with WebAuthn; the gateway's base URL has no path prefix (two gateways under prefixes of one host share its browser
security boundary, contract §10); the first `client.capabilities` result carries `confirm_passkey` with `v: 1` and
`enabled: true`; its `rp.web` lists this hostname; its `gateway_id` breaks no pin; and the status read
(`GET /api/auth/passkeys`) lists this page's origin among its `base_urls`. Without that last one every answer would be
refused (`base_url_not_accepted`) and five refusals open the no-downgrade window for the conversation, so the page
says so (a notice, and the settings page's state) and does not advertise; a gateway that lists none (an older one) is
not held to it. The channel already sends the first
call on `gateway.ready` and throws its answer away, so the model sends it again after every arrival at `ready` and reads
it, then sends the second: `{server_requests: true, confirm: ["passkey"], confirm_passkey: {v: 1, kind: "web", rp_id}}`.
`plain` is not advertised: this client has no sheet for it yet. Unlike the native apps, the page does not wait until it
knows a passkey of its own before advertising: the gateway decides per request whether the person has one for this RP,
and a browser can hold a synced passkey this page never enrolled. Once `passkey` is newly accepted on a socket the open
requests of every session the page holds are read again (`session.events.since`), because the gateway hides a gated
request from a connection that had not advertised the level when the resume ran. A chat that resumes while the capability calls are still in flight (its answer hidden, and not yet taken in when the level is accepted) is read when its session appears. The read also settles what the page already holds: a confirmation that was open before it,
belongs to a session just read and is not among the `open_requests` the gateway answers with is over (the socket that
would have said so dropped), and ends as timed out, quietly, like the gateway's own `request.cancel timeout`; a
gateway that answers without the list says nothing about them.

**Answering**, as rules (the model's header has them in full):

- every answer goes through `request.answer`, so a refusal comes back: 4033 (this connection may not answer; it is over
  for this page), 4034 with `data.reason` (the request stays open; try again), and the fifth refusal is
  `too_many_attempts`;
- `ok` means "received and valid", never "confirmed": the sheet says the gateway checks it. The gateway commits the answer
  next, and a failed commit arrives as `request.cancel {reason: "verification_failed"}`, which the sheet shows as "did not
  count", even over a sheet the person had closed. The page never sends `verified`;
- a decline is exactly `{decision: "declined", method: "tap"}`;
- closing the browser's passkey sheet sends nothing and leaves the confirmation as it was;
- a frame this page cannot take is answered with error 4040 and `data.reason`: `rp_not_configured`, `bad_base_url`,
  `unsupported_version`, `bad_request`, `no_credential`, `gateway_id_mismatch`, `gateway_id_conflict`. The last five also
  leave a notice; a ceremony the browser refuses outright (`SecurityError`, `NotSupportedError`) is `rp_not_configured`;
- the page's own clock ends a confirmation too: one whose `expires_at` has passed is not actionable, `confirm` and
  `decline` end it as timed out instead of running a ceremony for a dead request, and the sheet asks for that at the
  deadline (and switches its buttons off from then on);
- 4033 is about the connection, not the request: a frame delivered again for the same id (the gateway offering it to
  this connection once the level is accepted) brings a request that ended that way back to waiting;
- `request.cancel` ends an open confirmation: `timeout`, `resolved` (another device answered) and any other reason close
  the sheet with a polite announcement; `too_many_attempts` and `verification_failed` stay on screen until closed.

**The sheet** is the plan's P15 frame: who asks (the gateway's host) and which passkey the browser will ask for (this
page's host) in fixed words, then the title, summary and detail exactly as the frame carried them, never as Markdown.
The detail is monospaced with every space and line break kept (`white-space: pre`) and scrolls sideways instead of
wrapping. The challenge is computed from the same `PasskeyConfirmation` the sheet renders. Confirm and Decline wake
400 ms after the sheet appears; Escape and the scrim do not dismiss it; a countdown runs to `passkey.expires_at`; the
phases (`waiting`, `signing`, `sending`, `refused`, `not_sent`, `received`, `declined`, `ended`) are said in a status line.

**Pins** (contract §10). The gateway id is pinned on the first successful enrolment in this browser, not on first
connect. After that a capability, a frame or a status read with another id is refused and leaves a notice, and so is an
id another gateway on this origin pinned. The pin survives a sign-out (it is about the gateway, not a person); the
passkey ids this browser has seen do not. A `passkey.changed` or a list read that shows a passkey this browser did not
add is a notice. A status read that breaks the pin keeps nothing: the settings page does not list another gateway's
passkeys under the notice.

A gateway whose passkey store was reset on purpose presents a new id and is refused for it, and the pin cannot be
cleared from the page except by the person's word: **Settings, Passkeys, "Forget this gateway's passkey pin"**, behind a
confirmation, clears `device.passkey.pin@<base URL>` and nothing else (not the ids this browser has seen, not another
gateway's pin), and the capability calls run again; the next enrolment pins the id the gateway presents. Clearing the
site's data does the same and more.

**Settings.** `#/settings/passkeys` says whether the level is on here and why not, lists the person's passkeys (for
this site and for the apps), adds a passkey of this browser with a one-time code (`register/begin`, the ceremony,
`register/finish`; the page names the passkey `Hermie — <host>`, the host cut in the middle with an ellipsis where the
name would pass the gateway's 100 characters), makes a code for another device and removes a passkey, both behind a
step-up assertion with a passkey of this site. A code is shown once, in the page with a Copy button
(`platform/clipboard.ts`), and stored nowhere; the live region says "your code is ready", not the code. A 429 shows the
wait the gateway asked for (`Retry-After`), and a 403 `origin_not_listed` is a state of its own: the gateway does not
list this page's address.

**Two chunks.** The sheet (`ConfirmSheet`) is in the request sheets' chunk ("What the first load carries", below),
fetched when the session starts; the settings page (`Passkeys` and `passkeys.css`) is loaded with `React.lazy` when
`#/settings/passkeys` is opened, or when a pointer or the focus reaches the link to it. The model, the pins, the client
and the WebAuthn layer stay in the entry bundle, because a frame is read, and a 4040 answered, whether or not the
sheet ever loads. Should a confirmation arrive before the chunk, the dialog shows its heading and who asks, and nothing
to press.

**Not the native app.** In a browser the page is the client: what it displayed is asserted by code the gateway served,
so a script injection on the gateway's origin could show one text and ask for a signature over another (plan, Security
Considerations point 7). The page turns no text into markup anywhere ("Layout", the lint rules), which is the defence
it has.

**Tests.** `challenge.test.ts` runs the CP-1 vectors (base URL, text digest, every challenge with its preimage,
enrolment codes) with Node's `webcrypto` standing in for `crypto.subtle`. `model.test.ts` reads frames (every 4040
reason and its notice), the `request.answer` refusals and every `request.cancel` reason. `model.integration.test.ts` runs
the model against the fake gateway with the level on, over a real socket, with a software authenticator
(`test-support/soft-webauthn.ts`, on the fake gateway's own CBOR encoder): advertising, enrolment with an operator code,
a confirmation the gateway verifies (and the same challenge as the fake gateway's `SoftAuthenticator` computes for that
frame), decline, refusals up to `too_many_attempts`, a passkey revoked while the request is open, a timeout, a closed
browser sheet, a 4040 with its `data.reason` on the wire, the open requests read again on a new socket, invite and
revoke, a `passkey.changed` notice and a broken pin. `ConfirmSheet.test.tsx` and `Passkeys.test.tsx` cover the views,
with axe. `e2e/passkey.spec.ts` drives the built client in Chromium with a virtual authenticator ("The browser suite").

## Markdown

`src/markdown/` draws a message as React elements. The text goes through `@hermie/markdown` (`preprocessMarkdown`,
`splitBlocks`, then `marked.lexer` per block, the same three steps the Expo app and the corpus use) and the tokens
become elements; no HTML string is made anywhere, so there is nothing to sanitise.

```tsx
<Markdown text={message.text} gatewayBaseUrl={baseUrl} />
```

Two optional props place a message's headings in the page it is drawn in (`headingOffset`, `headingMax`: a heading is
the written level plus the offset, capped at the max; the transcript uses 2 and 3).

| File                     | What                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `markdown/Markdown.tsx`  | the component: one memoised child per top-level block, keyed by its index and a hash of its source   |
| `markdown/Block.tsx`     | block tokens: paragraph, heading, list (nested, ordered, task), quote, rule, fence, raw HTML as text |
| `markdown/Inline.tsx`    | inline tokens: strong, em, del, code, line breaks, links, images                                     |
| `markdown/CodeBlock.tsx` | a fence: language label, copy button with a polite live announcement, a box that scrolls sideways    |
| `markdown/Table.tsx`     | a table in its own focusable scroll container, `th scope="col"`                                      |
| `markdown/links.ts`      | the two allow-lists: which links may be anchors, which images may load                               |
| `markdown/markdown.css`  | the styles, on tokens that follow the reader's colour scheme                                         |

The rules, each pinned by a test:

- Raw HTML in a message, block or inline, is shown as the characters that were typed. An entity stays as written.
- A link is an anchor only for `http:`, `https:` and `mailto:` (`target="_blank"`, `rel="noopener noreferrer"`).
  Any other link keeps its words and loses the link. The check is anchored at the first character, so a leading
  space, a control character or a case trick does not get past it.
- An image loads (`<img loading="lazy">`) only from the gateway's origin: a path is joined onto
  `gatewayBaseUrl`, an address must have the same origin. Any other `http(s)` image is a link with the alt text;
  anything else, and any image when there is no `gatewayBaseUrl`, is its alt text. An image that fails to load
  falls back to its alt text.
- `math` and `mermaid` blocks, and inline math, show their source until the renderers for them arrive (W-21).
- While a reply streams, a block whose source did not change is not rendered again and keeps its DOM element.

`markdown/*.structure.test.tsx` reads the rendered DOM back into the block model and compares it with every input of
`contract/markdown/blocks.json` and `inline.json`; `*.streaming.test.tsx` replays `streaming.json`;
`*.hostile.test.tsx` renders hostile input and checks the result against a closed list of elements and attributes.

`src/dev/markdown-fixtures.tsx` is a page with every kind of block, for the eye and for axe
(`markdown-fixtures.axe.test.tsx`): run `npm run client:dev` and open `/dev/markdown.html`. Nothing the build reaches
imports `src/dev/` (a test checks it), so it is not in `dist/`.

## Transcript list

`features/chat/TranscriptList.tsx` is the list the chat screen stands on (plan decision W8). Its props are the
whole boundary, so what is behind them can change without touching a caller:

| Prop            | What                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `rows`          | what `visibleItems` returned, oldest first                                                        |
| `renderItem`    | draws one row; keep it stable (`useCallback`), rows are memoised on it                            |
| `onReachTop`    | the reader is within 0.4 of a viewport of the oldest row: load older history (once per first row) |
| `onStickChange` | the list started (`true`) or stopped (`false`) following the newest row; it starts following      |
| `label`         | the accessible name of the `role="log"` region                                                    |
| `busy`          | `aria-busy` on the region while a reply streams into it                                           |
| `listRef`       | a handle with one command, `jumpToLatest()`: go to the newest row and follow it from now on       |

How it works:

- **Bottom-anchored, and the reader's place is never moved** (`scroll-anchor.ts`, ported from the Expo app's
  transcript). Within 32 px of the bottom the list follows a growing reply and new rows. Anywhere else it holds
  the row the reader is looking at: rows growing below move nothing, and anything that changes height above
  (a page of older history, a row drawn for the first time) moves the scroll offset by the same amount. The
  browser's own scroll anchoring is off (`overflow-anchor: none`) so Chromium, WebKit and Firefox all run
  this one rule. It runs from a `ResizeObserver` (after layout, before paint) and on every scroll event.
- **Every row is in the DOM; the browser skips what is far away.** Rows are grouped into stable chunks of up
  to 50 (`row-chunks.ts`); each chunk is `content-visibility: auto` with an intrinsic height that is the sum
  of its rows' per-kind estimates (`ROW_ESTIMATES`), and a chunk drawn once remembers its real height. On the
  chunk rather than on each row because Chromium checks every such element against the viewport on every
  frame that changed layout: per row, that check was most of the frame on a 5,000-row chat.
- **A delta re-renders one row.** Chunks and rows are memoised on the rows' `(id, version, presentation)`
  and on whether the selectors took a thought away.

### The harness and the performance suite

`src/dev/transcript-harness.html` is a development-only page: the list on a synthetic 5,000-item chat built
by the engine (`rowsToItems`, `reconcile`), a reply streaming into it at 30 deltas per second
(`applyEvent`, with the recorded scenarios' own delta texts), committed at most once per frame, and the
recorded stream scenarios (`contract/transcript/streams/*.json`) replayed at the end of the long chat. It is
built only by `npm run harness:build` (`vite build --mode harness`, into `dist-harness/`, production React,
the client's own policy) and served by `npm run harness:serve` on `127.0.0.1:4180`; the bundle gate refuses
its marker, so none of it can reach `dist/`.

`e2e/perf/transcript-stream.spec.ts` drives it (Playwright starts and stops the server itself):

| Check                                                                                                                        | Engines                   | Budget                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| 60 s of streaming on 5,000 items at 4x CPU throttling: main-thread tasks over 50 ms (from a trace), dropped frames           | Chromium                  | 0 tasks, under 1 % of frames    |
| the same run: pinned while at the bottom, then reading mid-list across new turns and a 200-row prepend; history rows redrawn | Chromium                  | 0 px gap, 0 px drift, 0 redraws |
| pin, drift across a prepend, older history asked for at the top, unthrottled                                                 | Chromium, WebKit, Firefox | 0 px (half a pixel of slop)     |
| a cached 200-row chat: IndexedDB read, engine, first painted frame                                                           | Chromium, WebKit, Firefox | 300 ms                          |
| every recorded scenario's checkpoints, as rows on the page                                                                   | Chromium, WebKit, Firefox | exact                           |

```sh
npx playwright install chromium webkit firefox                   # once
npm run client:e2e:perf                                          # all three engines
npm run e2e:perf:chromium --workspace @hermie/web-client         # what CI runs
TRANSCRIPT_PERF_SECONDS=15 npm run client:e2e:perf               # a shorter throttled run while working on it
```

It has its own configuration, `playwright.perf.config.ts` (the harness server, which the black-box suite does not
need). CI runs Chromium only, in the `web-client` job beside the bundle budgets; WebKit and Firefox are run by hand
before a change to the list is merged. Every measure is printed and attached to the test's results.

### Measured

The spike (plan W-8) kept `content-visibility` and did not need the pre-approved virtualiser. Measured on
3 October 2026 on an M5 Max (18 cores, load average 5 to 12) with Playwright 1.63: Chromium 153 (headless
shell) and WebKit 26.6, 1280 by 800, device pixel ratio 1.

| Measure                                                                     | Chromium, 4x CPU                           | WebKit, unthrottled     |
| --------------------------------------------------------------------------- | ------------------------------------------ | ----------------------- |
| main-thread tasks over 50 ms in 60 s of streaming on 5,000 items            | 0 of 9,144 (longest 12 ms)                 | not run                 |
| frames dropped in those 60 s                                                | 0 of 3,604 (0 ms/s hitch time)             | not run                 |
| main thread busy                                                            | 28 %                                       |                         |
| gap below the newest row while pinned                                       | 0 px                                       | 0 px                    |
| drift of the row being read, across new turns and a 200-row prepend         | 0 px                                       | 0 px                    |
| history rows drawn again during the run                                     | 0 of 5,000                                 |                         |
| cached 200-row chat, open to first painted frame (worst of five)            | 18.5 ms (unthrottled)                      | 19 ms                   |
| scrolling up through unseen history with the wheel for 10 s while streaming | 1 frame dropped of 722, longest task 37 ms | 0 dropped (unthrottled) |

Throttling and task traces are Chromium's, so the throttled run is Chromium-only; WebKit's pin and drift
figures come from the shorter unthrottled check (8 s pinned, then 8 s reading across a prepend). The scrolling
row is a one-off measurement, not part of the suite.

Firefox was not measured: the Playwright Firefox build (155) did not start on that machine ("Could not find
profile folder", outside any sandbox as well). Its pin, drift, cached-open and scenario checks are in the
suite and run wherever Playwright's Firefox does.

What the spike changed on the way:

- **`content-visibility` per row was the frame.** With 5,000 `content-visibility: auto` rows, Chromium spent
  about half of the throttled run in its own viewport-proximity check (`IntersectionObserverController`), and
  a 15 s run had 5 tasks over 50 ms and 14 % dropped frames. One per chunk of 50 rows took that check to under
  1 % of the run.
- **Settling after every commit forced a second layout per frame.** The resize observer already reports every
  change before the paint; settling from it alone removed that layout.
- **WebKit lays out a chunk entering the viewport during a scroll event's geometry read**, one frame before it
  reports the resize. The anchor treats a scroll event that did not move the offset as the list's own and
  settles instead of taking the shifted layout as the reader's new place (a test pins this down).
- **A history page must go through `prependHistory`**, which keeps every existing item's version: through
  `reconcile` every row was drawn again.

The rest of each frame is the engine: `applyEvent` copies the chat's indices on every event (about 1.4 ms per
event on 5,000 items unthrottled), roughly two thirds of the JavaScript time while streaming.

## The browser suite

`e2e/*.spec.ts`, configured by `playwright.config.ts`: the built client in a real browser against the fake gateway,
in Chromium, WebKit and Firefox. It is a black-box suite: the page is driven by roles and accessible names, the
gateway by its control endpoints (`/__fake/state`, `request`, `withdraw-requests`, `drop-sockets`,
`expire-sessions`, `inject`), and no test waits for time to pass: it waits for what the page shows (Playwright's
auto-waiting), for what the gateway reports (`expect.poll`), or for the page to stop moving (`settled`, a number
of frames in a row with the same answer).

`e2e/fixtures.ts` is what every spec gets:

- the production build, once per worker: `vite build` into a temporary directory, laid out as the plugin carries
  it, then `build.json` written as `npm run client:build` does;
- a fake gateway of its own per test, on a free port, in cookie mode, serving that build through its copy of the
  dashboard's static route (`gatewayOptions` changes how it starts: history rows, a slow stream, a scenario);
- `diagnostics`, on every test: any `console.error`, uncaught page error or `securitypolicyviolation` event fails
  the test that caused it. A test that provokes one on purpose says so, where it does it
  (`diagnostics.allow(/pattern/)`);
- `app` (sign in, open a route, the field, Send, Stop, the dialog) and `seriousViolations` (axe with contrast);
- `secureOrigin`, for a spec that needs an https page (`test.use({ secureOrigin: 'https://gw.example.test' })`): the
  page is loaded from that origin and Playwright's routing carries every request (`route.fetch`) and WebSocket
  (`routeWebSocket`, piped to the fake over Node's `WebSocket`) to the fake gateway, so the page is a secure context on a
  host name WebAuthn takes as an RP, without a certificate or a proxy; the session cookie is copied to that host on
  sign-in.

| Spec                  | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signin.spec.ts`      | an unauthenticated visit goes to the gateway's `/login` and signing in opens the client; a wrong password stays; a session lost before the first question ("Sign in again", the cookie deleted or ended by the gateway) restores the route after signing in; one lost while open is a signed-out line; a frame gets one sentence and makes no request to the API                                                                                                                                                                        |
| `chat.spec.ts`        | the list (names, previews, unread, arrow keys, one pane on a phone), opening a chat, sending, Stop, the queue, drafts, a reply streamed in by the gateway, a socket dropped mid-reply (one bubble, the gateway's words once) and idle, and 2,000 rows of history (opens at the bottom without moving, pinned, reading above, older history)                                                                                                                                                                                             |
| `requests.spec.ts`    | approval and clarify with the keyboard alone, deny, several at once, another bot's, one answer for several, smart-denied, a batch's Cancel all, withdrawn, restored on resume and after a reload, a modal page behind them, 320 px                                                                                                                                                                                                                                                                                                      |
| `attachments.spec.ts` | attach by the picker and by a drop (a file and an image), send, the chip in the bubble and the agent's reply naming the file; Return twice sends once (HERM-126); cancel an upload in flight; axe with chips and the drop target                                                                                                                                                                                                                                                                                                        |
| `a11y.spec.ts`        | axe, serious and critical, in light and dark: the chat list, a chat, the signed-out screen and every request sheet                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `passkey.spec.ts`     | Chromium only (a virtual authenticator over the DevTools `WebAuthn` domain): enrol with a code from `/__fake/passkey/code`; a confirmation raised with `/__fake/request`, confirmed, and read back as `verified: true` from `/__fake/state` `passkey.outcomes`; decline; a key the gateway cannot verify (`signature_invalid`, then `too_many_attempts`); a passkey revoked while open (`verification_failed`); a request still open after a reload; Escape; the detail's `white-space: pre` and sideways scroll; axe in light and dark |

```sh
npx playwright install chromium webkit firefox        # once
npm run client:e2e                                    # all three engines
npm run e2e:chromium --workspace @hermie/web-client   # one engine
npm run e2e --workspace @hermie/web-client -- --project=webkit signin.spec.ts
```

Two things differ by engine and are handled in the specs, not hidden: WebKit logs a dropped socket on the console
(the dropped-socket tests allow that one message), and Safari on macOS tabs only to links and fields, so the
keyboard test reaches the approval button with Option+Tab there. CI runs each engine in a job of its own
(`web-client-e2e`, on `ubuntu-24.04`, a failed test's trace uploaded); no path filter, so the check always reports.
The Firefox build that Playwright ships does not start on every macOS; the CI job is where Firefox runs.

## Layout

```
index.html                  the document: policy, one module script, empty #root
vite.config.ts              base './', hashed assets, ASCII output, maps out of dist, dev server and proxy
vitest.config.ts            jsdom, fixed stand-ins for the injected version and commit
playwright.config.ts        the browser suite: three engines, no web server (e2e/fixtures.ts starts a gateway per test)
playwright.perf.config.ts   the performance suite: three engines, the harness server
tsconfig.json               the client's code (DOM); tsconfig.node.json: the config files (Node);
                            tsconfig.e2e.json: the Playwright configuration and specs
e2e/perf/                   the transcript list's performance suite and its trace reader
e2e/                        the browser suite: fixtures.ts, signin, chat, requests and a11y specs
scripts/
  write-build-manifest.mjs  dist/build.json
  source-commit.mjs         which commit this build is of (shared by the config and the manifest)
src/
  main.tsx                  the boot sequence and its screens (with dev/, the only React outside features/ and ui/)
  boot/                     frame guard, base path, auth mode and cookie session, sign-in bounce, boot
  core/                     the connection and its lifecycle, the roster controller, the advert, the chat
                            controller and the ingest (above); core/passkey/, the passkey level
  state/                    zustand vanilla stores: connection, bots, plugin, chats, settings, requests
  platform/                 the browser seams (above)
  features/chat/            the chat screen, its item views, the transcript list, its scroll anchor and chunks, the composer
  features/requests/        the request layer: approval, clarify and the passkey confirmation, one at a time, in a
                            modal dialog; the passkey notices
  features/settings/        the passkeys page (the rest of Settings is W-20b's)
  dev/                      development-only pages: the transcript harness, its probes, a stream replayer
  test-support/             test doubles: an IndexedDB, a fetch, a fetch with a cookie jar, a chat
                            gateway, the page's visibility and network, and a copy of the Expo app's
                            reader's-own-chat directory for the sub-chats test
  markdown/                 a message as React elements (above)
  dev/                      development-only pages, not reached by the build (dev/markdown.html serves one)
  features/                 what a person sees: shell/ (router, frame, connection line, session), bots/ (the list),
                            chat/ (the screen)
  build-info.ts             version and commit injected by the build
  ui/                       theme.css (tokens), primitives/ and icons.tsx, base.css (the boot screens)
```

The bundle gate and the reproducibility check live in the repository's `scripts/web/`, because they are
about what leaves this directory rather than about the client itself.

Rules the lint configuration already enforces for `src/`: `core/`, `state/` and `platform/` import neither
`react` nor `react-dom`; and there is no `dangerouslySetInnerHTML`, no assignment to `innerHTML` or
`outerHTML`, no `insertAdjacentHTML`, `document.write`, `eval` or `new Function`. A script-injection bug in a
page on the dashboard's origin would act with the signed-in person's session, which is why there is no way to
turn text into markup at all.

## Dependencies

Every third-party package, and why it is here. Anything beyond this list needs a decision first.

| Package                                                                              | Kind    | Why                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react`, `react-dom` (19.1.0)                                                        | runtime | the UI; the same version as the Expo app, so the ported logic runs on the React it was written against                                                                                                                                                      |
| `zustand` (5.0.15)                                                                   | runtime | the stores the ported controllers already use, read by the screens with `useStore`; about 1 kB, no dependencies                                                                                                                                             |
| `@hermes/shared`, `@hermie/gateway-client`, `@hermie/transcript`, `@hermie/markdown` | runtime | this repository's own packages (wire contract, gateway connection, transcript engine, Markdown core); used as they are. `@noble/hashes` comes in through `@hermie/gateway-client`. The boot uses `@hermie/gateway-client` (probe, cookie session, identity) |
| `@hermie/fake-gateway`                                                               | dev     | this repository's stand-in gateway; the boot's integration test and the chat screen's Playwright suite run it in process                                                                                                                                    |
| `vite` (7.3.6)                                                                       | dev     | the bundler and dev server                                                                                                                                                                                                                                  |
| `@vitejs/plugin-react` (5.1.4)                                                       | dev     | the JSX transform and fast refresh                                                                                                                                                                                                                          |
| `vitest` (3.2.7), `jsdom` (26.1.0)                                                   | dev     | unit and component tests in a simulated browser; `vitest` is also what the rest of the repository tests with                                                                                                                                                |
| `@testing-library/react` (16.3.3), `@testing-library/dom` (10.4.2)                   | dev     | component tests that query by role and text rather than by implementation; `@testing-library/dom` is a required peer of the React package                                                                                                                   |
| `axe-core` (4.13.0)                                                                  | dev     | the accessibility checker the Markdown fixture page and the chat screen are tested with (`*.axe.test.tsx`, and run in the browser by `@axe-core/playwright`, where contrast can be measured); MPL-2.0, test-only, not in the bundle                         |
| `@axe-core/playwright` (4.13.0)                                                      | dev     | axe on a Playwright page: the accessibility specs (`e2e/a11y.spec.ts`); it depends on `axe-core` at the same minor, so the two cannot drift apart; MPL-2.0, test-only, not in the bundle                                                                    |
| `@types/react`, `@types/react-dom`                                                   | dev     | type definitions for React                                                                                                                                                                                                                                  |
| `@playwright/test` (1.63.0)                                                          | dev     | the end-to-end and performance suites in Chromium, WebKit and Firefox (plan, "Constraints"): the transcript list's and the chat screen's                                                                                                                    |
| `typescript`, `eslint`, `prettier`                                                   | dev     | from the repository root, shared with every workspace                                                                                                                                                                                                       |

Not added yet, because nothing uses it: the pre-approved `@tanstack/react-virtual` (the transcript list did not need it, see "Measured" above).
`@hermie/markdown` brings `marked` (and `highlight.js`, which nothing here imports
yet) into the bundle once a screen renders a message. The licence text of every
runtime dependency is meant to ship in `dist/licenses.json` and be shown in About; that is not generated yet.
