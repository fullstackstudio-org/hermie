# Hermie in the browser

`@hermie/web-client`: a browser client of the Hermes gateway, written in React, Vite and TypeScript, with no
Expo and no React Native Web. It is meant to be a pure client, exactly like the native apps, and to be
served by the gateway itself through the `hermie` plugin, on the gateway's own origin. The decision and
the threat model that follows from it are in
[ADR-0030](../../docs/adr/0030-web-client-served-by-the-plugin.md).

**Status: a chat you can read.** What exists is the build, its checks, the boot, the frame of the app and the chat
screen: the client refuses to run in a frame, finds its gateway from its own address, probes it, reads who is
signed in on the gateway's own session (or, on a gateway without sign-in, reads its session token from the dashboard's own page and keeps it in memory only), connects, shows the chat list in a two-pane layout with a router and a
theme ("The shell" below), and opens a chat in the main pane and streams it ("The chat screen" below): bubbles
with Markdown, tool calls, notices, date separators, older history, jump to latest. You can send, stop a reply and
answer a bot's approval or question from it ("The composer" and "Requests" below), and confirm a sensitive action with
a passkey that the gateway verifies itself ("Passkeys" below), and answer a bot's secret, sudo and password-manager
prompts ("Secret prompts" below), and attach files and images by the picker, a paste or a drop ("Attachments" below). A bot's past conversations and branches have a page of their own, a new conversation can be started there, and the chats field searches names and every bot's messages ("Conversations and search" below).
The chat list's arrangement, the mutes and the text size follow the person through the gateway's `ui_meta`
("Settings that follow the person" below), and Settings has a screen for each of them and for the rest of what a person
sets here: the account, the gateway, passkeys, MCP, what a chat shows, the chat list, the look and the language, and
the build ("Settings" below). The `hermie` gateway plugin serves this build
([docs/web.md](../../docs/web.md)); the Expo app's web export, which the standalone Hermie Web server used to
serve, is gone.

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
| `npm run client:guard-scan`         | the Hermes plugin scanner over `dist/`: the fork blocks, upstream is informational (below)                       |
| `npm run client:e2e`                | the black-box and accessibility suite on the built client, in Chromium, WebKit and Firefox ("The browser suite") |
| `npm run licences:web`              | writes `public/licenses.json` from the client's dependency tree; `licences:web:check` fails when it has drifted  |
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
  script, no inline style, nothing but this origin, Trusted Types required and one Trusted Types policy allowed
  (`hermie-service-worker`, which turns nothing into a script URL but `./sw.js`; see "Web Push"). `frame-ancestors` cannot be set
  from a meta element, so refusing to render in a frame is the entry module's job (see "Boot").

### `licenses.json`

`public/licenses.json` is copied to `dist/` as it is (Vite's public directory) and is what Settings, About reads: every
production dependency of the client, the licence each declares and the text it carries, identical texts stored once
by hash. It is generated, not written: `npm run licences:web` walks the client's dependency tree in `package-lock.json`
(`scripts/generate-third-party-licenses.mjs --web`, the Expo app's generator pointed at this workspace) and
`npm run licences:web:check` fails when the file has drifted; `scripts/web/licences.test.ts` runs that check with the
rest of the repository's tests. The bundle gate refuses a non-ASCII byte in a JSON file, so every character above U+007F
is written as a `\uXXXX` escape (the same text once parsed). The repository's own packages are not in it: they are the
code under its own licence.

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
  `import()` does not count) is over 600 kB, or 190 kB gzipped (the plan's budget is 700 kB / 230 kB; the gate is
  held just over the actual weight so that a regression fails at once, and `src/entry-graph.test.ts` fails, naming
  the import chain, when the entry reaches a module that is loaded on demand);
- `index.html` has no policy, a policy that is not exactly the reference set written in the gate (every directive
  and source of the plan's W6, plus `trusted-types hermie-service-worker`, the one policy name the client creates,
  for its service worker's address; one missing or extra fails), a `<script>` or `<link>`
  before the policy element, or inline script, a style element, a `style` attribute or an inline handler;
- `build.json` is missing, malformed, not in canonical form, or does not match the files: a changed byte, a
  missing file or an unlisted file;
- a text file holds `hermie:development-only`, the stamp every development-only page (`src/dev`) puts on its
  own document: one of them was imported by the client.

It prints what it measured against each limit.

### What the first load carries

The limit is not to be raised to make room: what the first screen (signing in, the chat list, an open chat) does not
draw is kept out of the entry instead. These do that today.

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
- **The sheets' own words** (`src/i18n/sheet-strings.ts`, the same table as `web-strings.ts`) travel with them, and
  the settings pages' words are in it too. Only a module that is itself loaded on demand may import that file.
- **Settings** is one chunk (`features/settings/SettingsHost.tsx`: the home, the way back, the section a route names),
  fetched when a settings route is opened or when the sidebar's link to it is pointed at or focused
  (`features/settings/load.ts`, the only part the entry imports), and each section is a chunk inside it (`Account`,
  `Gateway`, `Passkeys`, `MCP`, `Chats`, `Arrangement`, `Appearance`, `About`, each with its styles), fetched when it is
  opened or when its link on the home is reached. The pages' words are in `sheet-strings.ts` with the rest of what a
  chunk says; the catalogue's words they read (the Expo app's titles for Account, Chats, Appearance and About, the
  layout words of the chat list) are the entry's English and a chunk per other language, as every catalogue read is.
- **The chat screen** is a chunk of its own (`features/chat/ChatScreen.tsx` and everything only it draws: the
  transcript list, the item views, the Markdown renderer and `marked`, the composer, the message menu's layer, the
  attachment tray, find in chat, and the styles of those; `features/chat/load.ts` is the only part the entry imports).
  `App` draws the frame and the list without it, asks for the chunk once it has drawn (`preloadChatScreen`), and shows an
  empty, `aria-busy` main pane under a `Suspense` boundary for a chat route that is opened before it has arrived (`Layout`
  moves focus to the main heading on a route change, and does not wait for the screen). The frame's own rules for a
  chat route (`.hm-main[data-screen='chat']`, in `features/shell/shell.css`) stay in the first load. The chat controller,
  the transcript reducer and the models beside it are not part of this: they start with the session. Keep the entry
  free of imports from `features/chat/` other than `load.ts`, `chat-runtime.tsx`, `drafts.ts`, `use-own-author.ts` and
  `PersonAvatar.tsx`.
- **What a chat opens on request** is a chunk of its own through `React.lazy`: the message menu
  (`MessageMenuPopup.tsx`, fetched the first time the reader points at a message or moves to one), the chat options'
  panel (`ChatOptionsPanel.tsx`, fetched when its button is pointed at or focused) and the image viewer
  (`ImageViewer.tsx`, fetched when a picture is opened).

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
- each pin has a `gate`. The fork is `blocking`: it passes only on a verdict of `safe` that the install would allow
  outright (`caution` fails). Upstream is `informational`: it runs, its verdict and findings are printed and go into
  the step summary, and only `dangerous` from it fails. There is no threshold of its own;
- a gate that cannot run does not pass: a scanner of either kind that cannot be fetched or imported or that prints
  no result (nobody can then say it would not have answered `dangerous`), a directory that is not a build (no
  `index.html` or `build.json`, almost no files) and a run in which no blocking scanner ran all fail; a report line
  that could start a workflow command is made harmless before it reaches the log.

**Why the fork decides (plan W3, amended for HERM-192).** The gateway protocol's secure prompt is literally the
server request `sudo` (`ServerRequestMap.sudo`), so a bundle that relays it carries `"sudo"` as an object key and in
comparisons. Both scanners judged that line by line, and in minified JavaScript (lines kilobytes long, opening inside
a template a previous line began) they read it as a HIGH `sudo_usage`, a `caution` verdict, whatever the code does
with it. Spelling the word some other way to get past them is ruled out: the scanner exists to protect the people
who install the plugin. The fork scanner, which is what the gateways run, lexes `.js` files whole instead and
judges each `sudo` by its token: a key, a comparison or a plain property value that is handed to nothing is a
visible `low` finding, but only in a plugin whose JavaScript names no process, eval or module-loading route (and
only when the lexer is sure of the file; any doubt keeps the line rules' severity). A highlighter's
`.exec("")` (`exec_string`) is judged the same way, on a regex literal or any other receiver. Upstream keeps the old
reading, so its `caution` is expected; an upstream `caution` only means an install asks to be confirmed.

What the fork's rule does not claim (accepted limits, written down in `tools/plugin_guard_context.py`, rule 5b):

- the "nothing can run" inventory is a denylist with known gaps, not a proof; it only ever decides whether a
  `sudo_usage` or a member `exec_string` finding drops to `low`, and every other finding is untouched. The browser's
  own code-from-string routes (an inserted `<script>` element, a `javascript:` URL, `setAttribute("on…")`,
  `innerHTML`) are not on the list: they run in the page, not on the host;

- it reads JavaScript only: a Python or shell file of the plugin that hands JS data to a process is not counted
  (those files are judged by their own rules);
- directories the scanner never reads (`node_modules`, `.venv` and the rest of `EXCLUDED_DIRS`) are invisible to
  it, as they are to the whole scan;
- a route to a process built without any name the inventory knows, and a value reaching it through a variable,
  cannot be seen; "stays HIGH" holds for the routes the inventory names (process and eval sinks, `require`,
  dynamic and remote `import`, `getBuiltinModule`, `Module._load`, `vm`, `inspector`, `wasi`, `worker_threads`,
  shell tags, a replaced `RegExp.prototype.exec` …);
- it is not the only demotion: the scanner's per-line rule already lowered a whole `"sudo"` string on a line that
  runs nothing to `medium`.

To try a scanner change before its commit is pinned, point the pin at a checkout; the other pins are still fetched:

```bash
npm run client:guard-scan -- --scanner-root fork=../hermes-agent
npm run client:guard-scan -- --scanner-root fork=../hermes-agent --only-roots   # that checkout alone, offline
```

Both options are refused when `GITHUB_ACTIONS` is set: in CI only the pinned scanners decide.

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
4. **Probe** (`boot/auth-mode.ts`): `GET /api/status`. `auth_required: false` is a gateway without sign-in,
   which authenticates with one session token; see "Gateways without sign-in" below. Otherwise:
5. **Identity**: `GET /api/auth/me` on the gateway's `HttpOnly` cookie session, sent `same-origin` and never
   anywhere else. A 401 is "Sign in again", which stashes the route and goes to
   `<prefix>/login?next=<this page>`; a 403 is not (the gateway says 401 for a lapsed session, so a 403 is a proxy
   or firewall in front of it, and a sign-in would reload into the same 403): it and any other failure say what
   failed, with "Try again".
6. **Signed in**: if the stored state was written for somebody else, it is cleared first
   (`claimForOwner`). Sign-out is `POST /auth/logout`, then the transcript cache and every identity-bound
   setting are cleared, then `/login`. The other tabs on this gateway are told first (below, "Other tabs").

`boot/boot.ts` is that sequence as one function with a typed outcome (`unreachable`, `needs_signin`,
`signed_in`, and for a gateway without sign-in `needs_token`, `token_ready`); `main.tsx` only renders it.
`boot/boot.integration.test.ts` runs it against the fake gateway in cookie mode and in token mode.

### Gateways without sign-in

A gateway whose dashboard has no sign-in (`auth_required: false`) lets in whoever has its session token, and
hands that token to the pages it serves by writing it into the dashboard's own `index.html`
(`window.__HERMES_SESSION_TOKEN__="<token>";`). The client does what the dashboard does. **It reads the
dashboard's own bootstrap, so the token is exactly as public as the dashboard on that gateway**: whoever can
open the dashboard there can read it, and the client adds no exposure and no protection of its own. A gateway
that wants more puts sign-in in front of the dashboard, and then none of this runs.

1. **Read** (`boot/dashboard-token.ts`): `GET <prefix>/`, same origin, `cache: 'no-store'`, no redirect
   followed. The value is taken only in one form: a double-quoted string of URL-safe characters (letters,
   digits, `-`, `.`, `_`, `~`), at most 512, then `;`, the same in every assignment on the page, on a page that
   does not say `__HERMES_AUTH_REQUIRED__=true`. Anything else is no token.
2. **Check** (`checkToken`): `GET /api/profiles` with the token, which an ungated gateway answers only with the
   right one (the native apps' check). `/api/auth/me` is never asked: nobody is signed in on such a gateway.
3. **The prompt** (`features/shell/TokenPrompt.tsx`), when the page had no token or the gateway refused it: a
   masked field (`type="password"`, `autocomplete="off"`, the password-manager opt-outs, no `name`, no
   `<form>`), uncontrolled and emptied the moment Continue reads it. A refused token is one sentence and an
   empty field; "Read it from the dashboard again" runs the boot from the probe.
4. **Running**: the app on `SessionTokenCredentials`, `X-Hermes-Session-Token` on every REST call and
   `?token=` on the socket, which is what the gateway accepts there and what the native apps send. Nobody is
   named: the sidebar says there is no sign-in, the stored state and `ui_meta` are the owner's (`owner`, as on
   the other clients), and Settings says plainly that Passkeys and MCP need sign-in.
5. **A restart.** The fork mints a new token for every server process, so a restart refuses the page's token
   and the connection stops at `needs_signin`. The first time, the client reads the dashboard again by itself
   (`boot/token-recovery.ts`), as the dashboard reloads once: a new token that is taken starts the app over on
   it, and a gateway that turned sign-in on meanwhile goes to the cookie flow. The same token, or none, leaves
   the connection line's "Read it from the dashboard again" as the way back.
6. **The way out** is "Forget the token": the session stops, the token is dropped with it, the other tabs are
   told (below), the transcript cache and the identity-bound settings are cleared as on a sign-out
   (`forgetToken`), and the prompt is shown. The gateway is not told: it has nothing to end, and its token stays
   valid until it restarts.

### Other tabs

Signing out and forgetting the token clear what this browser keeps for the gateway, so every tab of the client
on it has to stop, not only the one clicked in. The tab that leaves posts `forget` on a `BroadcastChannel`
named per base path (`hermie:<namespace>:session`, `platform/tab-channel.ts`); the message carries nothing
else. Every other tab on the same gateway stops its session and drops its credentials, clears the same state
(whatever it wrote meanwhile included), and shows the token prompt, or the signed-out screen on a gateway with
sign-in. A browser without `BroadcastChannel` falls back to the gateway refusing the other tabs at their next
dial.

**Where the token is.** In the `SessionTokenCredentials` the boot made, and in the connection built on it:
memory only, for as long as the tab is open. It is never written to `localStorage`, `sessionStorage`,
IndexedDB, a cookie, the transcript cache, a log line, an error or the auth timeline, and it appears in no URL
but the socket's `?token=` (the one place the gateway takes it on a socket; the browser may show that URL in
its own developer tools, as it does for the dashboard). `e2e/token-mode.spec.ts` checks all of that in a
browser against the fake gateway in `--auth token`.

### Browser storage

Nothing in it is a credential: the session is the gateway's `HttpOnly` cookie, which the client cannot read,
and on a gateway without sign-in the session token is held in memory only (above).

| Where                                               | Key or name                                        | What                                                                                    | On sign-out |
| --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| `localStorage` (`platform/key-value-store.ts`)      | `hermie:<base path>:device.*`                      | device settings (language, scheme, tint, text size, `transcriptCache`, installation id) | kept        |
| `localStorage`                                      | `hermie:<base path>:<anything else>`               | identity-bound state (watermarks, the owner's author id)                                | cleared     |
| `localStorage`                                      | `chats.layout`, `app.chosen`, `ui-meta.pending`    | the arrangement, its date, unsent bot edits ("Settings that follow")                    | cleared     |
| `localStorage`                                      | `hermie:<base path>:draft.<chat>`                  | what was typed in a chat and not sent                                                   | cleared     |
| `localStorage`                                      | `hermie:<base path>:device.passkey.pin@<base URL>` | the gateway id pinned on the first passkey enrolment ("Passkeys")                       | kept        |
| `localStorage`                                      | `hermie:<base path>:passkey.seen@<base URL>`       | the signed-in person's passkey ids this browser has seen                                | cleared     |
| IndexedDB `hermie-cache` (`platform/chat-cache.ts`) | rows keyed `<base path>:<bot>`                     | transcript snapshots and the roster, in the Expo cache's record shape                   | cleared     |
| `sessionStorage`                                    | `hermie:<base path>:route`                         | the route, across one sign-in                                                           | cleared     |

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

| Seam                                                  | What                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `platform/key-value-store.ts`                         | `createKeyValueStore({ namespace })`: the Expo store's contract, namespaced     |
| `platform/chat-cache.ts`                              | `chatCacheFor(namespace)`: IndexedDB, falling back to memory                    |
| `platform/net-info.ts`                                | `networkWatcher`: `online` / `offline`                                          |
| `platform/visibility.ts`                              | `visibilityWatcher`: `visibilitychange`, `pagehide`, `pageshow`                 |
| `platform/socket.ts`                                  | `createSocketFactory()`: the page's `WebSocket` for `GatewayConnection`         |
| `platform/layout.ts`                                  | `layoutClock`: `requestAnimationFrame` and `ResizeObserver` for the lists       |
| `platform/clipboard.ts`, `page-title.ts`, `random.ts` | copy, the tab's title, `crypto.getRandomValues`                                 |
| `platform/webauthn.ts`                                | `navigator.credentials.create/get` and `crypto.subtle` for the passkey level    |
| `platform/passkey-pins.ts`                            | the passkey pins (above), and other gateways' pins on this origin               |
| `platform/tab-channel.ts`                             | the other tabs on this gateway: `forget` on a `BroadcastChannel` ("Other tabs") |
| `platform/files.ts`                                   | a file's bytes as base64, the files of a drag, the stray-drop guard             |

## Connection

`src/core/` and `src/state/` hold the session layer, ported from the Expo app by copy (plan W7): same names,
same store shapes, and every deliberate difference noted at the top of the file it is in. None of it imports
React; screens will read the stores through `useStore`.

| File                                          | What                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `core/gateway-client.ts`                      | the connection on the boot's session (cookie or token), its lifecycle, and `connectGateway` (below) |
| `core/bots-controller.ts`                     | the roster's round trips: `profiles.list`, avatars, running state, the canonical Bot Chat           |
| `core/link.ts`                                | `ChatGateway`, the slice of the connection the chat layer sees                                      |
| `core/advert.ts`                              | the plugin advert plus the web-only `web`, `webPush.publicKey` and `modules.web`                    |
| `core/rpc-failures.ts`                        | the ring of gateway refusals a screen absorbed                                                      |
| `state/connection.ts`, `bots.ts`, `plugin.ts` | zustand vanilla stores: status, roster and watermarks, advert                                       |

`connectGateway({ baseUrl, credentials, storage, cache })` takes the boot's session (`signed_in`, or `token_ready` on a gateway without sign-in) and keeps one
`GatewayConnection` alive: it dials when the page is first visible, closes the socket after the page has been
hidden for more than 60 seconds, and on return dials again with a fresh ticket, which replays every session it
holds a watermark for. Network reports are advice: offline labels the status and takes a live socket down,
online cuts the backoff short, and neither stops the dial ladder (the gateway may be on the same machine). A
connection that stopped because the session lapsed (`needs_signin`) is left alone. The roster is painted from
the cache, read again on every arrival at `ready`, and the plugin advert is taken off the same answer. `stop()`
closes the socket and empties the stores; call it before signing out. The rules in full are at the top of
`core/gateway-client.ts`; `core/gateway-client.integration.test.ts` runs them against the fake gateway in
cookie mode, dropped sockets included.

## Settings that follow the person (`ui_meta`)

The chat list's arrangement (order, folders, pins, archive, per-chat colour, the reader's own names for bots,
which conversation each bot is on), the mutes and the transcript's text size live in the gateway's `ui_meta`,
exactly where the Expo and Swift apps keep them (ADR-0016): a bot's `colour` on that bot's own `hermie` section,
everything else in the app-wide `hermie-app:<user id>` on the default profile. The archive is per account: the
person's `archivedBots` (bot names, sorted, no repeats) in that same section, the wire format the native client
uses. The stores are
what the screens paint from; `core/ui-meta-bridge.ts` mirrors them onto the gateway and back, and
`@hermie/gateway-client/ui-meta`'s `UiMetaSync` does the protocol (per-key compare-and-swap, one retry after a
re-read, the dated last-writer-wins, the per-person key, the bare `hermie-app` for the push rows of a plugin
without `ui_meta.per_user`). It never writes a key it does not own: not the plugin's `hermie-plugin`, not
another tool's `hermes-bots`.

| File                      | What                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `state/layout.ts`         | `layoutStore`: the arrangement and everything per chat; `chats.layout`, identity-bound                  |
| `state/folders.ts`        | the arrangement as a value: `normalise`, `readArrangement` (migrates dividers), the moves, accent names |
| `state/mute.ts`           | a mute is a deadline in unix seconds (`0` is forever): `muteUntil`, `isMuted`, `withoutExpired`         |
| `state/text-size.ts`      | `textSizeStore` and the scale; `device.textSize`, kept on sign-out like the scheme and the tint         |
| `state/app-stamp.ts`      | `appStampStore`: when this person last chose something (`updatedAt`, seconds); `app.chosen`             |
| `state/device-context.ts` | `deviceContextStore`: who the boot read; `uiMetaUserIdOf` builds the key's user id                      |
| `core/ui-meta-bridge.ts`  | `UiMetaBridge` (the mirror) and `connectUiMeta` (its wiring, started by `features/shell/session.ts`)    |

**For a screen (W-20b, built: Settings, Chat list and Appearance).** Change things through the stores' actions and nothing else; the bridge notices
every change by diffing, sends it (debounced 600 ms) and dates it. The actions:

- `layoutStore`: `moveBy`, `moveToFolder`, `dropBot`, `dropFolder`, `moveFolderBy`, `addFolder` (answers the
  id), `addFolderAround`, `renameFolder`, `setFolderColour`, `removeFolder`, `setFolderOpen` (this browser
  only), `setArchived`, `setPinned` / `togglePinned`, `setMyChat`, `setCurrent`, `setAccent` (`'default'` is no
  colour), `setLabel` (empty clears), `setMute(bot, untilSeconds | 0 | null)`, `dropExpiredMutes(now)`,
  `setSidebarCollapsed` and `setConversationsCollapsed` (this browser only). Read with the selectors
  `chatMuted`, `chatPinned`, `myChat`, `currentTargetOf`, `currentConversation`, `chatAccent`, `botLabel`,
  `archivedOf`, `foldersOf`, `botsInOrder` and `resolveSidebarCollapsed`.
- `textSizeStore`: `setTextSize`; `textSizeScale(size)` is the factor for the transcript's type.
- The bridge (`(await session.uiMeta)?.bridge`, a lazily loaded chunk): `mode` (`synced`, or `local` when the gateway cannot be read or refuses
  the write; the device's copy is then still correct), `pending`, `appKey`, `reconcileSoon()`, `flush()`.
- `uiMetaStatusStore` (`state/ui-meta-status.ts`, in the main bundle): `starting`, `synced`, `local` or
  `unavailable` (the bridge's chunk failed to load twice). A "settings not synced" line shows whenever
  `settingsSynced(state)` is false after `starting`.

What a screen does not do: call the bridge to send, write `appStampStore` (only the bridge dates), or treat
`collapsed`, `sidebarCollapsed` and `conversationsCollapsed` as synced (they are about this window).

**The rules** (the Swift app's `UIMetaDocuments` and `UIMetaState`, and the Expo app's bridge):

- The sections are held **raw**: every field this build does not know, every value it cannot read (a newer
  build's text size, a colour it has no swatch for) and every row another device wrote goes back as it came;
  an edit changes only the fields it names. The defaults, the name order and the theme have no store here and
  are carried like any unknown field (W11).
- A **choice** dates the app section; a **chore** (the roster folded in, lapsed mutes swept, a stale id
  forgotten: the layout store's `chores`) is sent undated. The newer date wins a reconcile, a tie goes to the
  gateway, undated on both sides keeps this page's copy, and a gateway without the section is seeded from it.
  A change made only of chores never wins over a section the gateway holds: it is dropped and the roster folded
  in again on top of what was taken.
- A write cleans only what it carried: an edit made while a send is out stays pending and goes in a further round.
- Taking a gateway's copy: its fields as they came, a field it no longer carries gone, except the fields a
  section can predate (`KEPT_WHEN_ABSENT`), which keep their held value. `updatedAt` is adopted as it arrived.
  The push rows come from where the notifier looks; this page writes only its own row and heartbeat into them
  ("Web Push").
- Retired fields travel no further: `context` (HERM-119) and Hermie Web's availability stamp in `push`
  (`endpoint`, `vapidPublicKey`, `version`, `daemonVersion`, `capabilities`, `relayOrigins`, `at`) are dropped
  the next time the section is written.
- **Archive is per account.** `setArchived` changes the person's `archivedBots`, dated like any other choice;
  two people on one gateway keep separate archives. A person whose section has no list yet is seeded once from
  the bots whose shared `hermie` section says `archived: true` (what the Expo app wrote), as a chore, so the seed
  never beats a section the gateway holds; after that the list is the only source. The shared flag is never
  written or cleared: the Expo app may still read it.
- A bot section left with nothing at all but `v` is sent as `null`, which removes it. A pending bot section is
  the gateway's section with this page's `colour` written in, so one carrying fields this page does not own (the
  shared `archived` flag among them) is never removed.
- **One departure from the Swift app**: when this page's copy wins, every field it does not project is the
  gateway's (taken when it has one, gone when it does not), since this build cannot have chosen anything about
  it; the same for a pending bot section beyond its `colour`. So a conflict never loses a field another
  build added meanwhile (`core/ui-meta-bridge.integration.test.ts`).
- The live roster is folded into the arrangement only while connected and after a reconcile that actually took the
  gateway's copy since the connection came up, and again after each one; a reconcile runs on every rise to
  `ready`, on `sessions.changed` and when the page is shown, never two at once.
- Bot edits the gateway has not taken survive a reload with their sections raw (`ui-meta.pending`); app edits
  survive by their date. Which of a pending bot's own fields changed is kept per bot (since the archive moved to
  the person's list, that is only `colour`), and only those are this page's when the section goes out.
- A bot whose section was written in a schema version this build cannot read (a newer build's `v`) is never
  written: a change to it stays pending, held back, and the console says so once.
- The bridge is a chunk of its own, loaded once the session has started (`session.uiMeta` is a promise of it). A
  chunk that fails to load is asked for once more after 2 s; failing again, it is logged and the status says
  `unavailable`, and the stores stay on this device.

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

| Route                        | Heading        | Main pane today                               |
| ---------------------------- | -------------- | --------------------------------------------- |
| `#/`                         | Hermie         | "Pick a conversation to start..."             |
| `#/chat/<bot>`               | the bot's name | the chat (`ChatScreen`)                       |
| `#/chat/<bot>/s/<session>`   | the bot's name | that conversation (`ChatScreen`)              |
| `#/chat/<bot>/conversations` | Conversations  | the bot's conversations (`ConversationsPage`) |
| `#/settings`                 | Settings       | the home: a link to each section ("Settings") |
| `#/settings/account`         | Settings       | who is signed in, Sign out                    |
| `#/settings/gateway`         | Settings       | this gateway, read only                       |
| `#/settings/passkeys`        | Settings       | this gateway's passkeys ("Passkeys")          |
| `#/settings/mcp`             | Settings       | this gateway's MCP access ("MCP")             |
| `#/settings/chats`           | Settings       | what a chat shows, the transcript cache       |
| `#/settings/chat-list`       | Settings       | the arrangement of the chat list              |
| `#/settings/appearance`      | Settings       | scheme, accent colour, language, text size    |
| `#/settings/about`           | Settings       | the build, the licences                       |
| `#/settings/<anything else>` | Settings       | the home; the address is rewritten in place   |
| anything else                | sent to `#/`   |                                               |

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

`features/bots/`: a link per bot (`#/chat/<bot>`), in the person's arrangement (below), with the bot's picture (the data URL
the roster read) or its initial, its name, the last real message of the chat (or the gateway's preview, or the
description), the time of the last activity, an unread marker and a presence bead. The rules are the native
apps': presence is one of four states by one precedence (`presence.ts`: offline, needs input, working, online),
offline shows when the bot was last heard from instead of a stale line, unread is the roster's `last_active`
against the per-bot watermark or the count of transcript messages past it, and a preview is
`chatRowPreview` of `@hermie/transcript` with the markdown taken off. The list's rows are one tab stop; the arrow keys,
Home and End move between rows (across groups, and from a group's header) and Enter follows the link. A row subscribes
to the stores with primitive selectors, so a streamed token re-renders its own row only.

**The arrangement in the sidebar.** `ChatList` reads the layout store (`entries`, `folders`, `collapsed`, `archived`,
`pinned`, `accents`, `mutes`) and the roster, and fetches nothing; what Settings, Chat list changes (or another device
sends through `ui_meta`) is drawn at once. `arrangement-list.ts` is the rule, as a function (`listView`), and it is the
native apps' (`ChatListArrangement` in `HermieCore`), with the folders those do not draw:

- **Order** is the arrangement's: the top level's loose chats and folders as `entries` holds them, a folder's chats in its
  own order. With no arrangement the list is the roster's.
- **The roster says which chats exist.** A chat the arrangement holds and the roster does not have is dropped, wherever it
  was. A chat the arrangement has not placed yet (new on the gateway, not folded in yet) is drawn at the end of the loose
  top-level run, before the first folder, in the roster's order (where `reconcileBots` writes it, so nothing jumps when the
  fold happens), never inside a folder. Settings' page uses the same place (`viewOf`).
- **Pinned** chats are held at the top of their container (the top level, or their folder) and carry a pin mark. Settings
  has no pin control; the field is written by the native apps and read here.
- **Folders** are groups: a header (one button, `aria-expanded`, named by the folder and with its colour as a dot) over a
  nested list named for the folder. Enter, Space and a click open and close it, Right and Left too; the state is
  `layoutStore.setFolderOpen`, this browser's and kept through a reload. A folder with nothing to show (empty, or every chat
  in it archived) is not drawn; managing folders is Settings'.
- **Archived** chats leave the list, from the top level and from folders, and are one more group at the bottom under a rule,
  "Archived (n)", closed until it is opened (this window only, not stored). The group is not there with nothing archived.
- **Colour** is a 4 px stripe on the row's edge (`data-accent`, the same swatches as Settings; nothing for `default`), inside
  the row so the pane never cuts it; a folder's colour is the dot on its header.
- **Mute** is a bell-off mark after the name, and "Muted" (and "Pinned") in the row's accessible name. A mute is a deadline:
  `useMuteClock` wakes the list once, when the soonest one still ahead lapses, so the mark goes without anybody touching the page.
- **A search** shows its matches in the same groups, every group open and the headers only naming them (not buttons), so a
  match is never behind a closed folder or the archive; clearing it returns the groups to how they were.
- **Not drawn yet:** the name the reader gave a bot (`labels`; Settings uses it, the sidebar and its search still use the
  gateway's name) and a collapsed folder's unread count.

A chat is marked read by the chat screen, not by the list (`botsStore.markSeen`; "The chat screen" below).

### The theme

`ui/theme.css` holds every colour, size and motion as custom properties (the danger ink, `--hm-danger-text`, is held to 4.5:1
like the others): light, dark or follow the browser
(`prefers-color-scheme`), plus one tint of nine. The choice is two attributes on `<html>` (`data-scheme`,
`data-tint`; `platform/theme-target.ts`, because the policy forbids inline styles), stored per base path under
`device.scheme` and `device.tint` (`state/settings.ts`, so a sign-out keeps them) and applied before the first
screen. Settings, Appearance changes them. The transcript's text size is a third attribute, `data-text-size`
(`state/text-size.ts`, `bindTextSize`), which `ui/theme.css` turns into `--hm-chat-scale` (0.88, 1, 1.15, 1.3; a test
reads the stylesheet against the store's numbers) and `chat.css` multiplies the words of a message by, so it sizes the
conversation and nothing around it. The focus ring is the tint's ink; reduced motion is
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
| `MessageMenu.tsx`    | the transcript's one message menu and how it is reached (below); the menu itself is `MessageMenuPopup.tsx`, a lazy chunk    |
| `ChatOptions.tsx`    | the chat's options: verbosity, bot-to-bot, thinking (the panel, `ChatOptionsPanel.tsx`, is a lazy chunk)                    |
| `ImageViewer.tsx`    | one picture over the page, a modal dialog; a lazy chunk, fetched the first time a picture is opened                         |
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
the key because the status line depends on it and ending a turn changes no item. The view is the reader's choice for
this chat (`ChatOptions`, a disclosure at the end of the header: a radio group for the verbosity, checkboxes for
bot-to-bot and thinking, and "Reset this conversation's view" once the chat has its own), kept in
`state/chat-view.ts` under an identity-bound key: one default and an optional override per bot, as the Expo app keeps
them. A switch is instant and loses nothing, mid-turn included. The default is `DEFAULT_CHAT_VIEW`: level `quiet` (no
tool lines, one "working" row while they run), bot-to-bot shown, no reasoning, as in the Expo app and the Swift app
(the owner's call, 2026-10-03). Only a default the reader chose is stored; the whole `normal` default that earlier builds
wrote on every save is read as nothing chosen. The account's synced `defaults` is not read yet: the `ui_meta` bridge
carries it raw until a store here owns it. Settings, Chats changes this store's default (`setDefaults`), which is this
browser's for this person, as the paragraph above says.

| Item                         | View                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                       | a bubble on the right in the tint, Markdown, clock, "Sending..." until the gateway has it; somebody else's in the group chat is on the left with their name; its attachments in a list (`AttachmentGallery`): a picture the reader sent from this page as a picture (`ImageCard`, the tray's own thumbnail, `sent-previews.ts`), every other one as a file chip (`FileChip`)                                           |
| `assistant`                  | a bubble with Markdown; its thought, when thinking is shown, as one closed "Thought for 4s" line above it (`ReasoningDisclosure`); the typing dots in the same bubble until words arrive; usage and duration footer; a failure card under the words that arrived (`ErrorCard`: "Reconnecting..." when the gateway holds the turn, Retry only when the screen has something to retry with); interim and reply-to labels |
| `tool`                       | one collapsed line (`ToolCard`: family glyph, name, what it did, how long or "Running..."); a click opens the untrusted-output warning, arguments, a patch's diff (`DiffView`: added and removed lines as `<ins>` and `<del>`, each read out as "Added:" or "Removed:", in a keyboard-reachable scroll area named by its counts) and the result as plain text; silent tools (`todo`) draw nothing until they fail      |
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
item kind in every presentation, and under them attachments as chips and pictures, a file chip in each of its states,
diffs and the chat's options, with the message menu on every message and the viewer behind every picture
(`src/dev/item-gallery.tsx`, development only, checked by axe in `item-gallery.axe.test.tsx`, closed and with the
menu, the options and the viewer open).

**A message's actions** (Copy text, Copy as Markdown where it differs, Edit and resend on the reader's newest turn,
Regenerate on the last reply, Branch from here on a turn or a reply, and Copy link, or a Copy links group when a
message holds several) are one menu for the whole transcript. Edit and resend and Regenerate are disabled while a
turn runs and hidden after a colleague's turn in the group chat; Regenerate is `/retry` where the gateway has it and
the reader's last prompt again where it does not (`core/chats/regenerate.ts`). Edit and resend has no gateway call: it
puts the turn's words and attachment references in the composer, ahead of any draft, and sending is a new turn
(`core/chats/edit-resend.ts`). Branch from here is `session.branch` with the row's message count and a title from its
words (`core/chats/branch-here.ts`), then the read-only viewer at the branch's address, as the Conversations page opens
one; it is offered only in the bot's own chat, attached to a session. While a request waits for the reader's answer
(`state/requests.ts`) the menu offers none of the three.
No message holds a control of its own: a button in every message made WebKit lay out a two-thousand-row history
three times slower. A message only carries `data-message-id` and `aria-keyshortcuts` (`messageTargetProps`), and
`MessageMenuLayer` listens on the stage:

| Way in       | What happens                                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| keyboard     | the transcript stays one tab stop; from it or a message the up and down arrows move focus between messages (roving, `tabindex="-1"`), Home and End go to the ends, Escape goes back to the transcript, Enter, Shift+F10 or the context-menu key opens the focused message's menu; the log's description says so |
| hover or tap | one small "more" button on the corner of the hovered bubble, moved from message to message, out of the tab order                                                                                                                                                                                                |
| right-click  | the menu at the pointer, except on a link or with words the reader had selected before the press, where the browser's own menu is the one asked for                                                                                                                                                             |
| long press   | the same on a touch screen (half a second, cancelled by a finger that moves)                                                                                                                                                                                                                                    |

The menu is the ARIA menu pattern: focused on its first line, the arrows, Home and End move, Escape and Tab close it
and give focus back; it follows its message while the transcript scrolls and says what it did in a polite region.
What the menu and the rows ask the screen for goes through one host object of stable identity (`items/item-host.ts`),
so asking never re-renders a settled row.

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
  too, and the dialog names the bot ("From <name>"). **A question comes before a sheet** (`features/requests/sheet-order.ts`):
  an approval, clarify, confirmation, secure prompt or connector card is shown before a form, file request or draft
  whatever the arrival order. An interactive sheet on screen steps aside (parked with what was entered, not Later, and
  back by itself afterwards; a polite announcement says so), unless it is sending or uploading, which it reports through
  `SheetBusyContext` (`useReportBusy`): then the question waits. A sheet put away with Later stays away until Open.
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
  (`SecureRequest`), held by the secure input model: "Secret prompts" below. A form, a file request and a draft to
  review join it as `InteractiveRequestEntry` (with the request's `method` and `version`), held by the interactive
  model: "Interactive requests" below. A connector authorisation joins it as `ConnectionRequest`, held by the
  connections model: "Session gaps" below. A `plain` confirm is W-15.

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
  prompt first seen after that call went out is left alone: it may be newer than the list. "First seen" and "went out"
  are both read from the page's monotonic clock (`performance.now()`), so a system clock set back cannot close a live
  prompt. The list can be short (with turn isolation the gateway mirrors one request per session), so such a prompt is
  closed as let go of here, not as withdrawn: the gateway delivering it again opens it again, and the line that said it
  ended goes. The same holds for the interactive requests.
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

### Interactive requests

`input.form`, `input.file` and `review.draft` (`contract/requests/`, plan `request-types-v2`) are answered beside the
transcript engine too, by the interactive model (`core/requests/interactive.ts`, `state/interactive.ts`), on the rules
of the secure input model: what a person fills in, picks or edits never reaches a store the page keeps, only the
`request.answer` call that carries it.

- **Advertising.** The methods this page can show ride in the second `client.capabilities` call as `requests`, when
  the first result's `server_requests` lists any of them (`input.file` only where `File` and `FormData` exist;
  `capture: scan` is a preference the web ignores). The passkey model owns the two calls, because the second replaces
  what the first said, so it sends that call for the methods alone when the passkey level is not on offer, and reads
  the open requests of the held sessions again once the list is accepted: the gateway hid them from a connection that
  had not advertised. The page advertises what it can really show, and the three sheets exist, so the advert is on
  (`ADVERTISE_INTERACTIVE_REQUESTS`, the switch that turns it off again). On a new socket the controller's resume and replay run before the advert, when
  the gateway still hides these requests: their `open_requests` are held until the passkey model says what the advert
  came to (`RequestsAdvert.settled`, once per socket: a re-advert after `forgetPin` does not move it), dropped when it
  was accepted (the lists read after it count), counted when refused, and dropped with every later list of that socket
  when the call failed and the outcome is unknown. The passkey routes time out like an RPC
  (`PASSKEY_ROUTE_TIMEOUT_MS`), so a status read that never answers cannot keep the advert from settling.
- **Reading.** `core/requests/interactive-types.ts` holds hand-written types for the three params and their answers,
  and a reader per method held to `contract/requests/examples.json` (`interactive-types.test.ts`): every text goes
  through `displayText` with its own limit, a frame the gateway never sends (ids that repeat, a default outside its
  range, `Z` in a datetime, an `upload.dir` that is not absolute or holds `..` or a control character) is declined, and
  a field kind this build does not know makes the form an `unknown` field, declined with
  `4041 not_supported_on_device`; a keyboard hint it does not know is `plain`. A draft's text and a multi-line field's
  default are not cleaned: they are what will be sent. A draft whose text the gateway's verbatim rule would refuse (a
  tab, a control, format, bidi, private-use or unassigned character, a line separator) is declined instead.
- **Answering** is `request.answer {id, result}`, so a refusal (`4034 data.reason`: `field:<id>:<problem>`, ...) comes
  back and leaves the request open with its reason for the sheet to show; the tenth ends it. `skip` is
  `{status: "skipped"}` and only for an `optional` input; a review has none. `cannotShow(id, reason)` answers the
  JSON-RPC error `4041 cannot_show {reason}` (never a made-up skip) and leaves one notice on its chat; a sign-out fails
  every open request with `shutting_down`. While an answer is on its way nothing overrules it: the `resolved` cancel the
  gateway sends every client once an answer settled the request, the one that answered included, can arrive before the
  reply, so a cancel and the local deadline wait for the call's result. A call that failed without the gateway's word
  leaves the request uncertain: a later ending says the answer may not have arrived. A `resolved` cancel otherwise
  says another device answered it.
- **Deadlines** are the request's own `expires_at`; a request past it by this clock is not shown or answered. A
  request waits for its chat as a secure prompt does (16 at most, never declined for waiting), a re-delivered copy of
  one answered from here means the answer was lost, and `open_requests` reconciles after a reconnect.
- **The engine** hears that a question was asked (title, words, `optional`) and how it ended (a summary of `status` or
  `decision`, with `count` or `edited`), never a value: the `request` item of `@hermie/transcript`. A resume's
  snapshot hands it the same three keys, cleaned, for an interactive request (the controller drops its fields and a
  draft's text), and a request that ended here before a chat held its session is ended on that chat once it shows it.
- **The sheets** (`features/requests/`, one lazy chunk with the other request sheets, `RequestLayer` routes by method)
  are drawn in the secure sheets' frame (`interactive-frame.tsx`): the heading and every label are the app's words, the
  bot's heading and summary (and its detail, and the person it acts for) are plain text in a quoted box under a label
  that says they are the bot's, the gateway's host, a countdown to `expires_at`, who receives the answer, a tap guard
  (the fields and buttons are off for a moment), Escape and the scrim do nothing, and Offline, busy, failed and an
  earlier answer that was lost are said. What is typed lives in the sheet's component state and in the one answer; no
  store, cache, draft or log holds it. A refusal does not rebuild a sheet (the layer keys it by the request, not by its
  version). **Later** (the button, and Escape) puts a sheet away without answering: the page is usable, the request still waits,
  and the transcript's record offers **Open** (`state/request-later.ts`; the layer keeps the sheet mounted in a node of
  its own that moves between the dialog and a parking place, so what was entered, picked or edited is still there, and
  an upload goes on). **Don't share** on a form and a file request answers `cannotShow('declined')`: the person's choice,
  never the default button; a draft has none (Reject is its refusal). Only the Send button sends a form: Return in a
  one-line field does not.
  - **`FormSheet`** draws every field kind with the browser's own input (`FormFields.tsx`: `date`, `time`,
    `datetime-local`, `number`, `select`, radio and checkbox groups, a switch, `textarea`; an amount is a text input
    with its currency and decimals, a range two date inputs), with required marks and `aria-describedby` hints. The
    page checks first, in the gateway's terms and order (`core/requests/form-values.ts`, held to
    `contract/requests/examples.json` by `form-values.test.ts`): a datetime carries the offset of its zone at that
    instant and the zone in brackets (the field's `tz`, else the device's), a time the clocks skip is the `offset`
    problem, an amount is a decimal string with the currency's minor unit, a number a JSON number. A refusal
    (`field:<id>:<problem>`) is worded by the same sentences (`form-problems.ts`) next to its field until that field is
    changed. Skip only when the request is `optional`.
  - **`FileSheet`** filters the picker by `accept` and holds the files to it, offers a camera button next to it on a
    touch device when the bot prefers a photo or a recording (`capture`; never for `scan`), checks `max_bytes`,
    `max_total_bytes` and `max_files` when a file is picked and again on the prepared files, before any upload, previews
    pictures, and with `strip_metadata` re-encodes a picture on a canvas (`file-prepare.ts`: a JPEG or PNG stays one, any
    other picture the browser decodes becomes a JPEG; one it cannot decode is not sent, never uploaded with its metadata). It uploads one file after another DIRECTLY into `upload.dir` as
    `<16 hex>-<name>` (`flatUploadPath`, through the controller's `uploadFileTo`, the same route and credentials as an
    attachment) with progress and a cancel, quotes each file's size and SHA-256 (`crypto.subtle`, a plain
    implementation where the page is not a secure context, read a chunk at a time and handing the thread back between
    them: `core/requests/sha256.ts`), and answers with references. A
    failed upload is said first: try again (what is already up is not uploaded twice) or give up, which is
    `4041 upload_failed`.
  - **`DraftSheet`** shows the text verbatim in a monospaced `white-space: pre` box (an editor when `editable`), apart
    from the subject and the recipients, never rendered as Markdown and never a link. What the eye cannot see (zero-width
    and direction characters, blank letters, a tab) is counted and shown by its code point in a preview, and Approve
    waits until an edit has taken them out. The gateway's whole verbatim check is mirrored (`verbatimIssue`, contract §6.1 to
    §6.4: stripping first, then the characters, then the layout limits of 16 spaces in a row, an indent of 32, 3 blank
    lines and 2,000 characters a line), the rule and the line are named next to the editor, and the page never rewrites
    the text (§6.5),
    because the gateway refuses them. Approve, Approve with
    changes (once the text differs from the original, which stays on screen for comparison) and Reject with an optional
    comment of at most 1,000 characters; there is no Skip.

`core/requests/interactive.test.ts`, `interactive-types.test.ts`, `form-values.test.ts`, `sha256.test.ts`,
`features/requests/FormSheet.test.tsx`, `FileSheet.test.tsx`, `DraftSheet.test.tsx`, `file-prepare.test.ts`,
`interactive-sheets.axe.test.tsx` and `state/requests.test.ts` cover it in jsdom;
`core/requests/interactive.integration.test.ts` runs the model against the fake gateway, which validates every answer;
`e2e/interactive-model.spec.ts` raises each method through `/__fake/request` against the built client, and
`e2e/requests-interactive.spec.ts` answers each through its sheet in a real browser (a refusal round trip, a file that
lands in `upload.dir` with its SHA-256, axe with contrast).

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

## Conversations and search

`features/sessions/` and `features/search/`: the Expo app's Conversations page and chats-field search, on this
client's shell. The model underneath is the controller's and is unchanged (`core/sessions/`,
`classifyConversations`, `conversationActions`).

| File                             | What                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sessions/ConversationsPage.tsx` | `#/chat/<bot>/conversations`: the groups, their actions, a new conversation (its own lazy chunk) |
| `sessions/use-conversations.ts`  | the bot's groups, read when the connection is ready and again whenever the controller says so    |
| `sessions/push-destination.ts`   | where a notification tap lands and whether it may answer (ADR-0017 amendment), for W-25          |
| `search/name-filter.ts`          | the instant half of the chats field: names, on this device                                       |
| `search/message-search.ts`       | `searchBotChats`: one `searchSessions` per bot, bounded, hits outside the bot's chat dropped     |
| `search/use-message-search.ts`   | the debounced fan-out for the field; a superseded query is abandoned                             |
| `search/MessageHits.tsx`         | the hits under the list: bot, time, the gateway's snippet with the match marked                  |
| `search/find-request.ts`         | the words a hit hands the chat it opens (not in the address)                                     |
| `search/use-find-in-chat.ts`     | the chat scrolls to the newest row with the words, paging back, bounded                          |

**The Conversations page.** Reached from the link at the end of a chat's header line. Groups, in order: the
current conversation (the Bot Chat, drawn with **no action at all**: the row's actions are
`conversationActions(conversation)` and nothing else, which is empty for the canonical row), the reader's own chat
where there is one (open only), branches and past conversations (open, rename, delete, make this the Bot Chat).
Open goes to the read-only viewer at `#/chat/<bot>/s/<id>`. Rename is an inline field that commits on Return and
leaves on Escape; Delete asks first, inline; "Make this the Bot Chat" is the controller's swap with its rollback
and runs at once. "New conversation" asks first (the group chat is everybody's), then runs
`startNewConversation`, which puts the Bot Chat away under Past conversations, and takes the reader to the chat. A
swap and a new conversation open the chat first when it is not live, because both retire the session the bot's key
is on. Every action says what happened (polite) or why it did not (an alert, the gateway's reason; a busy bot in
words of its own) and reads the list again rather than patching it. Titles are cleaned and bounded by
`displayText` and isolated in `<bdi>`.

**The viewer.** A branch or a past conversation opens read-only (`openConversation`, under `bot#<id>`): a line says
so, with links back to the chat and to the bot's conversations, there is no composer, and nothing is marked read.

**Search.** The chats field narrows the list to the bots whose shown or profile name holds the words, at once, and
Escape empties it. After 300 ms without typing, `GET /api/sessions/search` is asked once per bot (four at a time,
8 s each; a bot whose search fails is one missing hit), and the hits go under the list in a section of their own
with one polite status line (searching, nothing found, "only the best match per chat is shown"). The route
answers one conversation per profile and never a message, so a hit that is not the bot's own chat (a cron run,
a branch, a CLI session) is dropped, as in the Expo app. A hit is a link to the bot's chat that leaves a
`FindRequest`: the chat scrolls to the newest row with the words (the same prefix and phrase rules as the gateway's
FTS5, on the visible text), marks it, and says so. Where the row is not loaded yet, the list goes to its oldest row
and loads the page before it, up to 200 pages; where the words are not in the visible text (a match in a tool's
arguments), a line says so. The list goes to the oldest row before a page is put in because a page put in far above
a reader at the bottom lands among chunks the browser has not laid out, and WebKit reports what they settle on as a
resize loop.

**Notifications** (W-25, "Web Push") call `pushRouteOf`: a tap names a conversation by `sessionId` (a request by
its `sessionKey`) and
`sessionKind`; `branch` and `other` open the viewer, `canonical`, no kind, or the canonical chat's own id open the
chat, and an id with no kind that the roster cannot place opens the chat rather than guess. `answersInPlace` is
false wherever the tap does not land in the bot's own chat: a tap into a non-canonical conversation opens it and
answers nothing.

**Tests.** `ConversationsPage.test.tsx` (the groups, the guard, every action and its refusal, the connection, a
language switch), `MessageHits.test.tsx` (names, the debounce, dropped hits, a superseded query, the find request),
`use-find-in-chat.test.tsx`, `push-destination.test.ts`, the ported `message-search` and `find-in-chat` tests, and
`sessions.axe.test.tsx` (both schemes, three languages, every form of the page open). `e2e/sessions.spec.ts` in the
browser: a branch made with `session.branch` opened from the page in the viewer, renamed and deleted; a new
conversation; a search hit opening the chat at its row, also 1,200 rows deep; axe in light and dark.

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
belongs to a session just read and is not among the `open_requests` the gateway answers with is let go of here
(`closed_here`), quietly, and not ended as timed out: the list can be short (with turn isolation the gateway mirrors
one request per session), so the gateway delivering it again opens it again, while one a `request.cancel` ended stays
closed. An answer on its way is left alone, a list read where the gateway did not take the passkey level (it cannot
name a confirmation) closes nothing, and a gateway that answers without the list says nothing about them.

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

## MCP

The gateway fork can serve a remote MCP endpoint that an MCP client (a coding agent, say) connects to **as the
signed-in person**. Hermie never speaks MCP and runs no server. It does three things, all from
`contract/gateway/mcp.md`: it shows what the gateway says about its endpoint and the clients connected to it
(`GET /api/auth/mcp`), it revokes a client (`POST /api/auth/mcp/grants/{id}/revoke`), and it draws a turn an agent
sent on a person's behalf as `<name> via <client>`.

| File                               | What it does                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `core/mcp/client.ts`               | the two routes on the cookie session; the answer read defensively (unknown keys ignored, a grant that is not a grant dropped)       |
| `core/mcp/model.ts`                | `McpModel`: `watch` (the page is open), `refresh`, `revoke`; follows `mcp.changed` and the tab's return to the foreground           |
| `state/mcp.ts`                     | the store the model writes: the last read, why a read failed, the last change somebody else made                                    |
| `features/settings/MCP.tsx`        | `#/settings/mcp` (a chunk, with `mcp.css`): the state, the endpoint, the command, the config, the instructions, the clients, Revoke |
| `features/settings/mcp-runtime.ts` | the model's actions as a context, like the passkey model's                                                                          |

**The page.** It says MCP is on, shows the endpoint, the add command (`claude_command`) and the `.mcp.json` fragment the
gateway gave (each with a Copy button, `platform/clipboard.ts`), the gateway's instructions, and the connected clients:
name, when it was allowed and from which address, when it was last used (and from where), and when it ends. Every
string from the gateway is drawn as plain text (a client's name and address are cleaned to one line first; the command
and the config are shown and copied exactly as they came, and are never built from the endpoint or run). A 404 or 405
is one sentence, "This gateway does not offer MCP", and nothing else; a 401 or 403 `no_identity` says to sign in; any
other failure says what the gateway said, keeps the list that was read, and offers Try again.

**Revoke** asks first (an inline question; Cancel has the focus and gets it back on the button), sends `{}`, treats 200
and "no such grant" (404 `not_found`) alike by reading the list again, and says a 403 `origin_not_listed` in words (the
browser sends the `Origin` the gateway checks). After a revoke the focus moves to the list's heading.

**Fresh.** The model is idle until the page is open: it asks nothing, and a gateway without MCP is never asked. Once
open it reads at once and reads again on `mcp.changed` (a client allowed or revoked elsewhere, announced as a line
under the page, unless this page revoked it itself) and when the tab comes back to the foreground, since an operator's
revoke may send no frame. Only the newest read is applied. The page and its styles are a chunk of their own, fetched
when `#/settings/mcp` is opened or when a pointer or the focus reaches the link on the Settings page; its words are in
`sheet-strings.ts`, the link's title in `web-strings.ts`.

**The `via` label.** A row whose author carries `via` (`@hermie/transcript`, `authorLabel`) is captioned over its
bubble with one label: `You via <client>` for the reader's own turn, `<name> via <client>` for a colleague's, in any
chat, on the side the row would be on anyway. It is plain text, never Markdown, and it is not gated like a colleague's
name: a turn an agent typed is never drawn as the person typing. (The chat list's preview takes the same label from the
engine.) `replayed_by` is not drawn by this client at all today.

**Tests.** `client.test.ts` (the shapes, what is dropped, every refusal, the body of a revoke), `model.test.ts`
(idle until watched, a read per hint, the newest read wins, a revoke of its own is no news, each failure as a state),
`MCP.test.tsx` (the page in every state, plain text, copying, the confirmation and its focus, axe), the `via` cases in
`items.test.tsx`, and `e2e/settings-mcp.spec.ts` against the fake gateway's `--mcp` ("The browser suite").

## Web Push

The plugin sends notifications (plan W13, ADR-0017); this client registers the browser for them and acts on clicks.
It is offered only in a secure context, in a browser with service workers, `PushManager` and notifications (on an
iPhone or iPad: a web app added to the Home Screen), on a gateway whose advert claims `push.webpush` and
`push.webpush.key` with `webPush.publicKey`. Otherwise Settings › Notifications says which of these is missing.

| File                                             | What it does                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sw/sw.ts`, `worker.ts`                      | the service worker, built to `dist/sw.js` (a second entry, a plain script that imports nothing): `push` and `notificationclick`, no `fetch` handler                       |
| `src/sw/notification.ts`                         | a payload as a notification: the plugin's title and body exactly, `data` kept whole, one tag per conversation, Allow and Deny on an approval only, a clearing push closes |
| `core/push/platform.ts`                          | what has to be true (`pushSupport`), and the browser seam's shape                                                                                                         |
| `platform/web-push.ts`                           | the seam: registers `./sw.js` (scope: the app directory) through the one Trusted Types policy, the permission, the subscription, the worker's messages                    |
| `platform/push-launch.ts`, `core/push/launch.ts` | the click a cold start carries (`?hermiePush=`), read once and removed from the address; the only part in the first load                                                  |
| `core/push/row.ts`                               | the row (`pushRowFor` plus `applicationServerKey`, `clears: true`, `requestMethods: true`), the key rule (`subscriptionStep`), the push map a write carries               |
| `core/push/sync.ts`                              | `PushSync`: on, off, Register again, the launch check, sign-out, the test notification (`push.test`), clicks                                                              |
| `core/push/actions.ts`                           | what a click may do: open the conversation; Allow or Deny only for an approval `approval.pending` still lists in that session, with `once` or `deny`                      |
| `core/push/seen.ts`                              | the heartbeat (`{bot, at}` once a minute while a chat is on screen and a device of the person gets notifications) and closing notifications that are dealt with           |
| `core/push/clock.ts`                             | the gateway's clock from the `Date` header of `/api/status`, for `updatedAt` and the heartbeat                                                                            |
| `state/push.ts`                                  | the switch, the types, the preview and the key under the person; the installation id per browser; the per-chat overrides from the gateway                                 |
| `features/push/push-runtime.ts`                  | the controller wired to the router, the chats and the request queue; a chunk loaded once the session has started                                                          |
| `features/settings/Notifications.tsx`            | `#/settings/notifications`; the per-chat types are in the chat's options                                                                                                  |

**The key.** The browser is subscribed with the advert's key, and the row names it (`applicationServerKey`, base64url
without padding). On every launch, once the advert is read, a subscription made with another key (or one whose key
cannot be told and was not remembered) is unsubscribed and made again, and the row is written again with a fresh
`updatedAt`, which is also what lifts a row the plugin retired after a 403 or a 404/410. The same happens when the
advert's key changes while the page is open, when the page comes back into view more than six hours after the last
write, and on "Register again". `updatedAt` and the heartbeat are on the gateway's clock when its `Date` header gives
one; if it does not, the page's own clock is used, and a page whose clock is behind the gateway's may write a row the
plugin still holds retired until it is written again.

**The row** is written by the `ui_meta` bridge into the person's app section, beside every other device's row and
heartbeat as the gateway holds them; until this page has checked its own subscription, the row the gateway holds for it
is carried as it is. Switching off, and signing out, take it out (a sign-out sends that write and waits for it, at most
three seconds, before the connection goes) and unsubscribe.

**Clicks.** The worker posts a click to an open window of the client (never to another page of the gateway's origin)
or opens `index.html?hermiePush=<click>`. The conversation the notification names opens (`push-destination.ts`). An
Allow or a Deny answers only when it was posted by the worker, the notification is an approval of the bot's own chat,
the chat is attached to its session, and `approval.pending`, asked then, lists the same request id in that session with
`once` (or `deny`) on offer. A click carried in the address only opens: anyone who can make the browser follow a link
can write that address.

**Policy.** `navigator.serviceWorker.register` takes a `TrustedScriptURL` under `require-trusted-types-for 'script'`, so
the document allows one policy, `hermie-service-worker`, created once by `platform/web-push.ts` and refusing any URL but
`./sw.js`. The dev server does not build the worker: `npm run client:dev` has no Web Push.

**Tests.** `src/sw/*.test.ts` (every example payload of `contract/push/contract.json`, the worker's events, its module
graph), `core/push/*.test.ts` (the key and row rules, the support rules, the click table, the controller against a fake
browser), `ui-meta-bridge.push.test.ts` (the push map in the section), `push-runtime.test.ts`, `Notifications.test.tsx`,
and `e2e/push.spec.ts` in Chromium (full Chromium, not the headless shell, which refuses notifications): the real worker
and policy, with `PushManager` replaced because a push service is not reachable from CI; the push event is delivered to
the worker through the DevTools protocol. A real notification from the plugin is checked by hand on the test gateway.

## Settings

`features/settings/` is the main pane of `#/settings` and `#/settings/<section>`: a home that links to each section and says
what is in it, and nine sections under a way back to the home. The sidebar's foot links to it (and asks for its chunk
when the link is pointed at or focused). The native apps' Settings pages are the reference for what each one shows; the
Dutch and German wording is the catalogue's wherever the Expo and Swift apps already have the word, and the web client's
own (`sheet-strings.ts`) where they do not. **No operator settings** (which modules run, who may use the gateway: those are
the plugin's configuration on the gateway).

| File                                                         | What                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `load.ts`                                                    | the way into the chunk: the only module the entry imports from here                                                                                                                  |
| `SettingsHost.tsx`, `sections.ts`                            | the home, the way back, the section a route names (an unknown one is the home), each section's title, blurb and loader                                                               |
| `settings-runtime.ts`                                        | `SettingsRuntimeContext`: what no store holds (the gateway's address and Hermes version, who was named, the licence list's address, clearing the cache, signing out), given by `App` |
| `controls.tsx`, `settings.css`                               | the page, a radio group, a checkbox, the "not synced" line, a read-only fact: native controls throughout                                                                             |
| `Account.tsx`                                                | who `/api/auth/me` named, the gateway's host, Sign out behind a question                                                                                                             |
| `Gateway.tsx`, `gateway-facts.ts`                            | this gateway, read only: host, address, Hermes version, plugin and modules, this build and the plugin's, the update line                                                             |
| `Chats.tsx`                                                  | the default view of a conversation, the transcript cache on or off and "Clear now"                                                                                                   |
| `Notifications.tsx`                                          | Web Push for this browser: what is missing, the switch, the types, the preview, "Register again", the test ("Web Push")                                                              |
| `Arrangement.tsx`, `arrangement-model.ts`, `arrangement.css` | the chat list: reorder, folders, colour, mute, archive                                                                                                                               |
| `Appearance.tsx`                                             | scheme, accent colour, language, text size                                                                                                                                           |
| `About.tsx`, `core/licences.ts`                              | version and commit of this build, the licences from `licenses.json`                                                                                                                  |
| `Passkeys.tsx`, `MCP.tsx`                                    | the pages of their own sections ("Passkeys", "MCP"), unchanged                                                                                                                       |

**Every control is a native one and labelled**: a group of choices is a `fieldset` with a `legend` and native radios (the
arrows move the choice), a switch is a checkbox, a menu is a `select`, and a hint is what the control is described by.
A control that works while something is in flight is not disabled (a disabled button drops the focus the reader was
using): "Clear now" says `aria-busy`, and a Move button at the end of a list says `aria-disabled`.

**Appearance.** The scheme (System, Light, Dark) and the accent colour (nine tints) are the browser's: `settingsStore`, kept on
sign-out, applied to the document by `bindTheme`. The language is `setLanguageChoice`: it loads the language and then makes it
the one every screen reads, with nothing remounted, so a switch takes effect where the reader stands, with no reload
(`e2e/settings.spec.ts` proves it with a marker on the window and a reload that keeps the language). "Follow browser" is
a pick of its own, kept even when it resolves to the language already in use. The text size is `textSizeStore`
(`setTextSize`), which the `ui_meta` bridge sends; it multiplies the words of a message (above) and says so when the gateway is
not taking it (`SyncNote`, from `uiMetaStatusStore`).

**Chats.** The verbosity, bot-to-bot and thinking a conversation shows until it has a view of its own are
`chatViewStore.setDefaults` (this browser's, for this person; the chat's own options panel says "Following the default set in
Settings"). **The transcript cache** (IndexedDB, "Browser storage") has a switch and a button. The switch is
`settingsStore.transcriptCache` (`device.transcriptCache`, absent meaning on, kept on sign-out), honoured by `GatedChatCache`
(`platform/chat-cache.ts`), which `main.tsx` puts around the page's cache: switched off, nothing is read from it and nothing
is written to it (a chat opens from the gateway, as on a first visit), and `forget` and `clear` still reach the store. Switching
it off also clears what is stored, in the same step, and says so: a switch that stopped new copies and left the old ones would
not mean what it says. "Clear now" is `cache.clear()` (this base path's rows only) and says what it did, or that it could not.
The e2e spec reads the IndexedDB back.

**Chat list.** Everything goes through the layout store's actions (`moveBy`, `moveFolderBy`, `dropBot`, `dropFolder`,
`moveToFolder`, `addFolder`, `renameFolder`, `setFolderColour`, `removeFolder`, `setAccent`, `setMute`, `setArchived`) and
nothing else; the bridge sends it. The page lists the arrangement (and a bot the roster has and the arrangement has not
placed yet, loose and unmovable), the archived chats apart. `arrangement-model.ts` is the arithmetic and is tested as
functions: what is drawn, how far a step goes over archived chats it cannot see, where a drop lands (read without the moving
row, as `moveBotTo` and `moveFolderTo` read theirs) and whether it changes anything, and where a row is afterwards.

- **Reordering by keyboard and by pointer, two ways to one thing.** Each row has Move up and Move down buttons (named for
  the row, "Move down Writer"), which are the keyboard's way; a row's handle is `draggable` (HTML drag and drop) and is hidden from
  assistive technology, whose way is the buttons. A drop goes before or after the chat it is over by the half of the row
  the pointer is in, to the end of a folder when it is on the folder's own row, and a folder moves among the top level the same
  way; a drop that changes nothing draws no line and commits nothing. A move says where the row went in a polite status line ("Writer
  is now at position 2 of 4", "Writer is now in Reading"), and the pressed button is focused again after the row has moved (the
  browser drops the focus of an element that is re-inserted).
- **What else a row offers** is behind one button per row, "Actions for Writer" (a disclosure with `aria-expanded`): its folder,
  its colour (eleven, by name, `default` meaning none), its mute (for 1 hour, 8 hours, 1 week or until turned back on; a mute
  that is running stays selected as its own line) and Archive. A folder's own has its name (committed on blur or Enter, one write
  and not one per key), its colour and Delete (its chats come back where it stood). An archived chat offers colour, mute and
  Unarchive, and the focus goes to the archive's heading (or the list's) when a chat has moved between them.
- **The sidebar draws it** (`features/bots`, "The chat list" above): this page is where the arrangement is changed, and the
  sidebar beside it follows from the same store at once, as the native apps and every other device that reads the same
  `ui_meta` do.

**This gateway** is read only and says so. The host is the page's own (the gateway serves this client), the Hermes version is what
`/api/status` said at boot (`probe.version`, handed to `App` by the entry module), the plugin, its version and its modules are the
advert (`state/plugin.ts`; "Checking..." until a roster has been read, "Not installed" when it carries none), and every string the gateway
wrote is cleaned and drawn as text. **The update line** compares this build with the one the advert's `web` block names
(`gateway-facts.ts`): the commit settles it where the plugin gave one (the advert abbreviates it), the version number only where it did not,
and a plugin that does not say which client it carries, or has it switched off, is "no update is known", never "up to date". When
they differ it says so and to reload; it does not compare numbers by order (a plugin may carry an older build on purpose).

**Account** is `/api/auth/me` as the boot read it (name, email, user id, provider, host; a field that repeats the name is not
said twice, a provider of `none` is not said at all), and Sign out asks first, with Cancel holding the focus and getting it
back, then runs the entry module's sign-out (stop the chats and the socket, end the gateway's session, clear this person's
stored state, go to the gateway's page). The question says what goes (transcripts, drafts, the arrangement kept in this
browser) and what stays (theme, accent colour, language, text size).

**About** shows the build's version and commit (`build-info.ts`) and the licences: `licenses.json` ("The build") is fetched
when the page opens (`core/licences.ts`, read defensively: a package with no name is dropped, a text is found by its hash) and
drawn as one disclosure per package, the licence text as text. A build without the file, or one that cannot fetch it, says so with
Try again, and nothing else on the page depends on it.

**Tests.** One file per page (`Account`, `Appearance`, `Chats`, `Gateway`, `About`, `Arrangement`, `SettingsHost` `.test.tsx`), the
arithmetic (`arrangement-model.test.ts`, `gateway-facts.test.ts`, `core/licences.test.ts`), the seams (`platform/chat-cache.test.ts`,
`state/settings.test.ts`, `state/text-size.test.ts`), and `settings.axe.test.tsx`: axe on the home and every section in both
schemes and in Dutch and German, with a row's panel, a folder's panel, an archived chat's panel, the sign-out question and an opened
licence. `e2e/settings.spec.ts` runs the built client ("The browser suite").

## Markdown

`src/markdown/` draws a message as React elements. The text goes through `@hermie/markdown` (`preprocessMarkdown`,
`splitBlocks`, then `marked.lexer` per block, the same three steps the Expo app and the corpus use) and the tokens
become elements; no HTML string is made anywhere, so there is nothing to sanitise.

```tsx
<Markdown text={message.text} gatewayBaseUrl={baseUrl} />
```

Two optional props place a message's headings in the page it is drawn in (`headingOffset`, `headingMax`: a heading is
the written level plus the offset, capped at the max; the transcript uses 2 and 3).

| File                     | What                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown/Markdown.tsx`  | the component: one memoised child per top-level block, keyed by its index and a hash of its source                                                                         |
| `markdown/Block.tsx`     | block tokens: paragraph, heading, list (nested, ordered, task), quote, rule, fence, raw HTML as text                                                                       |
| `markdown/Inline.tsx`    | inline tokens: strong, em, del, code, line breaks, links, images                                                                                                           |
| `markdown/CodeBlock.tsx` | a fence: language label, copy button with a polite live announcement, a box that scrolls sideways; a drawn formula or diagram in the same box, with a "Show source" toggle |
| `markdown/lazy.ts`       | the heavy renderers as chunks of their own, held once loaded so a block draws them on its first render                                                                     |
| `markdown/Highlight.tsx` | coloured code (lazy): the spans of `@hermie/markdown`'s `highlight.ts` as classes, colours in `markdown-highlight.css`                                                     |
| `markdown/Math.tsx`      | mathematics (lazy): `$$…$$` as an SVG drawing laid out by `math-layout.ts`, `$…$` as text in the sentence                                                                  |
| `markdown/mermaid/*`     | Mermaid (lazy): `Mermaid.tsx` picks the kind, `Flowchart.tsx`, `SequenceDiagram.tsx` and `PieChart.tsx` draw the package's layouts as SVG                                  |
| `markdown/Table.tsx`     | a table in its own focusable scroll container, `th scope="col"`                                                                                                            |
| `markdown/links.ts`      | the two allow-lists: which links may be anchors, which images may load                                                                                                     |
| `markdown/markdown.css`  | the styles, on tokens that follow the reader's colour scheme                                                                                                               |

The rules, each pinned by a test:

- Raw HTML in a message, block or inline, is shown as the characters that were typed. An entity stays as written.
- A link is an anchor only for `http:`, `https:` and `mailto:` (`target="_blank"`, `rel="noopener noreferrer"`).
  Any other link keeps its words and loses the link. The check is anchored at the first character, so a leading
  space, a control character or a case trick does not get past it.
- An image loads (`<img loading="lazy">`) only from the gateway's origin: a path is joined onto
  `gatewayBaseUrl`, an address must have the same origin. Any other `http(s)` image is a link with the alt text;
  anything else, and any image when there is no `gatewayBaseUrl`, is its alt text. An image that fails to load
  falls back to its alt text.
- Highlighting, mathematics and Mermaid are lazy chunks (`lazy.ts`). Until a chunk is there, and for source its
  renderer cannot draw, a block shows its source: a listing uncoloured, a formula or a diagram in a code block,
  inline math in a code chip. A chunk that fails to load leaves the source and is asked for again by the next block.
- Code in one of the fifteen languages of `@hermie/markdown` is coloured from its scope spans; the text is the
  source character for character. The palette is the package's `code-theme.ts`, as custom properties in both
  schemes; `markdown-highlight.test.ts` holds it to the package and to 4.5:1 on the code surface. Code the reader sent (on the tint) is not coloured.
- A listing is coloured only once it comes within a viewport's height of being seen (`near-viewport.ts`: one
  `IntersectionObserver` per scroll container, the transcript provided through `ScrollRootContext`; a listing already
  in view is coloured before its first paint). Far ones stay plain, one text node each: colouring every listing of a
  2,000-row history made each full style and layout pass in WebKit several times dearer (the long-history e2e test
  went from 8 s to 28 s). Highlighted lines are remembered per text and language (500 listings, least recently used
  first), and a listing that grows while a reply streams is coloured again at most every 150 ms, the new tail plain
  in between.
- `$$…$$` is drawn as an `svg` (`role="img"`, named by its LaTeX source) of `text`, `tspan`, `rect` and `path`,
  from `parseMath` and `math-layout.ts`: the Expo app's construction and constants, with boxes lined up on the maths
  axis and fences and radicals drawn to the height they enclose. Widths come from the browser's own text metrics
  (an offscreen canvas, synchronous: the faces are system faces). "Show source" swaps the drawing for its source;
  the copy button always copies the source. Source the parser declines is shown as source.
- `$…$` is text in the sentence (`mathRuns`, Unicode scripts where Unicode has them, as in the Expo app), with
  `role="math"` and the source as its name; an expression with rows in it is its source in a code chip.
- A `mermaid` fence is drawn when one of the package's parsers reads it: a flowchart (`flowchart`, `graph`), a
  sequence diagram or a pie, laid out by `layoutMermaid`, `layoutSequence` or `layoutPie` at a body size of 16 and
  drawn as an `svg` (`role="img"`, named by its source) of shapes and `text`, with the Expo app's shapes, strokes and
  arrow ends. It has its natural size in em and is scaled down, never reflowed, where the bubble is narrower. Colours
  are classes on the Markdown tokens (`markdown-mermaid.css`); a pie's slices are the app's accent swatches in the
  Expo app's order. No `mermaid` library: a label is characters in a `text`, with no link and no script. Any other
  kind, a statement the parsers refuse (`subgraph`, `click`, `style`, ...) or a half-streamed fence is its source.
- While a reply streams, a block whose source did not change is not rendered again and keeps its DOM element.

`markdown/*.structure.test.tsx` reads the rendered DOM back into the block model and compares it with every input of
`contract/markdown/blocks.json` and `inline.json`; `*.streaming.test.tsx` replays `streaming.json`;
`*.hostile.test.tsx` renders hostile input, with the lazy chunks loaded, and checks the result against a closed list
of elements and attributes (a drawing has its own closed list: shapes, numbers, `currentColor`, the source as its
name). `math-layout.test.ts` reads the layout back as structure; `*.lazy.test.tsx` covers the source-then-drawing
sequence; `e2e/markdown.spec.ts` checks the drawings in Chromium and WebKit under the real policy (text stays inside
its drawing with the browser's own metrics, axe with contrast) and compares a picture of each kind in both schemes
with one recorded on macOS (`--update-snapshots`; a platform with no recorded picture skips the comparison and says
so in an annotation).

The stylesheets of the lazy renderers are part of the main stylesheet, not of their chunks: a stylesheet that arrives
late restyles the whole transcript at once, and WebKit then reports a `ResizeObserver` loop from the list's resize
callback.

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

| Spec                            | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signin.spec.ts`                | an unauthenticated visit goes to the gateway's `/login` and signing in opens the client; a wrong password stays; a session lost before the first question ("Sign in again", the cookie deleted or ended by the gateway) restores the route after signing in; one lost while open is a signed-out line; a frame gets one sentence and makes no request to the API; signing out in one tab shows the other tab signed out at once, its socket closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chat.spec.ts`                  | the list (names, previews, unread, arrow keys, one pane on a phone), opening a chat, sending, Stop, the queue, drafts, a reply streamed in by the gateway, a socket dropped mid-reply (one bubble, the gateway's words once) and idle, and 2,000 rows of history (opens at the bottom without moving, pinned, reading above, older history)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `requests.spec.ts`              | approval and clarify with the keyboard alone, deny, several at once, another bot's, one answer for several, smart-denied, a batch's Cancel all, withdrawn, restored on resume and after a reload, a modal page behind them, 320 px                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `attachments.spec.ts`           | attach by the picker and by a drop (a file and an image), send, the chip in the bubble and the agent's reply naming the file; Return twice sends once (HERM-126); cancel an upload in flight; axe with chips and the drop target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `chat-list-arrangement.spec.ts` | the sidebar drawing what Settings, Chat list sets: a move reordering its rows (kept through a reload); an archived chat leaving the list for a closed "Archived" group that Enter and Space open and close; a folder as a group whose header Enter closes and opens (kept through a reload), the arrow keys crossing into it and Enter opening the chat; a colour on a row and a mute marked; axe in light and dark with all of it drawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `a11y.spec.ts`                  | axe, serious and critical, in light and dark: the chat list, a chat, the signed-out screen and every request sheet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `sessions.spec.ts`              | a branch (made with `session.branch` on a socket of the test's own) reached from the chat's Conversations link and opened read-only with its own history and no composer, then renamed and deleted after a question; a new conversation that puts the Bot Chat away; a search hit that opens the chat scrolled to the row with the words, also 1,200 rows deep; axe in light and dark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `passkey.spec.ts`               | Chromium only (a virtual authenticator over the DevTools `WebAuthn` domain): enrol with a code from `/__fake/passkey/code`; a confirmation raised with `/__fake/request`, confirmed, and read back as `verified: true` from `/__fake/state` `passkey.outcomes`; decline; a key the gateway cannot verify (`signature_invalid`, then `too_many_attempts`); a passkey revoked while open (`verification_failed`); a request still open after a reload; Escape; the detail's `white-space: pre` and sideways scroll; axe in light and dark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `settings-mcp.spec.ts`          | the fake gateway's `--mcp`: the page lists the endpoint, command, config, instructions and clients as the gateway said them; each Copy button puts exactly that text on the clipboard (read back in Chromium); Revoke asks first, Cancel changes nothing, confirming ends the grant at the gateway (read back from `/__fake/mcp/grants`) and the row goes; an `mcp.changed` from a seeded grant and from a revoke in another tab reloads the open page; a gateway without MCP (routes unknown, or off) says so and shows nothing else; the page is a chunk fetched only when opened; axe in light and dark, with a confirmation open; a turn an agent sent is drawn `You via <client>` and `<name> via <client>`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `settings.spec.ts`              | the home from the sidebar's link (Settings a chunk fetched when reached, each section its own); a language switch with no reload (a marker on the window survives it) that stays through one; the scheme and tint on the document and kept through a reload, the text size on the words of a message and nothing around them; the chat list reordered with Enter and Space on the Move buttons alone, focus kept on the pressed button, the move reaching the gateway and surviving a reload; a chat's colour and archive read back from the gateway's `ui_meta` and kept through a reload; a folder made, a chat moved into it, a mute; the transcript cache read back from IndexedDB (a copy after leaving a chat, none after Clear now, none while switched off, off through a reload); the default view reaching a chat's options; this gateway's and About's facts; Sign out asking, Cancel changing nothing, confirming ending the session at the gateway (401 afterwards) and clearing this person's state and not the browser's; axe in light and dark on every page, a row's panel and the sign-out question; 320 px |
| `token-mode.spec.ts`            | the fake gateway's `--auth token`: the app boots from the dashboard's bootstrap with nobody named and never asks `/api/auth/me`; the token is in no `localStorage`, `sessionStorage`, IndexedDB or cookie after use and in no request URL, and every socket URL carries it as `?token=`; a bootstrap token the gateway refuses is the prompt (masked, no form, no name), a wrong token is one sentence, the right one opens the app; a gateway restart (a new token) is followed by itself, and when the dashboard still has the refused token the connection line's button reads it again; Forget the token goes back to the prompt and leaves nothing behind, and stops a second tab too; Passkeys, MCP and Account say they need sign-in                                                                                                                                                                                                                                                                                                                                                                                   |

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
public/                     copied to dist as it is: licenses.json (generated: `npm run licences:web`)
vite.config.ts              base './', hashed assets, ASCII output, maps out of dist, dev server and proxy
vitest.config.ts            jsdom, fixed stand-ins for the injected version and commit
playwright.config.ts        the browser suite: three engines, no web server (e2e/fixtures.ts starts a gateway per test)
playwright.perf.config.ts   the performance suite: three engines, the harness server
tsconfig.json               the client's code (DOM); tsconfig.node.json: the config files (Node);
                            tsconfig.e2e.json: the Playwright configuration and specs
e2e/perf/                   the transcript list's performance suite and its trace reader
e2e/                        the browser suite: fixtures.ts, signin, chat, requests, ui-meta and a11y specs
scripts/
  write-build-manifest.mjs  dist/build.json
  source-commit.mjs         which commit this build is of (shared by the config and the manifest)
src/
  main.tsx                  the boot sequence and its screens (with dev/, the only React outside features/ and ui/)
  boot/                     frame guard, base path, auth mode and cookie session, sign-in bounce, boot
  core/                     the connection and its lifecycle, the roster controller, the advert, the chat
                            controller and the ingest (above); core/passkey/, the passkey level; core/mcp/, the MCP page's routes and model;
                            core/push/, Web Push ("Web Push")
  state/                    zustand vanilla stores: connection, bots, plugin, chats, settings, requests, and the
                            ones `ui_meta` mirrors: layout (with folders and mute), text size, app stamp, device context
  platform/                 the browser seams (above)
  features/chat/            the chat screen, its item views, the transcript list, its scroll anchor and chunks, the composer
  features/requests/        the request layer: approval, clarify and the passkey confirmation, one at a time, in a
                            modal dialog; the passkey notices
  features/settings/        Settings: the home and its nine sections (account, gateway, passkeys, mcp, chats, notifications,
                            chat list, appearance, about), each a chunk; the pages' arithmetic and tests
  features/push/            Web Push wired to the page, and the push types' labels
  sw/                       the service worker, built to dist/sw.js
  features/sessions/        a bot's Conversations page, the push-tap destination rule
  features/search/          the chats field's name filter and message search, finding a hit's row in its chat
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
`@hermie/markdown` brings `marked` into the bundle, and `highlight.js` (core and fifteen grammars) into the
highlighting chunk, which loads the first time a message has a fence with a language. The licence text of every
runtime dependency ships in `dist/licenses.json` and is shown in About ("The build", `npm run licences:web`).
