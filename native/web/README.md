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
answer a bot's approval or question from it ("The composer" and "Requests" below). It has no attachments, no secret
prompts and no settings yet, and the plugin does not serve this build. Until that
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
| `npm run client:test`               | the client's unit and component tests (vitest, jsdom, Testing Library)                                           |
| `npm run client:check-bundle`       | the gate on `dist/` (below); `-- --commit <sha>` also requires `build.json` to name that commit                  |
| `npm run client:check-reproducible` | builds twice from clean and compares every file; `-- --fresh-checkout` adds a build from `git archive HEAD`      |
| `npm run client:guard-scan`         | the Hermes plugin scanner over `dist/`, fork and upstream at pinned commits (below)                              |
| `npm run client:e2e`                | the black-box and accessibility suite on the built client, in Chromium, WebKit and Firefox ("The browser suite") |
| `npm run client:e2e:perf`           | the transcript list's performance suite on the harness, in the same three engines ("The harness and the suite")  |

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
  (the shared Markdown package has such a literal: a pair of curly quotes in a character class).
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
   anywhere else. A 401 or 403 is "Sign in again", which stashes the route and goes to
   `<prefix>/login?next=<this page>`; any other failure says what failed, with "Try again".
6. **Signed in**: if the stored state was written for somebody else, it is cleared first
   (`claimForOwner`). Sign-out is `POST /auth/logout`, then the transcript cache and every identity-bound
   setting are cleared, then `/login`.

`boot/boot.ts` is that sequence as one function with a typed outcome (`unreachable`, `token_mode`,
`needs_signin`, `signed_in`); `main.tsx` only renders it. `boot/boot.integration.test.ts` runs it against the
fake gateway in cookie mode.

### Browser storage

Nothing in it is a credential: the session is the gateway's `HttpOnly` cookie, which the client cannot read.

| Where                                               | Key or name                          | What                                                                  | On sign-out |
| --------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- | ----------- |
| `localStorage` (`platform/key-value-store.ts`)      | `hermie:<base path>:device.*`        | device settings (scheme, tint, text size, installation id)            | kept        |
| `localStorage`                                      | `hermie:<base path>:<anything else>` | identity-bound state (watermarks, layout, the owner's author id)      | cleared     |
| `localStorage`                                      | `hermie:<base path>:draft.<chat>`    | what was typed in a chat and not sent                                 | cleared     |
| IndexedDB `hermie-cache` (`platform/chat-cache.ts`) | rows keyed `<base path>:<bot>`       | transcript snapshots and the roster, in the Expo cache's record shape | cleared     |
| `sessionStorage`                                    | `hermie:<base path>:route`           | the route, across one sign-in                                         | cleared     |

`<base path>` is the prefix, or `/` at the root, so two gateways behind different prefixes on one host keep
apart. A key is identity-bound unless it starts with `device.`, so a key nobody classified is cleared rather
than left for the next person. The language choice is still stored by `src/i18n/locale.ts` under its own
key, `hermie.language` (docs/i18n.md). A browser that refuses a store gets a page that works and forgets:
values are kept in memory, and the cache falls back to memory on its first failure.

### Seams

Nothing outside `src/platform/` and `src/boot/` touches `window`, `localStorage`, `sessionStorage`,
`indexedDB`, `navigator`, `location` or `history` (lint; the development-only pages in `src/dev`, which never
reach the bundle, are exempt). Each seam takes its browser object as an argument, so the tests hand in their
own:

| Seam                                                  | What                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `platform/key-value-store.ts`                         | `createKeyValueStore({ namespace })`: the Expo store's contract, namespaced |
| `platform/chat-cache.ts`                              | `chatCacheFor(namespace)`: IndexedDB, falling back to memory                |
| `platform/net-info.ts`                                | `networkWatcher`: `online` / `offline`                                      |
| `platform/visibility.ts`                              | `visibilityWatcher`: `visibilitychange`, `pagehide`, `pageshow`             |
| `platform/socket.ts`                                  | `createSocketFactory()`: the page's `WebSocket` for `GatewayConnection`     |
| `platform/layout.ts`                                  | `layoutClock`: `requestAnimationFrame` and `ResizeObserver` for the lists   |
| `platform/clipboard.ts`, `page-title.ts`, `random.ts` | copy, the tab's title, `crypto.getRandomValues`                             |

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

| Route                      | Heading        | Main pane today                   |
| -------------------------- | -------------- | --------------------------------- |
| `#/`                       | Hermie         | "Pick a conversation to start..." |
| `#/chat/<bot>`             | the bot's name | the chat (`ChatScreen`)           |
| `#/chat/<bot>/s/<session>` | the bot's name | that conversation (`ChatScreen`)  |
| `#/settings[/<section>]`   | Settings       | placeholder (W-20b)               |
| anything else              | sent to `#/`   |                                   |

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

| File               | What                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `ChatScreen.tsx`   | the wiring: rows, scroll position, older history, read marking, announcements, the states of a chat      |
| `use-open-chat.ts` | opens the route's chat when the connection is `ready`, leaves it on the way out, retries after a failure |
| `ChatHeader.tsx`   | the line under the bot's name: its presence bead and what it is doing (the chat list's own rules)        |
| `rows.ts`          | from `visibleItems` to the list's rows: date separators, the status line while busy, the typing row      |
| `JumpToLatest.tsx` | the button over the bottom of the transcript, with how many messages arrived while the reader was above  |
| `items/*.tsx`      | one view per item kind (below), each `React.memo` on `(id, version, presentation)`                       |
| `chat.css`         | the screen and its views, on the theme's tokens                                                          |

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

| Item               | View                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`             | a bubble on the right in the tint, Markdown, clock, "Sending..." until the gateway has it; somebody else's in the group chat is on the left with their name                        |
| `assistant`        | a bubble with Markdown; the typing dots in the same bubble until words arrive; usage and duration footer; a failure card under the words that arrived; interim and reply-to labels |
| `tool`             | one collapsed line (name, what it did, how long or "Running..."); a click opens arguments and result as plain text; silent tools (`todo`) draw nothing until they fail             |
| `notice`, `status` | centred, quiet lines, never a bubble; a notice with a body is a disclosure (a command's answer opens itself, an error keeps the danger tint); the latest status only while busy    |
| date separator     | an `h2` row at the first row of each day (a row of its own, keyed by the day and the row it opens)                                                                                 |
| typing row         | the dots, while the turn runs and the last thing drawn is the reader's own message                                                                                                 |
| the rest           | a plain line saying what it is (`OtherRow`) until W-18a: a teammate bot's message and dispatch, a cron delivery, a subagent fan-out, an approval, a clarify                        |

Gateway-injected rows are notices, never the reader's own bubble. Everything the gateway or an agent wrote that is
not Markdown (tool arguments, results, notice bodies, a teammate's message) is shown as characters.

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
| `composer.css`    | the composer, the completions and the queue, on the theme's tokens                                     |

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
- **Attachments** are W-19's. `ChatScreenController` already carries `uploadFile`; nothing calls it.

## Requests

A bot's approval or question (`clarify`) is answered in `features/requests/`, a modal layer over the whole page
(`<RequestLayer />` in `App`, beside the frame), never in the transcript, where a row scrolls away.

| File                | What                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `state/requests.ts` | `requestsStore`: the open requests of every chat, oldest first; `bindRequests(chatsStore)`  |
| `RequestLayer.tsx`  | the dialog, focus, the inert page, the polite announcements; answers through the controller |
| `ApprovalSheet.tsx` | the command and Allow / Deny, the gateway's `choices`                                       |
| `ClarifySheet.tsx`  | one question or a stepper over a batch: choices, free text, multi-select, Lock, Skip        |
| `request-layer.css` | the scrim, the dialog and the sheets                                                        |

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
- **Clarify.** A single question with choices (radio), several (checkbox, joined with ", ") or free text, which edit the
  same one answer. A batch is a stepper: Next, Back, and Lock answer (`lockClarify`: locked on the gateway, then
  read-only). **Skip answers `''`**: on a single question, "no answer" for the bot; in a batch, that step, moving on, and
  on the last step sending every answer. Command or Control+Return in the field answers.
- **Plain text.** The command, description, tool name, question and choices are the gateway's and an agent's words and
  are never Markdown here.
- **Said aloud.** A request that left without the reader's answer (withdrawn, or timed out) is announced in a polite
  region beside the dialog ("The request from <name> was withdrawn."); a failure to deliver an answer is an alert.
- **Secret, sudo, vault and `confirm` prompts** are W-14 and W-15; the queue's type is a union for them, and nothing of
  them is handled here.

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
| the page behind the layer is inert; 320 px wide does not scroll sideways                                                        | inert; no overflow              |
| a request still open when the page is reloaded is asked again; axe (`e2e/a11y.spec.ts`) on every sheet, light and dark          | asked once more; no violation   |

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
- `app` (sign in, open a route, the field, Send, Stop, the dialog) and `seriousViolations` (axe with contrast).

| Spec               | What it proves                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signin.spec.ts`   | an unauthenticated visit goes to the gateway's `/login` and signing in opens the client; a wrong password stays; a session lost before the first question ("Sign in again", the cookie deleted or ended by the gateway) restores the route after signing in; one lost while open is a signed-out line; a frame gets one sentence and makes no request to the API |
| `chat.spec.ts`     | the list (names, previews, unread, arrow keys, one pane on a phone), opening a chat, sending, Stop, the queue, drafts, a reply streamed in by the gateway, a socket dropped mid-reply (one bubble, the gateway's words once) and idle, and 2,000 rows of history (opens at the bottom without moving, pinned, reading above, older history)                      |
| `requests.spec.ts` | approval and clarify with the keyboard alone, deny, several at once, another bot's, withdrawn, restored on resume and after a reload, a modal page behind them, 320 px                                                                                                                                                                                           |
| `a11y.spec.ts`     | axe, serious and critical, in light and dark: the chat list, a chat, the signed-out screen and every request sheet                                                                                                                                                                                                                                               |

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
                            controller and the ingest (above)
  state/                    zustand vanilla stores: connection, bots, plugin, chats, settings, requests
  platform/                 the browser seams (above)
  features/chat/            the chat screen, its item views, the transcript list, its scroll anchor and chunks, the composer
  features/requests/        the request layer: approval and clarify, one at a time, in a modal dialog
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
