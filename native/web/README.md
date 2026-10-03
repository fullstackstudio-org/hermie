# Hermie in the browser

`@hermie/web-client`: a browser client of the Hermes gateway, written in React, Vite and TypeScript, with no
Expo and no React Native Web. It is meant to be a pure client, exactly like the native apps, and to be
served by the gateway itself through the `hermie` plugin, on the gateway's own origin. The decision and
the threat model that follows from it are in
[ADR-0030](../../docs/adr/0030-the-web-client-is-served-by-the-gateway-plugin.md).

**Status: boot only.** What exists is the build, its checks, and the boot: the client refuses to run in a
frame, finds its gateway from its own address, probes it, and reads who is signed in on the gateway's own
session. Signed in, it shows the build it came from and who you are, with a way to sign out. The connection,
the bot roster and the chats exist as React-free code with their tests ("Connection" and "Chats" below) but
no screen uses them yet; there is no chat screen, and the plugin does not serve this build. Until that
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

| Command                             | What it does                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run client:dev`                | the Vite dev server (above)                                                                                 |
| `npm run client:build`              | `vite build`, then writes `dist/build.json`                                                                 |
| `npm run client:test`               | the client's unit and component tests (vitest, jsdom, Testing Library)                                      |
| `npm run client:check-bundle`       | the gate on `dist/` (below); `-- --commit <sha>` also requires `build.json` to name that commit             |
| `npm run client:check-reproducible` | builds twice from clean and compares every file; `-- --fresh-checkout` adds a build from `git archive HEAD` |
| `npm run client:e2e`                | says there are no end-to-end suites yet; Playwright arrives with the first one                              |

Types, lint and format run with the rest of the repository (`npm run typecheck`, `npm run lint`,
`npm run format`); `client:test` and the bundle gate also run in CI as the `web-client` job.

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
- **Nothing inlined as a `data:` URI**; the document's policy allows `data:` for images only.
- **The policy travels with the document** (`index.html`): the route sets no security headers. No inline
  script, no inline style, nothing but this origin, Trusted Types required. `frame-ancestors` cannot be set
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
- `index.html` has no policy, allows `unsafe-inline` or `unsafe-eval`, or has inline script, a style element,
  a `style` attribute or an inline handler;
- `build.json` is missing, malformed, not in canonical form, or does not match the files: a changed byte, a
  missing file or an unlisted file.

It prints what it measured against each limit.

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
| IndexedDB `hermie-cache` (`platform/chat-cache.ts`) | rows keyed `<base path>:<bot>`       | transcript snapshots and the roster, in the Expo cache's record shape | cleared     |
| `sessionStorage`                                    | `hermie:<base path>:route`           | the route, across one sign-in                                         | cleared     |

`<base path>` is the prefix, or `/` at the root, so two gateways behind different prefixes on one host keep
apart. A key is identity-bound unless it starts with `device.`, so a key nobody classified is cleared rather
than left for the next person. The language choice is still stored by `src/i18n/locale.ts` under its own
key, `hermie.language` (docs/i18n.md). A browser that refuses a store gets a page that works and forgets:
values are kept in memory, and the cache falls back to memory on its first failure.

### Seams

Nothing outside `src/platform/` and `src/boot/` touches `window`, `localStorage`, `sessionStorage`,
`indexedDB`, `navigator`, `location` or `history` (lint). Each seam takes its browser object as an argument, so
the tests hand in their own:

| Seam                                                  | What                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `platform/key-value-store.ts`                         | `createKeyValueStore({ namespace })`: the Expo store's contract, namespaced |
| `platform/chat-cache.ts`                              | `chatCacheFor(namespace)`: IndexedDB, falling back to memory                |
| `platform/net-info.ts`                                | `networkWatcher`: `online` / `offline`                                      |
| `platform/visibility.ts`                              | `visibilityWatcher`: `visibilitychange`, `pagehide`, `pageshow`             |
| `platform/socket.ts`                                  | `createSocketFactory()`: the page's `WebSocket` for `GatewayConnection`     |
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

## Markdown

`src/markdown/` draws a message as React elements. The text goes through `@hermie/markdown` (`preprocessMarkdown`,
`splitBlocks`, then `marked.lexer` per block, the same three steps the Expo app and the corpus use) and the tokens
become elements; no HTML string is made anywhere, so there is nothing to sanitise.

```tsx
<Markdown text={message.text} gatewayBaseUrl={baseUrl} />
```

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

## Layout

```
index.html                  the document: policy, one module script, empty #root
vite.config.ts              base './', hashed assets, ASCII output, maps out of dist, dev server and proxy
vitest.config.ts            jsdom, fixed stand-ins for the injected version and commit
tsconfig.json               the client's code (DOM); tsconfig.node.json: the config files (Node)
scripts/
  write-build-manifest.mjs  dist/build.json
  source-commit.mjs         which commit this build is of (shared by the config and the manifest)
src/
  main.tsx                  the boot sequence and its screens (the only React outside features/)
  boot/                     frame guard, base path, auth mode and cookie session, sign-in bounce, boot
  core/                     the connection and its lifecycle, the roster controller, the advert, the chat
                            controller and the ingest (above)
  state/                    zustand vanilla stores: connection, bots, plugin, chats
  platform/                 the browser seams (above)
  test-support/             test doubles: an IndexedDB, a fetch, a fetch with a cookie jar, a chat
                            gateway, the page's visibility and network, and a copy of the Expo app's
                            reader's-own-chat directory for the sub-chats test
  markdown/                 a message as React elements (above)
  dev/                      development-only pages, not reached by the build (dev/markdown.html serves one)
  Placeholder.tsx           what a signed-in reader sees for now: heading and build label
  build-info.ts             version and commit injected by the build
  ui/base.css               page ground for both colour schemes (the policy forbids inline styles)
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
| `zustand` (5.0.15)                                                                   | runtime | the stores the ported controllers already use; about 1 kB, no dependencies. Declared for the work that follows: the smoke page does not import it, so it is not in the bundle yet                                                                           |
| `@hermes/shared`, `@hermie/gateway-client`, `@hermie/transcript`, `@hermie/markdown` | runtime | this repository's own packages (wire contract, gateway connection, transcript engine, Markdown core); used as they are. `@noble/hashes` comes in through `@hermie/gateway-client`. The boot uses `@hermie/gateway-client` (probe, cookie session, identity) |
| `@hermie/fake-gateway`                                                               | dev     | this repository's stand-in gateway; the boot's integration test runs it in process                                                                                                                                                                          |
| `vite` (7.3.6)                                                                       | dev     | the bundler and dev server                                                                                                                                                                                                                                  |
| `@vitejs/plugin-react` (5.1.4)                                                       | dev     | the JSX transform and fast refresh                                                                                                                                                                                                                          |
| `vitest` (3.2.7), `jsdom` (26.1.0)                                                   | dev     | unit and component tests in a simulated browser; `vitest` is also what the rest of the repository tests with                                                                                                                                                |
| `@testing-library/react` (16.3.3), `@testing-library/dom` (10.4.2)                   | dev     | component tests that query by role and text rather than by implementation; `@testing-library/dom` is a required peer of the React package                                                                                                                   |
| `axe-core` (4.13.0)                                                                  | dev     | the accessibility checker the Markdown fixture page is tested with (`markdown-fixtures.axe.test.tsx`); MPL-2.0, test-only, not in the bundle                                                                                                                |
| `@types/react`, `@types/react-dom`                                                   | dev     | type definitions for React                                                                                                                                                                                                                                  |
| `typescript`, `eslint`, `prettier`                                                   | dev     | from the repository root, shared with every workspace                                                                                                                                                                                                       |

Not added yet, because nothing uses them: `@playwright/test` and `@axe-core/playwright` for the end-to-end
and accessibility suites. `@hermie/markdown` brings `marked` (and `highlight.js`, which nothing here imports
yet) into the bundle once a screen renders a message. The licence text of every
runtime dependency is meant to ship in `dist/licenses.json` and be shown in About; that is not generated yet.
