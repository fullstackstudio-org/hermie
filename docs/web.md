# How Hermie Web works

Hermie Web is the fifth place Hermie runs: a browser tab, with nothing installed on the device. It
is one small Node process that sits next to `hermes serve`, serves the browser build of the app, and
proxies that one gateway onto its own origin.

This page explains the design — why the proxy is not a convenience, what the browser build does
differently, and how the self-update works. It is not the runbook. Installing, configuring and
operating it is [deploy/web/README.md](../deploy/web/README.md); the decision and the options that
were rejected are [ADR-0015](adr/0015-web-variant-on-its-own-port.md).

## What comes next

Hermie Web is being replaced by a web client that the `hermie` gateway plugin serves from the
gateway's own origin: no second process, no proxy, no service login. It is built in `native/web`,
not started yet in code, and everything on this page stays true until it ships and the cut-over is
done. [ADR-0030](adr/0030-web-client-served-by-the-plugin.md) records the decision, what moves into the
plugin, what is dropped (the admin area, the built-in OIDC provider, the message cache, the
self-update) and the staged removal of Hermie Web; this page is rewritten at the end of it.

## The problem: a cookie belongs to an origin

The native clients sign in with the gateway's native PKCE flow and carry a bearer token. A page
cannot: the flow ends on a loopback redirect that a page has no way to catch, and there is nowhere
safe to keep the token afterwards. What a browser _can_ use is the session the gateway already
issues to its own dashboard — an `HttpOnly` cookie, set by `/auth/*`, confirmed by `/api/auth/me`.

That cookie belongs to the gateway's origin. A page served from somewhere else cannot send it unless
the gateway relaxes two separate things at once: CORS with credentials, and the cookie's own
`SameSite` (which then requires `Secure`, and therefore TLS, everywhere). And there is a third guard
that cannot be relaxed at all without real cost. `hermes serve` refuses a WebSocket upgrade whose
`Host` it does not recognise, and refuses an `Origin` that does not match that host. That is a
DNS-rebinding defence on a server that executes shell commands: without it, any page on the internet
could point a name at `127.0.0.1` and drive an agent.

So a separate origin is not a deployment inconvenience to be worked around. It is the thing the
gateway is defending against, and the honest answer is not to argue with the guard but to stop being
cross-origin.

Two more browser limits shape the rest of the design. `new WebSocket(url, protocols)` is the whole
API — there is no way to put a header on the upgrade, which is why the ticket mechanism of
[ADR-0005](adr/0005-ticket-per-websocket-dial.md) exists in the first place. And there is no
keychain; whatever a page can write, a page can read.

## The shape: one process, two jobs

Hermie Web is `packages/hermie-web`, a Node 22 server with **zero runtime dependencies** — `http`,
`stream` and `zlib` cover all of it. It listens on **9120** by default, next to the gateway's 9119,
and binds to `127.0.0.1` unless told otherwise. It authenticates nobody; the gateway does that.

Every request is decided in one order:

| Path                                                | What happens                                     |
| --------------------------------------------------- | ------------------------------------------------ |
| `/healthz`, `/hermie/config.json`, `/hermie/update` | Answered by Hermie Web itself, never proxied.    |
| `/api/*`, `/auth/*`, `/login*`, `/logout*`          | Proxied to the gateway.                          |
| A path that names a file in the static build        | Served from disk.                                |
| Anything else                                       | `index.html`, so a deep link into the app works. |

The proxied prefixes are a list rather than a catch-all, so a typo falls through to the app instead
of quietly becoming a request to the gateway.

**The gateway is fixed at process start.** No path, header or query parameter can point the proxy
somewhere else. A proxy a browser could steer would be an open relay onto everything else listening
on the operator's loopback interface, which is a considerably worse thing to run than the app it was
meant to serve.

### What the proxy rewrites, and what it leaves alone

The browser sends Hermie Web's own address in `Host` and `Origin`, and the gateway has never heard of
it. Both are rewritten to the gateway's `dashboard.public_url`, which is what `--public-url`
configures and why a mismatch there shows up as a 403 rather than as a subtle bug. The real client
travels in `X-Forwarded-For`, `-Proto` and `-Host`, which the gateway reads when
`dashboard.trusted_proxies` names the machine Hermie Web runs on. `X-Forwarded-Host` is the client's
own `Host`, as it arrived; a gateway that trusts Hermie Web uses it only to choose among the origins
it lists, never to build an address of its own.

**Only Hermie Web's own `Origin` is rewritten.** An `Origin` (or `Referer`) counts as this service's
own when it is exactly `--web-public-url`, or names the request's `Host` or the `X-Forwarded-Host`
Hermie Web's own proxy set, on either scheme (a TLS proxy that sends no `X-Forwarded-Proto` must not
make the browser's `https` origin a stranger) — none of which a page on another origin can forge.
Every other `Origin` reaches the gateway as it was sent, so the gateway's own checks (the WebSocket
`Origin` check, and the fork's write-request check) can refuse it. Rewriting all of them would turn a
cross-site request — a form POST from a sibling subdomain, which is the same _site_ and so carries a
`SameSite=Lax` session cookie — into one from the gateway's own origin, which every such check
accepts. A non-web `Origin` (`null`, `tauri://`, `app://`, `capacitor://`, `file://`) passes through
for the gateway to classify, and no `Origin` is ever invented where the client sent none, on a plain
request or on a WebSocket upgrade.

`--pass-host` turns that rewrite off, for a gateway that knows Hermie Web's own origin (see
[the OIDC section](#oidc-where-the-sign-in-comes-back-to) below): `Host` becomes
`--web-public-url`'s host and the browser's `Origin` and `Referer` pass through untouched. The
`X-Forwarded-*` headers are set the same way either way.

Whether the browser arrived over https is read from the reverse proxy's `X-Forwarded-Proto` before
it is read from Hermie Web's own socket, which is plain HTTP by design. Reading the socket alone
would tell the gateway `http` on every TLS deployment, and it answers that by issuing cookies without
`Secure` and without the `__Host-` prefix — a downgrade produced by the proxy rather than by the
deployment. The header decides nothing beyond the cookie attributes of the request that carried it.

`Set-Cookie` passes back almost untouched. `Domain` is dropped, because a domain naming the gateway's
host would make the browser discard the cookie outright. `Secure` is dropped and `SameSite=None`
becomes `Lax` **only** when the browser reached Hermie Web over plain HTTP — a `Secure` cookie on an
`http://` origin is silently thrown away, which looks exactly like a sign-in that did nothing.
`Path` is never touched: the gateway computes it from its own prefix and rewriting it would unscope
the session.

The WebSocket upgrade is not terminated and re-offered. The raw sockets are piped, so the subprotocol
negotiation — which is how the ticket is carried — and the close codes are exactly what the two ends
agreed. Terminating it would have meant re-framing every message for no benefit.

## Signing in, in a browser

The native flow and the browser flow share the transcript and share nothing else. In a tab:

1. The app probes `window.location.origin`. There is no address to type — Hermie Web already fixed
   the gateway, and `GET /hermie/config.json` tells the app which host is behind it so the wizard can
   name it.
2. It asks `GET /api/auth/me`. A cookie survives the reload at the end of a redirect chain, so an
   already-signed-in visitor never sees a button.
3. Otherwise it goes to the gateway's own sign-in page. An OAuth provider is a **full-page
   navigation**: the app is torn down and rebuilt when it returns, which is precisely why the cookie
   is the state rather than anything the wizard was holding. A password provider is not —
   `POST /auth/password-login` sets the cookies on its own response, so that one stays inside the
   page.
4. Every WebSocket dial then mints its own credential: `POST /api/auth/ws-ticket` over HTTP, and the
   ticket goes out in the subprotocol list. Tickets are single-use and short-lived, so a reconnect
   mints a fresh one.

The app's credential provider is `CookieSessionCredentials`: no `Authorization` header on REST,
`credentials: 'include'` so the browser attaches the cookie, a ticket per dial. There is no refresh
token within reach, so a rejection is always "sign in again" rather than a silent renewal.

### Turning the gateway's OIDC/SSO providers off

`--no-oidc` (or `HERMIE_OIDC=0`) is a deployment choice, not a security boundary against the
gateway itself: a container that would rather this service offer only password sign-in. Two things
happen together, because either alone is half a switch:

- `/hermie/config.json` answers `oidc: false`, and the app leaves every provider that is not a
  password one out of the sign-in screen and the connect wizard — see `web-config.shared.ts` and
  `SignInStep.web.tsx`. A gateway whose only provider is an OIDC/SSO one is told so in plain
  language rather than shown an empty screen.
- The proxy itself refuses `GET /auth/login` and `GET /auth/callback` — the OIDC start and callback
  routes step 3 above describes — with a 403, so typing either URL by hand does not start one
  either, and `/auth/native/authorize` unless the provider the gateway would pick takes a password.
  It decides on the path decoded once, exactly as the gateway decodes it, and forwards the original
  bytes untouched; a path that would decode differently a second time, or a repeated `provider`, is
  a 400. `POST /auth/password-login`, `/api/auth/me`, the gateway's own `/login` form, logout and
  every WebSocket ticket keep working exactly as before.

This is unrelated to `hermie-web login` (further down this page): that is the CLI's own sign-in to
an OIDC-gated _upstream_ gateway, used once to obtain the refresh token `--push` spends, and it never
goes through a browser. It is also unrelated to the BUILT-IN identity provider a few sections down —
that is this service acting as an OpenID Provider _for_ the gateway; this flag is about the
gateway's _own_ upstream providers, reached through this proxy. `deploy/web/README.md`'s
[flags table](../deploy/web/README.md#flags-and-environment) has the exact variable.

### OIDC: where the sign-in comes back to

There is one deployment rule that OAuth makes non-negotiable: **the identity provider must send the
browser back to the host that holds the PKCE cookie.** That cookie is set when the chain starts, and
a cookie belongs to a **host** — it ignores the port but not the name. Get it wrong and the round
trip ends at the very last hop with `{"detail":"Missing PKCE state cookie"}`. Which hosts that allows
depends on the gateway.

**An upstream gateway (one `dashboard.public_url`): same host, another port.** The gateway builds the
`redirect_uri` out of `public_url` and nothing else, so the IdP always returns the browser to
`https://<public_url>/auth/callback`:

| Where Hermie Web answers                   | What happens at the callback                              |
| ------------------------------------------ | --------------------------------------------------------- |
| Same host and port as `public_url`         | Works. One origin, one cookie jar.                        |
| Same host, **another port** — e.g. `:9443` | Works. The cookie was set for the host, port and all.     |
| **Another host** — `app.example.com`       | Fails. The cookie is on a host the callback never visits. |

This is what [ADR-0015](adr/0015-web-variant-on-its-own-port.md) chose "own port" for. It leaves the
landing: `next=` comes back from `/auth/callback` as a **relative** redirect, resolved against the
gateway's port, so a sign-in would end on the dashboard. The fix is a redirect the operator owns — a
path on the gateway's port that points back at Hermie Web — named with `--login-return`. It goes into
`/hermie/config.json` as `loginReturn`, the app sends it as `next=`, and both ends validate it as a
same-origin path. `deploy/web/README.md` has the worked nginx configuration.

**The fullstackstudio-org fork (`dashboard.public_urls`): Hermie Web on its own domain.** The fork
lists several origins and builds the `redirect_uri` on the listed origin the sign-in **started on**,
so a sign-in started on `https://app.example.com` comes back to `https://app.example.com/auth/callback`
— Hermie Web — with the PKCE cookie still there, and `next=` is not needed at all. Three things have
to be true, and all three are the operator's:

1. **The origin is listed** in `dashboard.public_urls` (`HERMES_DASHBOARD_PUBLIC_URLS`), with its exact
   scheme and port.
2. **Hermie Web is a trusted peer of the gateway**: loopback (a sidecar, or the same machine), or in
   `dashboard.trusted_proxies`. The gateway reads which origin a request is on from
   `X-Forwarded-Host` and `X-Forwarded-Proto` only from such a peer; from anybody else it sees the
   plain-http socket, an `https` origin never matches, and the sign-in falls back to the primary
   callback — the gateway logs a warning saying so.
3. **The IdP has every callback registered**: `<each listed URL>/auth/callback`.

Then start Hermie Web with `--pass-host --web-public-url https://app.example.com` (`HERMIE_PASS_HOST=1`,
`HERMIE_WEB_PUBLIC_URL`). `--public-url` stays the gateway's own address; `--web-public-url` is Hermie
Web's. With `--pass-host`:

- `Host` is Hermie Web's own public host and the browser's `Origin` and `Referer` pass through, so the
  gateway's Host guard, its WebSocket `Origin` check and its write-request `Origin` check
  (`dashboard.write_origin_check`) all judge the origin the browser is really on. Rewriting would
  launder ANY `Origin` — a cross-site one included — into the gateway's own, which every one of those
  checks accepts.
- `--login-return` defaults to none: `/hermie/config.json` answers `loginReturn: ""`, and the app then
  sends no `next=`, so the callback's own default (`/`) lands on Hermie Web. Set it only if you want
  somewhere else.
- `/hermie/config.json` also answers `passHost` (whether the gateway is being sent this origin) and
  `origin` (`--web-public-url`, or `null` — never a value taken from the request).
- **At startup** Hermie Web asks the gateway `GET /api/status` with exactly those headers. A 400 is
  the gateway's Host guard refusing the origin: Hermie Web then falls back to rewriting, as without
  the flag, and logs `add <origin> to dashboard.public_urls on the gateway`. It cannot see two things
  and says so instead: a gateway bound to `0.0.0.0` accepts every `Host`, so a missing entry there
  shows up only as the gateway's own warning at the first sign-in; and whether the gateway trusts it
  as a proxy — it logs a reminder whenever the gateway is not on loopback. The check runs when Hermie
  Web starts (and after `/setup`), not again: after changing the gateway's `public_urls`, restart
  Hermie Web too.

Strictly, the `redirect_uri` follows `X-Forwarded-Host` from a trusted peer even without
`--pass-host`, since Hermie Web always forwards the browser's `Host` there. What the flag adds is
honest `Host` and `Origin` headers, a startup check, and no `next=` workaround; run the fork's
two-domain setup with it. `--no-oidc` is unaffected by any of this — its checks run on the path,
before any header is written.

### What the wizard does differently

It has no address step. Welcome → Sign in → Test → Done, where the native wizard has five steps and
the second is where you type the gateway. It shows the gateway host instead of asking for it, and
the **Advanced** extra-headers field is absent too — see the limitations below.

The connection test is the same test: one authenticated REST call, then a real WebSocket dial
through to `gateway.ready`, before anything is saved.

## Self-update

A Hermie Web install can be told a newer version exists, and — where the install shape allows it —
replace itself. Settings → **Hermie Web** is the surface: the running version, whether a newer one
exists, and an **Update** button when this install can apply it.

**Where it checks.** `GET /hermie/update` compares the running version with the newest GitHub
release of this repository. The listing is fetched once at startup, then at most once every six
hours, and on an explicit refresh — GitHub rate-limits unauthenticated API calls per IP, and a
settings screen that polled would spend that budget for nothing. A failed fetch keeps the previous
answer rather than replacing it with "no releases": the network being down is not news about the
release. A release that publishes no `hermie-web.zip` is treated as no release at all, because it is
a release of the apps only.

The same answer says whether this install can update itself, and when it cannot it carries the
command that does work instead of a button that would fail. There are three noes: `--no-self-update`,
a container (the image is the version — `docker pull`), and a copy under `node_modules`
(`npm i -g @hermie/web@latest`).

**What it downloads and what it verifies.** `POST /hermie/update` fetches `hermie-web.zip` and the
release's `SHA256SUMS`, both over https and nothing else. A zip the checksum file does not list is
refused, and so is one whose digest does not match. That is worth stating precisely: **nothing here
verifies a signature.** The digest proves the bytes match what the release lists, and https proves
they came from GitHub. Anyone who can publish a release can publish a matching digest. It is the same
trust boundary as `npm i -g`, written down rather than dressed up.

The endpoint is gated on the caller's own gateway session: the request's cookies are put to the
gateway's `/api/auth/me`, and anything but a 200 is a 401 here. Hermie Web has no user database and
is not going to grow one. The refusal for an install that cannot update itself comes first, so a
Docker deployment never sends a request it has no use for.

**How it installs.** The zip is unpacked into `<install-root>/releases/<version>.incoming` and only
then renamed into place, so a half-unpacked directory can never become a release. `current` is
pointed at it by writing a new symlink and `rename`-ing it over the old one — atomic, where unlink
followed by symlink has a window in which `current` does not exist and a restart landing in it has
nothing to run. `--rollback` walks the release directories on disk, in version order, and points
`current` at the one before the active version; the previous release directory is kept, which is what
makes that possible.

**How it restarts, and why the systemd `Restart=` line matters.** The HTTP response is answered
first — the browser has to receive `{restarting: true}` before the socket dies, or the settings row
has nothing to poll about — and then the process **exits 0**. That is the whole restart. Under a
supervisor, exiting is the correct way to do it: re-executing inside the old process would leave the
unit's idea of its main PID pointing at something that no longer exists. Which means the supervisor
has to be there. `Restart=always` in the unit file is not hardening; it is the line that turns
"update" into a restart instead of an outage, because without it the update stops the service and
nothing starts it again. Hermie Web detects a supervisor from the environment it announces itself
with (`INVOCATION_ID`, `NOTIFY_SOCKET`, and friends); with none, it spawns a detached child first,
which is strictly worse — no logs, no restart on crash — and is documented as the fallback it is.

Meanwhile the page polls `/healthz` every second and a half until a version comes back, reloads only
when that version is the **new** one (an old server that never restarted would answer just as
happily), and gives up after a minute rather than spinning for ever.

## Push notifications

Hermie Web has a second job it does not do unless it is asked:
`hermie-web --push` watches every Bot Chat on its gateway and notifies devices that registered
themselves for it. [ADR-0017](adr/0017-push-through-hermie-web.md) is the design and the threat
model; what follows is what a self-hoster has to know.

**Why it lives here.** An app that is not running has no socket — iOS suspends it within seconds of
backgrounding and Android's Doze does the equivalent — so something that is always running has to
watch. `hermes serve` has no push machinery and no notion of a device, and a hosted service of ours
would put every device token and every bot's name on somebody else's server. Hermie Web is already
next to the gateway, already a released artefact, and already the thing a self-hoster installs.

**There is no inbound endpoint.** A device registers by writing into the gateway's `ui_meta` through
the connection it already has, under the `hermie-app` key on the default profile. The app never
talks to the daemon and nothing on the network can make a phone buzz: the only way into the path is
an authenticated write to the gateway.

### What it notifies about

Four things, and nothing else:

| Event                          | Suppressed while somebody is reading?                             |
| ------------------------------ | ----------------------------------------------------------------- |
| A new bot message              | **Yes** — see the heartbeat below.                                |
| An approval or clarify request | No. A question with a countdown on it is worth a buzz regardless. |
| A bot-to-bot DM                | No.                                                               |
| A cron delivery or cron error  | No.                                                               |

### How it learns that a question is open

By default the daemon does **not** ask the gateway to route approval and clarify requests to it. That
sounds like a detail and it is the one decision here that could cost somebody an answer.

Asking — `client.capabilities {server_requests: true}` — is what makes a backend send them to this
connection, and the daemon will never answer one: an approval belongs to the owner. Whether holding
it open is harmless depends on something upstream has not promised. If a session's transport fans a
request out to **every** peer, the app gets it too and answers it, and nothing is lost. If a backend
routes to **one** peer, the daemon receiving the question has taken it away from the person it was
for.

So the safe behaviour is the default, and it is not a downgrade: open questions are read from the
snapshot a `session.resume` answers with (`open_requests`, and `pending_approval` for a question that
opened before the daemon connected) and from an `approval.pending` poll — the same RPC and the same
30-second cadence the app itself uses, and only while at least one device is registered. One question
that arrives by two or three of those routes still buzzes once, because the queue's own request id is
what identifies it.

`--push-server-requests` (or `HERMIE_PUSH_SERVER_REQUESTS=1`) turns the live route on. Use it only if
you know your gateway fans server requests out to every peer of a session.

"Somebody is reading" cannot be asked of the gateway: `session.active_list` answers about the calling
connection and nobody else's. So the app writes a stamp into `push.seen` while a chat is on screen
and the daemon reads it, after a few seconds' pause so an app that is opening can claim the chat
first. It is a heuristic, and it fails towards a redundant notification for a chat somebody is
already reading — which is the right direction.

### What a push contains

**A bot name and an event type.** No message text, no snippet, no request text. A notification is
delivered by Apple, Google or a browser vendor and drawn on a lock screen, so the default is the
least it can say and still be worth tapping. A device whose owner turns **preview** on for that
device gets one short line of the text as well; that is a per-device decision made in the app.

An approval notification carries Allow and Deny actions, and tapping one answers nothing by itself:
the app opens, connects to the gateway, re-reads the open requests, and responds only if that request
is still open and still says what the notification said it did. A notification is a hint that
something happened, never an instruction.

### Credentials

The daemon needs to read every Bot Chat, so it needs a gateway credential.

- **Ungated gateway** — give it the session token, with `--gateway-token` or `HERMIE_GATEWAY_TOKEN`.
- **OIDC-gated gateway** — run `hermie-web login` once. It prints an authorisation URL (it does not
  open one; this may be a machine with no desktop), listens on a loopback redirect port for exactly
  one callback, exchanges the code, and stores the **refresh** token in the state directory at
  `0600`. The daemon spends it for an access token and a single-use WebSocket ticket on every dial,
  the same way the app does.

  If the gateway's identity provider issues no refresh token, **push is not available** and the
  command says so rather than storing an hour-long credential. The fix is the `offline_access` scope
  on the provider's client registration — the same thing the app's sign-in warns about.

This is a real trust boundary, and ADR-0017 states it plainly: the daemon's credential is a gateway
credential, so anyone who can read its state file can read every transcript on that gateway. That is
the same trust level as the gateway's own host, which is where the daemon is meant to run.

### The state directory

`--state-dir`, or `HERMIE_STATE_DIR`; by default `$XDG_STATE_HOME/hermie-web`, else
`~/.local/state/hermie-web`. The file inside it is written `0600` in a `0700` directory and holds how
far each chat has been read, which notifications have already gone out, which device addresses are
finished, the VAPID key pair, and any stored sign-in.

It is deliberately **not** the install root. A self-update replaces that directory, and a daemon that
forgot its VAPID key after an update would silently orphan every browser subscription it had ever
handed out.

### VAPID, and the browser build

Web Push needs an application-server key pair (RFC 8292). The daemon generates one on its first run,
keeps it in the state directory, and serves the public half at `GET /push/vapid-public-key` — which
is where the browser build reads it, because the app has no other route to the daemon. The key is
public by definition and authorises nothing.

Two conditions a browser imposes and nothing here can lift: a service worker and a `PushSubscription`
need **https** and a registered scope, so Web Push only works where Hermie Web is served over TLS,
and the key pair must stay the same for as long as the subscriptions do. Over plain http the browser
build simply does not offer it.

The payload itself is encrypted end to end to the key pair the browser generated (RFC 8291); the push
service forwards ciphertext it cannot read.

### The push relay, for the native Apple apps

Only an app's publisher can talk to Apple's push service, so the native iPhone, iPad and Mac apps
register with a relay the project operates, `https://push.hermie.dev`, and write a registration with
`transport: "relay"` into the same `ui_meta` section: the relay's address, a public `handle` for the
device, and a `secret` that authorises sending to that one device. The daemon delivers to such a
registration by posting to the relay's `POST /v1/send`, at most twenty messages and 7.5 KB per
request, each with its own handle and secret; the relay turns each into an APNs notification. Two
registrations naming the same relay, handle and secret are one device and get one message, and one
handle never appears twice in a request. Expo and Web Push registrations are delivered as before.

**The allow-list decides where a request goes, not the registration.** A registration names its relay,
but anybody who can write the gateway's `ui_meta` can write one, so the daemon posts only to an origin
on its own list and skips (without removing) a registration that names any other.

| Setting                                              | Default                   | Meaning                                                                                                                                              |
| ---------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--push-relays <origins>` (env `HERMIE_PUSH_RELAYS`) | `https://push.hermie.dev` | Comma-separated https origins, no path. The whole list, not an addition to the default. Empty turns relay delivery off. A bad entry stops the start. |

Requests are https only, never follow a redirect, time out after ten seconds, and read at most 64 KB
of an answer. A device the relay answers `gone` for is retired as an Expo token that Expo calls
`DeviceNotRegistered` is: until the device writes its row again (a newer `updatedAt`), and the same
relay, handle and secret are never sent to again. A `rejected` message is logged and dropped; `retry`,
`limited` and a network failure get one more try after the relay's `retryAfter` (up to ten seconds; a
longer wait drops the notification instead). A request the relay refuses whole (400 or 413) is sent
again one message at a time, once, so one bad registration costs only itself; if every one is refused
on its own too, the relay is left alone for a minute.

Sending never waits on a struggling relay. After a whole request failed (no answer, 429 or 5xx), or
the relay rate-limited this server's address, the relay is left alone for the time it asked for, and a
device it rate-limited is skipped the same way — but never longer than an hour for a relay and a day
for a device, whatever it asked. The relay counts `gone` answers against the sender, so one person
whose rows keep coming back `gone` (three in an hour) has their rows that were never delivered to held
for that hour, and nobody else's. Problems are logged as one counted line per send; log lines never
print a secret or a whole handle.

**No message text goes through the relay.** A relay registration gets the bot's name and the event
type, whatever its preview setting says: the relay could read anything sent through it in plain text,
so previews wait until the app and the daemon can encrypt them end to end.

The daemon says it can deliver to relay registrations by listing `push.relay` in the `capabilities` of
the availability stamp it leaves in `hermie-app.push` (next to `push.expo` and `push.webpush`), and
only while `https://push.hermie.dev` is on the allow-list; the stamp's `relayOrigins` lists the whole
allow-list, as the plugin's advert does. A native app that does not see the capability keeps its Expo
registration, so a gateway whose notifier predates the relay goes on notifying it through Expo.

### When the gateway has the `hermie` plugin

The gateway plugin is the notifier and this daemon the fallback
([ADR-0017's amendment](adr/0017-push-through-hermie-web.md)), and the two must not deliver one
notification to one device twice. So the daemon leaves to the plugin what the plugin's advert
(`hermie-plugin` in the default profile's `ui_meta`, with its push module `on`) says it delivers, and
nothing else:

| Registration | Left to the plugin when                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| Web Push     | never: a browser subscribed with this daemon's VAPID key, which only this daemon has |
| Expo         | the advert lists `push.expo`                                                         |
| relay        | the advert lists `push.relay` and the row's relay is in the advert's `relayOrigins`  |

A bot-to-bot DM is never left to the plugin, on any transport: the plugin has no hook that produces
one. The availability stamp keeps `push.webpush` and drops what is left to the plugin, so a native app
goes by what the plugin says about those.

**A stale advert.** The plugin writes its advert when it loads and withdraws it only when it is
unloaded cleanly, so a gateway that was killed and then had the plugin removed keeps an advert that
says `push: "on"`, and the daemon goes on leaving Expo and relay notifications to a plugin that is not
there. While it does, the daemon logs once an hour which transports it leaves to the plugin and when
the advert was last written. `--push-ignore-plugin` (env `HERMIE_PUSH_IGNORE_PLUGIN=1`) makes it
deliver everything regardless. An advert that carries a `heartbeat` (seconds) is believed only while
it was rewritten within three heartbeats; an advert without one is believed as it stands. An advert
from a newer contract version than this build reads counts as no advert, as the app reads it.

### The cost, said out loud

A watcher that resumes every Bot Chat keeps every Bot Chat resident on the gateway, because upstream
never evicts a session whose transport is alive. On a gateway with `max_live_sessions` set, the
daemon's resumed chats count against that cap. There is also one small read per finished turn and one
`approval.pending` per watched chat every 30 seconds, and both stop entirely when nobody is
registered.

Classifying a finished turn reads **five rows** off the gateway's REST transcript
(`GET /api/sessions/{id}/messages?limit=5&order=latest`, the same route the app's own tail reconcile
uses), and falls back to the unpaginated `session.history` only on a gateway that has no REST
surface. That fallback is the expensive one — it returns the whole chat to look at its last row — so
on a long transcript it is worth knowing which of the two your gateway is giving you.

And the plainest consequence of all: **a daemon that is not running sends nothing**, and nothing on
the device will say so beyond the liveness stamp Settings reads. Notifications are best effort and
the app never treats their absence as information.

## Installing it

The configurations are in [deploy/web/README.md](../deploy/web/README.md); in brief:

| Route             | What it is                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx @hermie/web` | One command next to `hermes serve`. Nothing to install, nothing to update — and no supervisor.                                                                                                               |
| A release zip     | `hermie-web.zip` from a GitHub release, unpacked under `/opt/hermie-web/releases/<version>/` with a `current` symlink. This is the layout self-update expects.                                               |
| Docker            | `ghcr.io/fullstackstudio-org/hermie-web`. The image is the version, so self-update refuses and points at `docker pull`.                                                                                      |
| Kubernetes        | The same image, entirely configured from `env` — see [deploy/k8s/README.md](../deploy/k8s/README.md) for a sidecar-in-one-Pod shape and a two-Deployment shape.                                              |
| systemd           | A unit pointing `ExecStart` at `current`, with `Restart=always` and the install root in `ReadWritePaths`.                                                                                                    |
| TLS in front      | Caddy, nginx or `tailscale serve`. All three pass `X-Forwarded-Proto`, which is what makes the gateway issue `Secure` cookies; nginx needs the two upgrade headers spelled out or the socket never connects. |

The gateway needs `dashboard.public_url` set to the address Hermie Web claims to be, and
`dashboard.trusted_proxies` naming Hermie Web's machine if the two are not the same host.

**Every flag has an environment variable.** `--gateway`, `--port`, `--host` and the rest each read an
environment variable of the same shape (`HERMIE_GATEWAY_URL`, `HERMIE_PORT`, `HERMIE_HOST`, …) when
the flag is absent, and `--help` names each one next to its flag. This is what lets a container be
configured entirely through `docker run -e ...` or a Kubernetes `env`/`envFrom`, with the image's
`ENTRYPOINT` left as `["hermie-web"]` and no `args` at all. The full table is
[deploy/web/README.md#flags-and-environment](../deploy/web/README.md#flags-and-environment).

## Forms, files and drafts the agent asks for

Beside the approval and the clarify question, an agent can ask the person for three more things: **a form**
(`input.form`: one to twelve typed fields), **a file** (`input.file`: one or more files, uploaded) and **a draft to
review** (`review.draft`: a mail, a post or a message, to approve, change or reject). The wire is
[contract/requests](../contract/requests/README.md), which is normative; this section is how the page behaves. The
agent's side lives in the gateway: the tools `ask_form`, `ask_file` and `review_draft` are in the toolset
`interactive`, which is off by default (switch it on with `hermes tools`, for the platform `cli`).

### What the page advertises, and when

A gateway sends one of these requests only to a connection that said it can show it. So the page lists the methods in
the **second** `client.capabilities` call, and only after the first call's answer named them under `server_requests`
(a gateway that does not know them would refuse the unknown key and the whole call with it). It lists a method only
if this browser can do what it takes: `input.file` needs `File` and `FormData`, which every current browser has. A
request the gateway parked for a device that can show it is delivered as soon as the advert is accepted.

The page advertises what it can really show, because a gateway that knows a page can show a form sends it there
instead of telling the agent that no client is available. A single request the page cannot show (a version or a form
field kind it does not know, a frame that is not the contract's, too many waiting) is answered `4041 cannot_show` with
a reason, never with a made-up skip, and leaves one short notice on its chat.

### The three sheets

Each is a modal sheet over the page, in a frame that is the page's own: the heading, the gateway's host, who receives
the answer and the buttons are fixed words, and everything the agent wrote (its title, its summary, its detail) is
plain text in a quoted box under a label that says it is the agent's. It is never Markdown and never a link, and it
cannot style the frame around it.

- **The form** draws the agent's fields with the browser's own inputs: text, number, amount, date, time, datetime,
  date range, choice and toggle. The page checks a field the way the gateway does and says what is wrong next to the
  field, in the gateway's own terms, before anything is sent; a refusal from the gateway comes back next to the field
  it names and leaves everything typed in place. An amount goes out as a decimal string with at most the currency's
  minor unit, and a datetime with its offset and its zone.
- **The file sheet** offers the browser's picker, filtered by what the agent accepts, and a camera button where the
  device probably has one. It enforces the request's `max_files`, `max_bytes` and `max_total_bytes` as files are
  added and again on the prepared files, before the first byte moves. A picture gets a preview.
- **The draft sheet** shows the text verbatim: monospaced, never wrapped, never rendered. Every character the gateway
  refuses (zero-width characters, direction overrides, a tab) is shown by its code point, and the page names the rule
  and the line instead of rewriting anything, so **Approve** waits until the person has taken it out. When the draft
  is editable it can be changed before approving (**Approve with changes**), with the original kept on screen for
  comparison. **Reject** takes an optional comment for the agent. A draft has no Skip.

**Skip** is offered only when the request is `optional`. A countdown runs to the gateway's deadline; at that time the
sheet goes, nothing is sent, and the chat says so.

### Later, Open and Don't share

**Later** (or Escape) puts a sheet away without answering: the request stays open at the gateway, the page is usable,
and what was typed or picked stays in the sheet. The transcript's record of the request offers **Open** to bring it
back. Later is not an answer. It is also the one place Escape closes a question sheet: an approval or a clarify
question has no dismiss.

**Don't share**, on a form or a file request, tells the agent the person chose not to provide it (`4041` with reason
`declined`). The gateway passes that on as the person's choice, which is neither a skip nor a failure, and the agent is
told not to ask again at once. On a draft the refusal is Reject.

### Taps, order and several at once

For 400 ms after a sheet is shown its controls are off, so a click or a keystroke meant for what was under it never
answers. The guard starts when the sheet is **shown**, not when it is built: a sheet queued behind another, or opened
again after Later, starts over.

One sheet is on screen at a time, from one queue, oldest first, in the order the page first saw each request. Requests
that arrive in the same moment (a resume that restores several) are ordered approvals and clarify questions first,
then confirmations, secure prompts and these. The page does not take the screen away from a sheet that is open: a
request that arrives meanwhile waits behind it, and a sheet put away with Later no longer holds the queue.

### Uploads

A file is uploaded to the request's `upload.dir` **before** the answer is sent, one after another, through the page's
own upload route and with the credentials it already uses for attachments. It goes **flat** into that directory as
`<16 hex>-<safe name>`: the gateway refuses a subdirectory. The answer carries the path, the name, the type, the size
and the SHA-256 of the bytes **as uploaded**, never the bytes themselves; the page hashes the prepared file, so the
figures are those of the file on the gateway. Each upload shows its progress and can be cancelled, and a file that is
already up is not sent again when the person tries once more. A failed upload is said in the sheet: **Try again**, or
**Give up**, which tells the agent `4041 upload_failed`, not an answer.

With `strip_metadata`, a JPEG or PNG is decoded and drawn again on a canvas, which writes none of its EXIF or location
data (the camera's rotation is applied to the pixels first). Any other picture the browser can read becomes a JPEG, and
one the browser cannot read is refused rather than sent with its metadata. Documents and audio go up untouched.

The page cannot take an upload back. One that is never answered stays on the gateway: the person cancelled mid-way,
gave up after a later file failed, put the sheet away and the request ran out, or the gateway withdrew the request.
Nothing deletes those files; they sit flat in the directory under their `<16 hex>-<name>` names, so they can be cleared
by age like any other upload. What is left behind carries no location data when `strip_metadata` was asked.

### What is never stored

What a person types, the files they pick and the text they edit a draft into live in the sheet's own state for as long
as the sheet exists and go into the one `request.answer` call. They never reach the transcript, the chat store, the
cache, a draft, a log or a diagnostics export. The transcript is told only that a question was asked and how it ended:
the heading, the agent's words and a summary such as `answered` with a count of files, or `approved` with whether the
text was edited, never a value. Nothing is kept across a reload either: which sheets were put away is in memory only,
and a request that is still open is delivered again.

### Reconnects

The page answers through `request.answer`, so the gateway's refusal comes back to the sheet. A request stays open
across a dropped socket and a reconnect. A gateway lists these requests only to a connection that advertised them, and
a reconnect's resume runs before the new socket's advert, so the page reads the gateway's list again once the advert
was accepted.

- A request that ended while the page was not listening (withdrawn, timed out, answered on another device) closes with
  a notice that says so, and nothing is sent.
- A re-delivered copy of a request the page already answered or let go is the proof that the answer never arrived: it
  opens again and says so. A copy of one the gateway withdrew, that expired, or that the page declined never opens.
- **An answer on its way is not overruled.** The gateway also sends `request.cancel` with reason `resolved` to the
  device that answered, and it can arrive before the reply to the answer. While an answer is in flight, a cancel and
  the local deadline wait for the call's result, which decides. A call that failed without the gateway's word leaves
  the request open for another try, and a later "no longer waiting" says the answer may not have arrived rather than
  that it expired.
- A request for a session no chat holds yet waits, at most sixteen at once, until a chat holds it or its deadline
  passes. The page does not decline for waiting: a chat the reader is about to open may still answer it.
- The deadline is the request's own `expires_at`, on the page's clock. A request that arrives already past it is not
  shown, and none is answered after it.

## What it cannot do

Three things, none of which a browser is going to grow:

- **No keychain.** The session is the gateway's cookie, which the page cannot read; anything the
  shared code does route through the web secret store is protected by the origin and nothing else.
  Clearing site data signs you out.
- **No extra request headers on a WebSocket.** A gateway behind Cloudflare Access is reached on
  native by configuring those headers in the app. A page cannot send them, and cannot be made to — so
  that perimeter belongs **in front of Hermie Web**, not inside it. Put the access proxy on the
  Hermie Web port and let the gateway trust the machine behind it.
- **No loopback redirect**, which is why the native PKCE flow is not used by the page at all. The
  `hermie-web login` subcommand above does use it — but that is a Node process opening a port on the
  machine it runs on, which is precisely the thing a browser tab cannot do.

Two behaviours change shape rather than disappear: picking a file becomes an `<input type="file">`
whose cancel is a focus heuristic rather than an event, and haptics become a no-op. The web section
of [docs/platform-notes.md](platform-notes.md) is the full list of what has and has not been verified
in a browser.

## When something is wrong

The symptom table in [deploy/web/README.md](../deploy/web/README.md#troubleshooting) is the place to
start — a 403 on `/api/status`, REST working while the socket never connects, a sign-in that
un-signs-in on reload, and every client showing up in the gateway's log as Hermie Web's own address
each have one usual cause, and all four of them are configuration rather than code.
