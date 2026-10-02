# 0015. The web variant is one small server on its own port, and the gateway is same-origin through it

- Status: Superseded by [0030](0030-web-client-served-by-the-plugin.md), which leaves this record in force until its cut-over
- Date: 2026-09-20

## Context

Hermie has been three targets built from one source: iOS, Android, and the Mac (which since
[ADR-0011](0011-mac-via-the-ipad-build.md) is the iPad build). Every one of them is installed. A
person who runs `hermes serve` on a home server and wants to talk to their bots from a work laptop,
a borrowed machine or a phone they cannot sideload onto has nothing to install and no answer.

The obvious answer is a browser build: Expo can already export one, and React Native Web draws the
same components. What is not obvious is **how that build talks to the gateway**, and that is the
whole decision.

### What a browser cannot do

Three of the four things the native clients rely on are simply unavailable in a page.

- **Extra request headers on a WebSocket.** `new WebSocket(url, protocols)` is the entire API.
  There is no third argument and no header equivalent. React Native's constructor takes
  `{headers}`, which is how a gateway behind Cloudflare Access is reached today.
- **The RFC 8252 loopback redirect.** [ADR-0004](0004-native-pkce-via-webview.md)'s sign-in ends at
  `http://127.0.0.1:<port>/callback`, caught by the app. A page cannot listen on a port.
- **A keychain.** `expo-secure-store` has no web implementation, and no browser API is an
  equivalent: whatever the page can write, the page can read.

### What the gateway already has, and already guards

The gateway has a browser session flow of its own — it serves its own dashboard. `/auth/login`
starts an OAuth round trip, `/auth/password-login` takes a user name and password, and both end
with `HttpOnly` cookies. `/api/auth/me` confirms the session and `/api/auth/ws-ticket` mints the
single-use subprotocol ticket that [ADR-0005](0005-ticket-per-websocket-dial.md) describes — a
mechanism that exists _because_ browsers cannot put a credential on an upgrade.

It also guards itself. `hermes_cli/web_server_chat.py` refuses a WebSocket upgrade whose `Host` is
not a host it knows, and refuses an `Origin` that does not match that host; the HTTP middleware
applies the same check. That is a DNS-rebinding defence and it is correct: without it, any page on
the internet could point a name at `127.0.0.1` and drive an agent that executes commands.

A cookie belongs to an origin. An `Origin` guard belongs to a host. Both facts push in the same
direction.

### Options considered

1. **A static build the user hosts anywhere, talking to the gateway cross-origin.** Requires CORS on
   the gateway, `SameSite=None; Secure` cookies (so: TLS, always), and a relaxed Origin guard — that
   is, weakening the rebinding defence on a server that runs shell commands. Rejected.
2. **A browser extension.** Would solve headers and origins, and would mean shipping and maintaining
   three store listings for three browsers to avoid writing one ninety-kilobyte server. Rejected.
3. **Serve the app FROM the gateway.** Upstream would have to ship Hermie's bundle, which makes
   Hermie's release cadence upstream's problem and a fork's bundle upstream's liability. Rejected —
   and [ADR-0006](0006-single-gateway-no-relay.md)'s spirit is that Hermie does not ask upstream for
   anything it can do itself.
4. **One small process next to the gateway, on its own port, that serves the app and proxies the
   gateway onto the same origin.** Chosen.

## Decision

**Hermie Web** (`packages/hermie-web`, published as `@hermie/web`) is a Node server that does exactly
two things: it serves the exported browser build, and it proxies one fixed gateway onto its own
origin.

- `/api/*`, `/auth/*`, `/login*` and `/logout*` go to the gateway. Everything else is the app, with
  `index.html` as the SPA fallback.
- Every proxied request has its `Host` and `Origin` rewritten to the gateway's own
  `dashboard.public_url`, and carries `X-Forwarded-For`, `-Proto` and `-Host` from the browser. The
  gateway's guards therefore see a request from a host they recognise, and still learn the real
  client through the forwarded headers when `dashboard.trusted_proxies` names Hermie Web.
- The WebSocket upgrade is proxied by piping the raw sockets, so subprotocol negotiation — the
  ticket — and the close codes are exactly what the two ends agreed.
- The app authenticates with `CookieSessionCredentials`: no header on REST, `credentials: 'include'`
  so the browser attaches the cookie, and a ticket minted per dial. A rejection is always "sign in
  again"; there is no refresh token within reach.
- Because the origin is fixed, the onboarding wizard has no address step on the web. The gateway is
  `window.location.origin`, and `/hermie/config.json` tells the app which gateway host is behind it
  so the wizard can show it.

**The gateway is fixed at process start.** No path, header or query parameter can redirect the
proxy. A proxy a browser could steer would be an open relay onto whatever else listens on the
operator's loopback interface.

**Zero runtime dependencies.** Node's own `http`, `stream` and `zlib` cover all of it. The only
thing that argued for `ws` was the upgrade, and terminating the WebSocket there would have meant
re-offering the subprotocol list and re-framing every message for no benefit.

## Consequences

**What this buys.** A browser client with no installation, on the same release cadence as the apps,
reachable from anything with a URL — and a deployment story that ends at "put TLS in front of it",
which every reverse proxy and Tailscale Serve already do.

**Hermie Web is inside the perimeter, not on it.** It binds to `127.0.0.1` by default and it
authenticates nobody: the gateway does that. Exposing the port means putting TLS and, if you want
one, an access proxy in front — `deploy/web/README.md` has the configurations. The extra headers an
operator can configure for a gated gateway are NOT available to the browser build, and cannot be:
that perimeter now belongs in front of Hermie Web.

**There is no keychain on the web, and the app says so.** `secret-store.web.ts` is IndexedDB with a
`localStorage` fallback, documented as storage rather than as a keychain. In practice a Hermie Web
install keeps no bearer token at all — the session is the gateway's cookie, which the page cannot
read — but anything the shared code does route through that store is protected by the origin and
nothing else. Clearing site data signs the user out.

**One more artefact to release.** `hermie-web.zip` and a Docker image, built by CI, plus a
`web:build` step in `check` so the export cannot rot unnoticed.

**Self-update is offered where the install shape allows it.** A directory install can replace itself
(download, verify against the release's `SHA256SUMS`, unpack, flip a `current` symlink, exit for the
supervisor); Docker and `npm -g` answer `canSelfUpdate: false` and name the command that does work.
The digest proves the bytes match the release listing and https proves they came from GitHub —
**nothing here verifies a signature**, which is the same trust boundary as `npm i -g`, stated rather
than dressed up. `POST /hermie/update` is gated on the caller's own gateway session, checked by
putting their cookies to `/api/auth/me`: Hermie Web has no user database and is not going to grow
one.

**Two platform behaviours change shape rather than disappear.** File picking becomes an
`<input type="file">` whose cancel is a focus heuristic rather than an event, and haptics become a
no-op. Both are documented in the web section of [docs/platform-notes.md](../platform-notes.md).

**Amendment: its own domain, with the fork's gateway.** "Own port" was forced by an upstream gateway
that builds its OIDC callback out of one `dashboard.public_url`. The fullstackstudio-org fork lists
several origins (`dashboard.public_urls`) and builds the callback on the one a sign-in started on, so
there Hermie Web can live on a domain of its own and the "same host, another port" rule and the
`--login-return` redirect both fall away. `--pass-host` is the switch on this side: `Host` becomes
Hermie Web's own public host and the browser's `Origin` passes through, so the gateway's guards judge
the real origin instead of a rewritten one. The consequences:

- **Two public addresses to configure, not one.** `--public-url` stays the gateway's own address —
  the fallback and everything that names the gateway — and `--web-public-url` is Hermie Web's. They
  were kept apart on purpose: giving `--public-url` a second meaning under a switch would have
  silently changed what every existing deployment sends.
- **Hermie Web must be a trusted peer of the gateway** (loopback or `dashboard.trusted_proxies`), or
  the gateway ignores its `X-Forwarded-Proto` and an https origin never matches. That is a
  gateway-side setting this service cannot check from outside; it logs a reminder instead.
- **A wrong list degrades rather than breaks.** A startup probe that the gateway's Host guard answers
  with 400 switches back to rewriting, and the log names the entry to add. It cannot see a gateway
  bound to `0.0.0.0`, which accepts every `Host`.
- **The identity provider needs a callback per origin**, and the sessions are per origin too: signing
  in on one does not sign you in on the other.
- **An upstream gateway is unaffected.** The flag is off by default, and without it nothing here
  changes.
