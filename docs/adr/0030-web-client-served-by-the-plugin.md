# 0030. The web client is a pure client, served by the `hermie` plugin on the gateway's origin

- Status: Accepted
- Date: 2026-10-03
- Supersedes: [0015](0015-web-variant-on-its-own-port.md), [0025](0025-hermie-web-is-a-service-layer.md)
- Supersedes in part: [0017](0017-push-through-hermie-web.md) — Hermie Web's `--push` fallback and its
  VAPID key
- Amends: [0027](0027-desktop-is-a-webview-over-hermie-web.md)
- See also: [0024](0024-a-list-of-gateways.md), [0029](0029-expo-native-and-the-contract-directory.md)

0015 and 0025 stay in force until the cut-over in decision 18 is done; Hermie Web keeps running, and
keeps being the supported web version, until then.

## Context

### What Hermie Web is today

"Hermie Web" is two things under one name.

**The browser build.** The Expo app exported through React Native Web, with about forty `*.web.ts(x)`
files that replace the native modules: cookie sign-in, Web Push, an IndexedDB cache, a self-update row.

**A Node server, `packages/hermie-web`.** One process next to `hermes serve`, with no runtime
dependencies. [ADR-0015](0015-web-variant-on-its-own-port.md) made it a reverse proxy for exactly one
gateway, because a browser cookie belongs to an origin and the page has to be on the gateway's. ADR-0017
and [ADR-0025](0025-hermie-web-is-a-service-layer.md) then made it more than a proxy: it serves the static
export, answers a bootstrap request, runs a one-time setup page, keeps a service login to the gateway,
runs the push daemon and its senders, keeps a message cache on disk, offers an admin area with per-user
options, can act as an OIDC identity provider, and updates itself from a release zip.

### Why that is no longer the right shape

Three things changed between ADR-0017 and now.

- **The plugin already does the master work.** The `hermie` gateway plugin runs inside the gateway
  process. It sends push for every transport, reads device registrations from `ui_meta`, publishes a
  capability advert and injects device context. In process it needs no credential, pins no session and
  needs no OIDC refresh token. What it does not do is deliver Web Push to a browser subscribed through
  Hermie Web: the plugin keeps its own VAPID key and never publishes the public half, while the browser
  build subscribes with Hermie Web's key.
- **The gateway can serve files for a plugin.** In the fork's tree, `GET /dashboard-plugins/{plugin}/{file}`
  serves any file under an enabled plugin's `dashboard/` directory whose suffix is on an allow-list
  (`.js .mjs .css .json .html .svg .png .jpg .jpeg .gif .webp .ico .woff2 .woff .ttf .otf .map`), refuses
  path traversal, answers 404 for a directory, and sits behind the gateway's own authentication gate. It
  sets `Cache-Control: no-store` and nothing else, has no SPA fallback and no compression. The dashboard
  sets no `Content-Security-Policy` and no `X-Frame-Options` and registers no service worker. A plugin's
  own API routes mount only under `/api/plugins/<name>/`. This is upstream code by its history; it was
  read in the fork and not exercised against a plain upstream install.
- **The thing the proxy existed to fake is now true.** A page that the gateway serves is on the
  gateway's origin natively. There is nothing to proxy, no `Host` or `Origin` to rewrite and no cookie
  to re-scope.

The maintainer decided on 2026-10-02 that the web version is a **pure client** of the gateway, exactly
like the native apps, and that the plugin is the master. The client is React, Vite and TypeScript and
reuses `packages/gateway-client`, `packages/transcript` and `packages/hermes-shared`. Hermie has very
few users today, so the old web version gets no compatibility window beyond the staged removal in
decision 18. Security, privacy and documentation honesty are not relaxed.

### Options considered for the shape as a whole

1. **Keep a slim Node server that only serves the static client.** Rejected: it is still a second
   process on a second origin, which is what this change removes.
2. **Move the proxy into the plugin.** Rejected: there is nothing left to proxy.
3. **A pure client, built in this repository, served by the plugin on the gateway's origin.** Chosen.

At the time of writing none of this exists beyond a plan and a placeholder directory. The first client
build runs only on a test gateway, and Hermie Web is untouched.

## Decision

**A new browser client in `native/web` (package `@hermie/web-client`) is a pure client of the Hermes
gateway. It is built here, committed to the plugin repository as a verified bundle, and served by the
gateway itself on its own origin. There is no Hermie Web server in the end state.**

The numbers below are the decisions; each carries the options that were rejected.

### 1. The plugin is the only Hermie component on the gateway

Every responsibility of the Node server either already lives in the plugin, moves into it, moves into the
client, or is dropped. The full inventory is in Consequences. Rejected: a slim static server and a proxy
inside the plugin (both above).

### 2. The built client is committed to the plugin repository and served by the dashboard's static route

The files live under `dashboard/app/` in `fullstackstudio-org/hermie-plugin`. The URL is
`<gateway>/dashboard-plugins/hermie/app/index.html`. No new Python serves a byte. The bundle's shape is
constrained by the route and by the plugin scanner (decision 3): extensions only from the route's
allow-list (so `manifest.json`, not `.webmanifest`), no source maps in the plugin tree, ASCII-only
output, no file over 900 kB, the whole bundle at most 3 MB and 80 files.

Rejected:

- **A FastAPI route in the plugin's `plugin_api.py`.** It would give control over headers and caching,
  but plugin routes mount only under `/api/plugins/hermie/`, where an unauthenticated visitor gets a
  JSON 401 instead of the sign-in redirect, and on an ungated gateway a document or `<script>` request
  cannot carry the session-token header at all.
- **Fetch the client at runtime, pinned by version and hash.** An unprompted outbound request from the
  gateway, which the plugin's design refuses; zip handling in a process with the gateway's trust; no
  web client on an air-gapped gateway; and the files would land in the scanned plugin tree anyway.
- **Build from source at install.** It needs Node on the gateway.
- **A second, static-only plugin for the client.** It would isolate scanner risk and repository growth,
  but it is a second install, and the plugin's rule is that a person installs a plugin once. Kept as
  the fallback if the scanner or the repository size becomes a problem (open decision 1).
- **Inserting a route into the dashboard app from plugin code.** It reaches into private internals and
  is matched after the SPA catch-all.

### 3. Supply chain: the bundle is pinned by a manifest, proven by a rebuild, gated by the scanner and rolled back by a revert

- `dashboard/app/build.json` records the app repository, the 40-character source commit, the client
  version, and the SHA-256 and size of every file. The build is deterministic: no timestamps, sorted
  keys, identical output for identical source.
- A CI job in the plugin repository checks out the app repository at that commit, requires the commit
  to be an ancestor of the app's `main`, rebuilds, and compares every byte. A bundle that is not the
  build of reviewed, merged source cannot pass.
- A second CI job runs the Hermes plugin scanner (fork and upstream, each at a pinned commit) over the
  plugin tree and fails unless the verdict is `safe`. The app repository's CI runs the same scan on
  its `dist/` so a problem is found before an import. The build emits ASCII only (non-ASCII escaped),
  so the scanner's invisible-unicode check cannot fire on a legitimate string. A daily run against the
  newest scanners only reports.
  _Amended 2026-10-03 (HERM-192):_ the fork scanner, which the gateways run at install and update, is the
  blocking gate in both repositories; upstream is informational (its verdict and findings are listed in the
  import pull request and the changelog, and only `dangerous` from it blocks). The protocol's secure prompt
  is named `sudo`, an honest bundle carries that word, and only the fork judges it by its token rather than
  by its minified line. That judgement lowers a key or comparison to a visible `low` only in a plugin whose
  JavaScript names no route to a process, eval or module load, and it has stated limits: JavaScript only
  (Python and shell consumers are judged by their own rules), nothing under the scanner's excluded
  directories (`node_modules` …), and no route built without a name it knows. See plan W3 and
  `native/web/README.md`.
- A bundle import is a pull request in the plugin repository with a reviewer pass. For a bundle-only
  change the review is a checklist: only `dashboard/app/**`, the version and the changelog changed, and
  both CI jobs are green. Nothing auto-merges.
- The plugin verifies the files against `build.json` once, when it loads, and withholds the advert
  entry for the client when they differ.
- Rollback is a revert of the import commit on the plugin's `main`. The hosts pick it up within their
  update interval and, because the route answers `no-store` and the service worker never caches the
  shell (decision 14), the next page load is the old client.

The scanner gate is an availability control as well as a security one: after a `hermes plugins update`
a `dangerous` verdict disables the whole plugin, push included.

Rejected: Subresource Integrity on the entry tags (same origin, same directory, and dynamic imports are
not covered), and signing the bundle (the plugin tree it sits in is not signed either; manifest plus
rebuild gives review, which was the missing property).

### 4. One URL, hash routing, relative assets

`index.html` has to be named in the URL because the route 404s on a directory, and there is no SPA
fallback, so routes live in the fragment: `#/`, `#/chat/<bot>`, `#/chat/<bot>/s/<session id>`,
`#/settings/<section>`. Assets are relative (`base: './'`), and the base path is derived by stripping
the known suffix from `location.pathname`, so a gateway behind a path prefix works. A router of our own
(about a hundred lines over `hashchange`). The fragment does not survive the gateway's `/login`, so it
is stashed in `sessionStorage` before a sign-in bounce and restored once afterwards.

Rejected: a routing library (six routes) and path routing (it needs a fallback the core route does not
have). A short alias such as `/hermie` is a fork change or a reverse-proxy redirect, not part of this
(open decision 9).

### 5. Authentication is the gateway's own session; the client holds no credential

- **Gated gateway:** the `HttpOnly` cookie session the dashboard already issues. REST carries no auth
  header; every WebSocket dial mints a single-use ticket, as `CookieSessionCredentials` already does
  ([ADR-0005](0005-ticket-per-websocket-dial.md)). Sign-in and sign-out happen on the gateway's own
  `/login` and `/auth/logout`. The client renders no password field for the gateway, so password
  managers, passkeys and SSO work as they do for the dashboard. A rejection always means "sign in
  again".
- **Ungated gateway:** supported after the first milestone. The session token is read from the
  dashboard's own bootstrap (`window.__HERMES_SESSION_TOKEN__` in the page the gateway serves at its
  root), held in memory only and read again on every load.
- **Native PKCE is not used.** It ends on a loopback redirect a page cannot catch and would put a
  bearer token in script-readable storage ([ADR-0004](0004-native-pkce-via-webview.md) stays as it is
  for the native apps).

Rejected: storing any token in `localStorage` or IndexedDB, and a sign-in form inside the client (a
second place a password is typed, and a phishing template).

### 6. Security headers come from the document, because the route sets none

`index.html` carries a `Content-Security-Policy` meta tag: `default-src 'none'`; `script-src`,
`style-src`, `font-src`, `connect-src`, `worker-src` and `manifest-src` all `'self'`; `img-src 'self'
data: blob:`; `media-src 'self' blob:`; `base-uri 'none'`; `form-action 'none'`; `object-src 'none'`;
`frame-src 'none'`; `require-trusted-types-for 'script'`. There is no inline script, no inline style
element and no `eval`. `frame-ancestors` cannot be set from a meta tag, so the entry module refuses to
render when `window.top !== window.self`. The fork can add real headers later.

Rejected: relying on the dashboard for headers (it sets none), and `'unsafe-inline'` for styles (React
sets styles through the CSSOM, which the policy allows).

### 7. The session layer is ported, not redesigned

The React-free controllers and stores of the Expo app (the connection lifecycle, the bots and chat
controllers, the session model, the zustand stores) are copied into `native/web/src/core` and
`src/state`, adapted to browser seams, and their tests ported to vitest. They keep their names and
structure so later fixes can be compared. `packages/transcript`, `packages/gateway-client` and
`packages/hermes-shared` are used as they are. The Expo copies are frozen; the web copies are where
behaviour moves on. The gateway registry of [ADR-0024](0024-a-list-of-gateways.md) is not ported: a
page has exactly one gateway, its origin.

Rejected: extracting a shared package out of the Expo app (a refactor through a large app that is being
retired, to save a copy that will be deleted); rewriting the chat controller from scratch (thousands of
lines of earned edge cases: foreign turns, queued sends, steer, reconcile windows); a state library
beyond zustand.

### 8. One ingest path, one commit per frame, and a transcript list behind a boundary proven by a spike

Events are applied to the engine in wire order and committed to the store once per animation frame (on
a timer while the tab is hidden, because `requestAnimationFrame` does not fire there). Item views are
memoised on `(item.id, item.version)`. The list is a `TranscriptList` component that uses
`content-visibility: auto` with intrinsic-size estimates and bottom anchoring ported from the Expo web
code. A spike measures it against stated budgets before the chat screen is built on it. The
pre-approved fallback, without a new architecture round, is `@tanstack/react-virtual` behind the same
boundary.

Rejected: a virtualiser up front (variable-height streaming rows are where virtualisers jank), and a
Web Worker for the engine (30 events a second is far below a frame's budget, and a worker would force
every state to be serialised).

### 9. Markdown: one shared pure core, DOM renderers, no HTML injection

The pure Markdown modules move from the Expo app to a new package, `packages/markdown`
(`@hermie/markdown`), which becomes the source the `contract/markdown` corpus is recorded from. The web
client renders its block model to React elements. Raw HTML in a message is shown as text.
`dangerouslySetInnerHTML` and `innerHTML` are banned by lint and by Trusted Types. Links open in a new
tab with `rel="noopener noreferrer"` and only for `http:`, `https:` and `mailto:`. Images load only from
the gateway's own origin; a remote image is shown as a link (open decision 6). Highlighting,
mathematics and Mermaid diagrams (flowchart, sequence, pie, from our own parsers and layouts, drawn as
SVG elements) are lazy chunks.

Rejected: the `mermaid` library (megabytes, and it renders through `innerHTML`), `react-markdown` and
remark (a second parser to keep in step with the corpus), and a sanitiser (there is nothing to sanitise
when no HTML is emitted).

### 10. Strings are generated from `contract/i18n/catalogue.json`

`scripts/i18n` gains a web emitter that writes typed accessors and per-locale data, checked by
`npm run i18n:check`, the same arrangement as the Apple String Catalog. Strings only the web client has
live in a hand-written table in English, Dutch and German with a coverage test. The language follows
the browser, with a picker in Settings. The TypeScript tables in the Expo app stay the source while the
Expo app lives.

Rejected: importing the Expo tables directly (it ties the client to a directory that is going away),
and an i18n library (the catalogue is text, lists and templates, and `Intl` covers plurals and dates).

### 11. Theming is CSS custom properties: a scheme plus one tint

Light, dark or system, and one tint — the reduction the native apps made. The per-chat colour stays data
from `ui_meta`, and unknown theme fields are carried through untouched. Reduced motion, increased
contrast and 200 % zoom are honoured. No CSS framework and no CSS-in-JS runtime (the policy in decision
6 forbids what such a runtime needs); CSS modules from Vite.

### 12. Protocol coverage equals the native apps'

The client handles the same protocol surface as the native apps: the secure-input prompts (`secret`,
`sudo`, `vault.unlock_prompt`, `vault.code`, `vault.save_login`), a notice and a JSON-RPC error for
`preview.*`, `terminal.read`, `window.read` and `tour`; a truncated replay answered by a full refetch;
identity from `/api/auth/me`; `gateway.capabilities`, `notification.show` and `notification.clear`,
`connection.request` and `connection.update`, `session.status`, `session.resume_progress`; clarify
skip and cancel-all; approval choices `all`, `smart_denied`, `allow_session`, `allow_permanent`;
`todo.updated`; `tool.generating`; and the `confirm` request at level `plain` only. As in the Swift
app, the engine stays a parity reference: new request kinds are handled beside it, not in it.

What a browser cannot do is stated in the product:

- **No device authentication.** The client advertises `confirm: ["plain"]`. A `device_auth` request is
  never sent to it, and if one arrives it answers a JSON-RPC error, never a decline.
- **No keychain.** No credential is kept at all (decision 5).
- **No background socket.** The connection lives while the page is visible; push covers the rest.

### 13. The plugin owns the only VAPID key and publishes its public half

The advert gains `webPush.publicKey` and the capability `push.webpush.key`. A `webpush` registration
row gains an optional `applicationServerKey`; the plugin skips a row that names another key and treats
a 403 from the push service as a key mismatch that retires the row. The client re-subscribes when the
advert's key differs from its subscription's. Web Push payloads are encrypted to the browser's keys
(RFC 8291), so the rule that no message text leaves unless it is end-to-end encrypted holds by
construction. A preview rides only when the device asked and the gateway allows it; the default is a
bot name and an event type, as in ADR-0017. The service worker shows the notification and routes the
click; an action never answers by itself, and the app re-validates it against the gateway's open
requests, as ADR-0017 requires.

Rejected: a route that serves the public key (the advert already reaches every client), and copying
Hermie Web's key into the plugin (a manual step per gateway, to save a few people one re-subscribe).

### 14. Installable, online-only, and the service worker never serves the app shell

The worker is `dashboard/app/sw.js`. Its scope is the app directory and cannot widen, because the route
sends no `Service-Worker-Allowed`. It handles `push` and `notificationclick` only; with no fetch handler,
a rolled-back or revoked client can never be resurrected from a cache. Transcripts are cached in
IndexedDB for instant paint and cleared on sign-out. Offline start is out of scope. A cache of
content-hashed assets (cache-first for hashed files, network-only for `index.html`) is an optional later
task that keeps the rollback property.

Rejected: a precaching service worker in the Workbox style — a stale shell is a supply-chain rollback
failure.

### 15. No admin surface

Operator settings are plugin config keys in `config.yaml`, as today. The client shows a read-only "This
gateway" panel from the advert. Per-user service options, branding, flags, the message cache and the
built-in OIDC provider are dropped.

Rejected: porting `/admin` into the plugin — a server-rendered admin on a surface with no roles would
make every signed-in caller an administrator.

### 16. The desktop shell loads the gateway's client URL

[ADR-0027](0027-desktop-is-a-webview-over-hermie-web.md) chose a remote page over a bundled export, and
that choice stands; what changes is the address. A stored entry becomes a gateway address, and the
window navigates to `<gateway>/dashboard-plugins/hermie/app/index.html`. The gateway's origin also
serves the dashboard and other dashboard plugins, so the shell's bridge capability is narrowed from the
origin to the client's path, and the bridge guard checks the calling page's path. The macOS build of
the shell still ends with the native Mac release ([ADR-0029](0029-expo-native-and-the-contract-directory.md));
Windows and Linux remain.

### 17. The client has its own version

Semver in `native/web/package.json`, starting at `0.2.0`, shown with the commit (`0.2.0 (abc1234)`). A
plugin release imports a client build, and the advert names both versions. The external release script
stops deploying Hermie Web and gains a step that prepares the import pull request.

Rejected: tying the client version to the plugin's, because a plugin fix would renumber an unchanged
client.

### 18. Removal is staged and additive first

| Stage | What happens                                                                                                                                                                                          | Gate to the next stage                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A     | The new client is on the gateways beside Hermie Web.                                                                                                                                                  | Everyone who uses it has used it for daily work and no blocker is open.                                                   |
| B     | Web Push moves to the plugin's key; then Hermie Web's `--push` is switched off.                                                                                                                       | A test notification arrives in the new client on each gateway, and Expo and relay rows are still delivered by the plugin. |
| C     | The old address redirects to the new URL at the reverse proxy; the service is stopped and disabled; its stored gateway sign-in is revoked; its state directory is archived and deleted after 14 days. | Seven days without needing to go back.                                                                                    |
| D     | Hosted deployments switch first; then `packages/hermie-web`, `deploy/web`, `deploy/k8s`, the image workflow and the Expo web specifics are deleted.                                                   | Review.                                                                                                                   |

At no stage is anyone without a working web version. Two preconditions decide whether stage C is safe on
a given gateway: the gateway's `dashboard.oauth.self_hosted.issuer` does not point at Hermie Web (if it
does, stopping Hermie Web breaks every sign-in, and that gateway must move to another provider first),
and nobody relies on `readOnly` or `allowedBots`. Stage C is reversible until the state directory is
deleted; stage D is a git revert, and the published image and release zip of the last Hermie Web version
stay available, marked unmaintained.

Old browser state does not carry over: the new client is on another origin than Hermie Web was, so it
starts with empty storage, a new installation id and a new push subscription. Old `webpush` rows stay
in `ui_meta` and the plugin retires them on the first 403, 404 or 410. No data migration is built.

## Threat model

**The central fact is that the client runs on the origin that also serves the dashboard API.** A
script-injection bug in the client would act with the signed-in person's session against every `/api/*`
route: configuration, files, the terminal, every profile. That is operator access to the gateway host.
The old browser build had the same reach, since Hermie Web proxied `/api/*` onto its own origin, but the
stakes are stated here and drive these rules:

- **No HTML injection path exists.** No `innerHTML`, no `dangerouslySetInnerHTML`, Markdown never emits
  raw HTML, Mermaid and mathematics are our own SVG elements, highlight output is parsed into spans.
  Enforced by lint, by `require-trusted-types-for 'script'`, and by a test that feeds hostile Markdown.
- **The policy in decision 6** limits scripts to the client's own files, connections to the own origin,
  and forbids frames, forms and plugins. Links use an allow-list of schemes. Remote images are not
  loaded, because a bot's output could otherwise leak data through an image URL.
- **Secret prompts cannot be drawn by a bot.** A page cannot prove it is the real app, and a bot controls
  some of the words shown. Prompts render in an app-owned modal layer that transcript content cannot draw
  into; the bot-supplied strings are plain text in a quoted block, never Markdown and never links; the
  input is masked and cleared on answer, cancel and timeout; the value goes straight into the JSON-RPC
  answer and is never placed in a store, the transcript, the cache, a log line or an export.
- **The reverse direction is accepted.** Other code on the origin (the dashboard, other dashboard
  plugins) can read the client's storage. That code is already operator-trusted, which is why nothing
  secret is stored.
- **The plugin contributes files; the gateway decides who may fetch them and authenticates every API
  call.** The client holds no credential and adds no authentication of its own.

**What is deliberately not claimed.**

- `confirm` at level `plain` protects against a slip of the finger, not against a stolen session.
- `modules.web: off` and the integrity check withhold the _advert_, not the files, which stay fetchable
  through the dashboard route. The client refuses to run when the advert says `off`, as a courtesy and
  not as a boundary.
- On plain upstream there is no `frame-ancestors` header and no `nosniff` on the static files, so the
  frame guard is JavaScript only. A same-site sibling subdomain could frame the client with a session.
- On an ungated gateway the static files are as public as the dashboard's own bundle; every `/api/*` call
  still needs the token.

## Consequences

### Where each responsibility goes

| Responsibility of Hermie Web                                                                           | Where it goes                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static hosting                                                                                         | The plugin's files, served by the dashboard's route (decision 2).                                                                                         |
| SPA fallback                                                                                           | Dropped. The client uses hash routing (decision 4).                                                                                                       |
| Reverse proxy, `Host`/`Origin` rewrite, `--pass-host`, cookie attribute rewrite, `--login-return`      | Dropped. The client is same-origin natively.                                                                                                              |
| `--no-oidc` route refusal                                                                              | Dropped. Which providers a gateway offers is gateway configuration.                                                                                       |
| `/hermie/config.json` bootstrap                                                                        | The client reads `/api/status`, `/api/auth/providers` and the advert.                                                                                     |
| `/setup` and the saved setup                                                                           | Dropped. The gateway is the page's own origin; there is nothing to choose.                                                                                |
| Service gateway link, stored credentials (session token, OIDC refresh token), `hermie-web login`       | Dropped. In process the plugin needs no credential.                                                                                                       |
| Push watcher (resume every chat, poll `approval.pending`, classify rows)                               | The plugin's hooks, which exist.                                                                                                                          |
| Push senders: Expo, relay                                                                              | The plugin, which has them.                                                                                                                               |
| Push sender: Web Push, the VAPID key pair, `GET /push/vapid-public-key`                                | The plugin sends; it publishes its public key in the advert (decision 13). One key, not two.                                                              |
| Subscription storage                                                                                   | The gateway's `ui_meta`, unchanged, written by the client.                                                                                                |
| Announce (the availability stamp in `hermie-app.push`)                                                 | Dropped. The advert is the signal; the stamp wrote into an app-owned key.                                                                                 |
| Inbound classification for bot-to-bot DM                                                               | Dropped. No hook fires for it, and `dm` is already a legacy type in the push contract.                                                                    |
| Dedupe, retirement, receipts state                                                                     | The plugin's own state, which exists.                                                                                                                     |
| Message cache (`/hermie/cache`)                                                                        | Dropped. The client reads the REST tail and keeps its own IndexedDB cache.                                                                                |
| Admin: push type ceiling, preview ceiling                                                              | Plugin config keys, which exist.                                                                                                                          |
| Admin: admins list, local admin secret, people seen, per-user `allowedBots`, `readOnly`, `pushAllowed` | Dropped. They were proxy-enforced guard rails; a pure client cannot enforce them and the gateway has no per-user permission model.                        |
| Admin: branding, feature flags                                                                         | Dropped (open decision 4).                                                                                                                                |
| Admin: reset setup, update                                                                             | Dropped.                                                                                                                                                  |
| Built-in OIDC provider                                                                                 | Dropped (open decision 3). The gateway ships a `basic` password provider; a second identity root in a process that no longer exists is not worth porting. |
| Identity memo                                                                                          | Dropped.                                                                                                                                                  |
| Self-update, `--rollback`, release zip, `SHA256SUMS`                                                   | The plugin's own update (`hermes plugins update hermie`, the hosts' timers). Rollback is a git revert (decision 3).                                       |
| `/healthz`                                                                                             | The gateway's `/api/health` and `/api/status`; the client's `build.json` names the build.                                                                 |
| Per-user options in the app (device context, mutes, layout)                                            | The client, through `ui_meta`, with the contract unchanged.                                                                                               |
| Server-page i18n                                                                                       | Dropped with the pages.                                                                                                                                   |
| PWA manifest and service worker                                                                        | The client (decision 14).                                                                                                                                 |
| Expo web specifics                                                                                     | Dropped after the cut-over (decision 18).                                                                                                                 |
| Desktop shell target                                                                                   | The gateway's client URL (decision 16).                                                                                                                   |
| Docker image, Kubernetes manifests, npm package `@hermie/web`                                          | Dropped (decision 18); Hosted deployments switch first.                                                                                                   |

### What the client holds, and what it does not

No credential is ever written to browser storage. `localStorage`, with keys prefixed by the base path,
holds device-local settings (language, scheme, tint, text size), the installation id, last-read
watermarks and a layout cache; identity-bound keys go on sign-out. IndexedDB holds transcript
snapshots, a roster cache and an attachment URL cache, all cleared on sign-out; a setting turns the
transcript cache off. `sessionStorage` holds the route fragment across a sign-in bounce. In ungated mode
the session token, and every secret-prompt value, live in memory only. The cached transcripts are plain
and readable by the origin; the docs say so.

### What the person loses

- **The admin area, per-user limits and branding.** Operator settings are plugin config keys.
- **The built-in OIDC provider.** A gateway that used it must move to the gateway's `basic` provider or
  an external one before cut-over.
- **The message cache.** The client is one hop from the gateway and keeps its own cache.
- **Bot-to-bot DM notifications.** Only the daemon could produce them. A hook in the fork could bring them
  back (open decision 10).
- **Session-token (ungated) gateways at first.** The first build refuses them and points to the native
  app; support follows (open decision 5).
- **Offline start.** The shell is not cached, by design (decision 14).
- **Device authentication, a keychain and a background socket**, as stated in decision 12.
- **Remote images** load only as links (open decision 6).
- **Headers on plain upstream.** The frame guard and `nosniff` are limited as the threat model says.

### What it costs

- **Every page load is a full download.** The route answers `no-store` and does not compress, so the
  budgets are hard: at most 700 kB of initial JavaScript and 230 kB gzipped, with lazy chunks for what
  can wait. A TLS proxy in front usually compresses.
- **The plugin repository grows with every bundle.** Imports happen at plugin releases only; revisit at
  200 MB, when the fallback in open decision 1 comes into play.
- **Two repositories move together** (advert fields, the fake gateway, the contract). Advert members and
  row fields are additive and read tolerantly, and the fake gateway is updated first.
- **A scanner verdict can take the plugin down**, push included. That is why the scan runs in both
  repositories and nightly.
- **Windows and Linux desktop users update the shell once**, because old shells pointing at a Hermie Web
  address stop working at stage C.
- **A change to a shared package is still a change to the corpus.** `packages/gateway-client` and
  `packages/transcript` are covered by `contract/` ([ADR-0029](0029-expo-native-and-the-contract-directory.md));
  web-only helpers go in `native/web/src/core`, not in the shared packages, unless native needs them.
- **The plugin's own documents stop being true as written.** Its design note says it adds no inbound
  surface and uses no HTTP routes for serving; both change, and its security note has to state the same
  origin fact. They are rewritten with the plugin change.

### What stays

The registration schema, the `seen` heartbeat, the payload policy and the validated-action rule of
ADR-0017, and its two amendments, are unchanged. The plugin's advert only gains members, and a
registration row only gains one optional field. The native apps and the Expo Android app are
unaffected. Everything works against plain upstream Hermes except `confirm`, which needs the fork.

### Other records

- [ADR-0015](0015-web-variant-on-its-own-port.md) and [ADR-0025](0025-hermie-web-is-a-service-layer.md):
  superseded; in force until the cut-over.
- [ADR-0017](0017-push-through-hermie-web.md): the `--push` fallback is retired (switched off at stage B,
  deleted at stage D), and the plugin's key becomes the only VAPID key. Registration, heartbeat, payload
  and validation rules stand.
- [ADR-0027](0027-desktop-is-a-webview-over-hermie-web.md): amended. The shell still loads a remote page;
  that page is the gateway's client URL (decision 16).
- [ADR-0024](0024-a-list-of-gateways.md): see also. A page has one gateway, so the registry does not apply
  to it.
- [ADR-0029](0029-expo-native-and-the-contract-directory.md): see also. It reserved `native/web` and said
  Hermie Web would keep serving the Expo export until a native web build exists; the build now exists, but
  the server it was to be served by does not.

## Open decisions, with the defaults work proceeds on

| #   | Decision                                                                                                 | Default                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the built client lives: inside the `hermie` plugin repository, or in a second static-only plugin   | Inside the plugin; the second plugin is the fallback if the scanner or the repository size becomes a problem.                                                 |
| 2   | Review of bundle-only plugin pull requests                                                               | A reviewer checklist pass (paths, versions, both CI jobs green), not a full code review; no auto-merge.                                                       |
| 3   | Hermie Web's built-in OIDC provider                                                                      | Dropped, not ported. A gateway without an identity provider uses the gateway's `basic` provider. Needs confirmation that no gateway uses the built-in issuer. |
| 4   | Admin area, per-user service options (`readOnly`, `allowedBots`, `pushAllowed`), branding, feature flags | Dropped; operator settings are the plugin's config keys.                                                                                                      |
| 5   | Session-token (ungated) gateways in the browser                                                          | Supported after the first build, by reading the dashboard's own bootstrap token, in memory only.                                                              |
| 6   | Remote images in a transcript                                                                            | Never loaded automatically; shown as a link.                                                                                                                  |
| 7   | Look of the web client                                                                                   | Follows the native apps' layout (sidebar and chat), system fonts, a scheme plus one tint; a visual design pass after the first build.                         |
| 8   | Client version line                                                                                      | Independent semver from `0.2.0`, shown with the commit; the plugin version moves separately.                                                                  |
| 9   | A short URL such as `/hermie`                                                                            | Not initially; a generic alias in the fork or a redirect at the reverse proxy afterwards.                                                                     |
| 10  | Bot-to-bot DM notifications, which only the daemon could produce                                         | Gone with the daemon (already a legacy type in the push contract); a fork hook could bring them back later.                                                   |
| 11  | When Hosted deployments switch                                                                           | After stage A; the `hermie-web` image stays published and frozen until then.                                                                                  |
| 12  | Hermie Web state directories after stage C                                                               | Archived, the stored sign-in revoked at the gateway, deleted after 14 days.                                                                                   |
| 13  | A route that sends a test notification to one of the caller's own devices                                | Built with the notification work; it can be cut without affecting anything else.                                                                              |

## Not verified when this was written

These are assumptions the work has to prove. Where there is a fallback, it is named.

- That a Vite build of this workspace is byte-reproducible across machines. The bundle verification in
  decision 3 depends on it; if it fails, the plugin's CI builds and commits that output through a
  reviewed pull request instead.
- That the dashboard route behaves the same on a plain upstream install as in the fork's tree.
- What the production hosts' plugin update step runs (a plain `git pull` or `hermes plugins update`,
  which rescans) and whether either gateway uses Hermie Web's built-in OIDC issuer, branding, flags or
  per-user options.
- Browser behaviours the acceptance checks name: Safari accepting `connect-src 'self'` for a `wss:`
  socket, scroll anchoring, a manifest served as `application/json`, credentialed manifest and icon
  fetches, and Web Push on iOS only for an installed web app.
- Whether Tauri's remote capability patterns can be narrowed to a path; the fallback is a path check in
  the bridge guard.
- How the fork treats a second `client.capabilities` call (merge or replace).
- Whether any Hosted tenant exists; if one does, its roll-out order is written before the switch.
