# 0025. Hermie Web is a service layer, not only a proxy

- Status: Accepted
- Date: 2026-09-22

## Context

[ADR-0015](0015-web-variant-on-its-own-port.md) made Hermie Web one process that does two things:
it serves the exported browser build, and it proxies one fixed gateway onto its own origin. Both
jobs are stateless by design. The process authenticates nobody, remembers nothing about anybody,
and every byte a page needs comes either from the static build or from the gateway behind it.

[ADR-0017](0017-push-through-hermie-web.md) then gave the same process something stateless cannot
have: a **service login**. `hermie-web login` stores one OIDC refresh token in the state directory,
`--push` spends it on a gateway connection of its own, and that connection resumes every canonical
Bot Chat so a phone with no socket can still be told something happened. The process stopped being
a pipe the moment it held a credential.

That is the fact this record is about. There is now a long-lived, authenticated link to the gateway
sitting inside Hermie Web, held open for push and used for nothing else, while the browser in front
of it re-learns the same transcript from scratch on every visit.

### What the browser build actually costs a reader today

- **It asks them to set up a gateway they cannot choose.** The wizard already has no address step
  on the web (ADR-0015), but everything after it is still the native flow: a welcome cover, a probe
  of an address the reader did not type, a sign-in, a connection test, a notifications offer and a
  "Done" that writes a configuration record. The only one of those a reader of a browser page has
  any business seeing is the sign-in. The rest is an operator's work, being done by whoever happens
  to open the tab first — and then again by the next person, on the next device.
- **Every chat opens cold.** The app's own cache is IndexedDB on the web, which is per browser and
  per device. A first visit, a new laptop, a private window or a cleared site-data drawer all mean
  the same thing: a spinner, then a full `session.history`, then a thread that appears at once and
  moves. The owner's standing requirement is that the view must not move on open, and the only
  reason it is met today is that somebody has already opened that chat in that browser before.
- **Nothing in the page says who is signed in.** The gateway knows — `/api/auth/me` answers it —
  and the app asks, once, to decide what a bot may be told about the person holding the device.
  A reader who wants to know which account this tab is has to open Settings.

### What was considered

1. **Leave it as a proxy and fix the wizard's copy.** Cheapest, and it does not touch the two real
   costs: a cold cache is still cold, and a second reader still walks an operator's flow.
2. **Move the state into the gateway.** Upstream would have to grow a per-user client cache and a
   notion of "this client's settings". [ADR-0006](0006-single-gateway-no-relay.md)'s spirit is that
   Hermie does not ask upstream for anything it can do itself, and the no-upstream-change rule makes
   this not an option at all.
3. **Make Hermie Web a service: configured once by an operator, used by readers who only sign in.**
   Chosen. The credential it already holds is the thing that makes it possible, and the state
   directory it already owns is the place it goes.

## Decision

**Hermie Web is a service layer.** An operator sets the gateway up **once**; everybody else only
ever sees a sign-in.

That splits into four commitments, of which this record's part 1 delivers the first three.

### 1. The operator sets up the gateway, the reader does not

A Hermie Web that was started with no gateway of its own — no `--gateway`, no `HERMIE_GATEWAY_URL`,
no saved setup — serves an **operator setup page at `/setup`**: the gateway address, a probe of it,
and the service login. The service login is the `hermie-web login` flow run from the browser instead
of a terminal, and the page says plainly what that login is for — push, and the message cache —
rather than letting it look like the operator's own sign-in to the app.

Once the setup is saved, `/setup` answers **404**, for this process and for every later one: the
saved record makes the next start a configured start.

For the app, `GET /hermie/config.json` grows into the bootstrap the browser build reads before it
renders anything: the gateway origin, which **auth kinds** the gateway offers, the **service
status** (is a service login stored, is push running, is the cache on) and the version. With that
in hand the browser build skips the address step, skips the probe, and opens **on the sign-in
step**. "Change gateway" stays hidden on the web, because on the web it is not the reader's to
change.

**The gateway is still fixed at process start.** There is exactly one transition — unconfigured to
configured, at most once in a process's life, through `/setup` — and no path back. Everything
`options.ts` says about an open proxy still holds: a browser cannot steer a configured Hermie Web,
and an unconfigured one binds to loopback like every other one.

### 2. A message cache, so a chat paints instantly

The service keeps a **per-session transcript cache on disk**, in its own state directory, fed from
the two places it already sees traffic: the service link's subscription (which is already resuming
every Bot Chat for push) and proxied `GET /api/sessions/<id>/messages` responses. The browser
build's transcript-cache seam reads `GET /hermie/cache/<id>` **before the socket answers**, so a
chat opened on a device that has never seen it paints from the server's copy and then reconciles —
with the ids it already handed out, which is what keeps the view still.

What the cache stores is the gateway's **rows**, untransformed. Hermie Web ships as a self-contained
`dist/server` with no `node_modules` beside it, so it cannot import `@hermie/transcript` to build
items; and it should not, because the item format is the app's and a server that understood it
would have to be released in step with it. The seam does the conversion, which it already has the
code for.

**Cache entries are per gateway, not per user, and that is written down rather than hidden.** The
gateway's `session.list` and `profiles.list` offer no field that says which person owns a session,
so there is nothing to key on. It costs less than it looks: by
[ADR-0007](0007-canonical-bot-chats-only.md) the canonical Bot Chat is one per bot and shared by
everyone who can reach that bot, so a cache of it is already not private to one reader. It is still
a real boundary — anyone who can reach this Hermie Web could otherwise read the cached tail of a Bot
Chat without being signed in to the gateway, which is why the read route requires the caller's own
gateway session, the same check `POST /hermie/update` already makes.

Eviction is a size cap with least-recently-used order, `--cache-max-mb`, default 64.

### 3. The signed-in person is on screen

The chat list's footer names who the gateway says this is — display name, else email, else the
subject — with an initial-drawn avatar and a **Sign out** entry. On the web the footer is also where
"Hermie Web x.y.z · gateway origin" belongs, so the two are **one block**, not two.

`/api/auth/me` carries no avatar field, so there is no picture to fetch and none is invented.

### 4. Later parts, off by default

Per-user chats and per-user `ui_meta` on the web side, an admin area, and a built-in OIDC provider
are later parts of this record's direction. None of them ships here, and each will be **off by
default** when it does.

## Consequences

**A second reader costs nothing.** They open the page, they sign in, their chats are already
painted. That is the whole point, and it is the first time the browser build has been better than
the native one at anything.

**Hermie Web now stores transcript content.** It stored credentials from ADR-0017 onwards, which is
the higher bar, but this is the first time it holds the conversations themselves. The state
directory was already `0700` with `0600` files and already documented as "anyone who can read this
has read access to every transcript on that gateway"; that sentence is now literally true of the
directory as well as of the credential in it. `--cache-max-mb 0` turns it off.

**The cache is a gateway-wide cache, and one Hermie Web is one gateway's.** A deployment where two
people must not see each other's Bot Chats was already not served by ADR-0007's shared canonical
chat; it is not served by this either, and the honest answer remains two gateways.

**`/setup` is a window, and it is open on a fresh install.** While it is open, anyone who can reach
the port can point the proxy at a URL — including something else on the operator's loopback
interface. It is the same power `--gateway` gives, handed to whoever reaches the port first, which
is why it exists only while nothing is configured, why the default bind is still `127.0.0.1`, and
why an operator who exposes the port before configuring it is doing something the deployment notes
tell them not to. A deployment that wants no window at all passes `--gateway` and never sees the
page.

**The bootstrap answer is now load-bearing.** `/hermie/config.json` decided a label before; it now
decides which onboarding steps exist. It stays best-effort in the app — a server that does not
answer falls back to probing, the way the build did before — because a bootstrap that can strand
the app is worse than a wizard step nobody needed.

**One more thing to keep in step with upstream.** The server-side probe reads `/api/status` and
`/api/auth/providers`, and the browser-side setup login reads `/auth/native/authorize` and
`/auth/native/token`. Those are the gateway's routes and `packages/gateway-client` is their
specification; where the two disagree, that package is right and this one is the bug — the same
rule `link.ts` and `credentials.ts` already carry, for the same packaging reason.

## Amendment (2026-09-22): part 2 — per-user chats, per-user isolation, and an admin area

This record's part 4 said the rest would come "off by default". Here it is, and the default rule
held: a deployment that opens nothing new behaves exactly as it did.

### What part 2 delivers

**Per-user chats** are [ADR-0007](0007-canonical-bot-chats-only.md)'s amendment, not this record's,
and the reasoning lives there. What belongs here is the consequence for the service, below.

**The message cache is no longer gateway-wide.** This record wrote that entries are "per gateway,
not per user, and that is written down rather than hidden", on the grounds that the only
conversation a bot had was one ADR-0007 had already made shared. The moment a private conversation
existed that reasoning expired. Entries carry an owner now; the full rule and its cost are in
[ADR-0016](0016-ui-meta-sync.md)'s amendment, which is where the two-reader verification lives.

**An admin area at `/admin`**, which is the part that needs a decision of its own.

### The admin area

**It is gated on a gateway user id, not on a credential of its own.** Hermie Web still has no user
database, and this does not give it one: `admins` is a list of ids the gateway authenticates, and
the gate is `/api/auth/me` asked with `{ fresh: true }` so that a removal or a sign-out takes effect
at once rather than after a memo expires. **The first administrator is whoever completed `/setup`**,
because that is the one moment this process can point at somebody without being told.

**A gateway with no accounts gets a local secret instead.** Offered on `/setup`, stored as a scrypt
hash, unlocking this page and nothing else. It is not a gateway session: it cannot read a chat, and
it never appears in a page. Without one, a deployment on a token or ungated gateway has nobody who
can open `/admin` — and the setup page says so while the operator is still standing there.

**The page is server-rendered HTML with no script at all.** Further than `/setup` goes, deliberately:
an admin page is what an operator reaches for when something is already wrong, which is exactly when
a bundle that has to load first is the thing that will not. Every control is a form that posts,
changes one thing and redirects. Every POST carries a double-submit CSRF token in a `SameSite=Strict`
cookie, checked before the body is read. Nothing secret is rendered — not the VAPID private key, not
the refresh token, not the local secret — only whether each exists.

**The per-user options are SERVICE-level, and the page says so in those words.** This is the part a
reader could be misled by, so it is stated three times — here, in `admin/access.ts`, and beside the
switches themselves:

- **Push and the message cache are enforced completely.** The daemon and the cache are this
  service's own, so `pushAllowed` and `allowedBots` decide what is sent and what is served before
  anything leaves the process.
- **Mutating HTTP is refused** for a read-only reader, which is the REST surface and file uploads.
- **The WebSocket is not policed, and cannot be.** ADR-0015 makes it a raw byte pipe on purpose, and
  everything of consequence travels over it. `readOnly` is a guard rail against accident, not a
  boundary against intent. An operator who needs the second thing needs two gateways, which is the
  same answer this record already gives for two people who must not see each other's Bot Chats.

**The user list is the people this service has seen sign in.** Upstream documents no route for
listing accounts, and inventing one would be this service guessing at another project's API. The
page names which of the two it is showing rather than letting a short list read as a small team.

**Branding and feature flags ride in `/hermie/config.json`**, which this record already made the
app's bootstrap. Branding is a STARTING POINT and never an override: a reader who has chosen a theme
keeps it, and a chat they have coloured keeps its colour. A flag nobody set is on, and a Hermie Web
too old to send the object at all leaves every feature on — a build must not lose one because the
thing in front of it has never heard of it.

### What this costs

- **One more file in the state directory**, `admin.json`, `0600` beside the push state.
- **One identity round trip on the proxy's hot path**, memoised for fifteen seconds
  (`identity.ts`). `/admin` itself always asks fresh.
- **A service nobody can administer is now a reachable state** — a gateway that named nobody, set up
  without a secret. It is said out loud on the setup page rather than discovered later.

### What is verified

`packages/hermie-web/src/admin/admin.test.ts`, against the real fake gateway with two accounts: the
role gate in all three of its answers, that a POST without the token and a POST with the wrong token
are both refused, that each settings form round-trips and shows itself back, that branding and the
flags reach `/hermie/config.json`, that the cache flag closes the route without deleting anything,
that the state file is `0600`, that the people list fills from who has signed in, that the last
administrator cannot be removed, and that read-only and the bot allow list are enforced on the proxy
and on the cache. `packages/hermie-web/src/admin/access.test.ts` pins the gate's own arithmetic,
including that a gateway naming nobody never matches an empty entry.
`expo/hermie/__tests__/branding.test.ts` pins the app's half: a starting point rather than an
override, and an absent flag reading as on.

**Not verified:** anything against a real gateway, the push ceiling end to end through a real
notifier, and the local-administrator sign-in in a browser.

## Amendment (2026-09-22): part 3 — a built-in OIDC provider, off by default

Part 1 listed "a built-in OIDC provider" among the later parts and promised it would be off by
default. Here it is, and it is the only part of this record that changes what Hermie Web **is**
rather than what it does.

### Why it exists at all

ADR-0015 says, and part 2 repeated, that **Hermie Web has no user database and is not going to grow
one**. That sentence was load-bearing: the admin area is a list of ids the GATEWAY authenticates,
the cache is keyed by a name the GATEWAY hands out, and `identity.ts` asks `/api/auth/me` and
believes the answer. Nothing in this process has ever decided whether a person is who they say.

The rule survives for the deployment it was written for. What it does not survive is the operator it
never accounted for: somebody self-hosting one gateway for a handful of people, with **no identity
provider at all**. Upstream's `dashboard.oauth.self_hosted` provider is a plain OIDC relying party —
it expects Authentik, Keycloak, Zitadel, Authelia — and the honest options for that operator have
been two:

1. **Run the gateway ungated.** Then anyone who can reach the port is everyone, ADR-0007's shared
   Bot Chat is the only conversation there can be, part 2's per-person options have nobody to be
   about, and push has no account to be addressed to.
2. **Stand up Keycloak.** A second service, a second database, a second thing to back up and patch,
   in front of a gateway that is one Python process — for four people.

Neither is a good answer and the second is the one people actually do not do. So there is a third:
**this service can be the identity provider**, because it is already the thing in front of the
gateway, it already holds a credential, and it already has a `0700` state directory and an operator
page.

### Why it is off by default, and stays off

Because the sentence at the top of this section is still the right default. A deployment that has an
identity provider should use it; this one is worse than Authentik at being Authentik and always will
be. Enabling it is a decision with a consequence big enough that it gets its own section below, and
a decision that big should never be something an operator discovers they have already made.

Concretely: `oidc.json` does not exist until something creates it, `enabled` is false until an
operator presses a button, and **every path under `/oidc` answers 404 while it is off** — not 503,
not "not configured", 404, the same answer `/setup` gives once it is closed and for the same reason.

### The threat model, stated plainly

**Enabling this makes Hermie Web the identity root of the gateway.** That is not a side effect; it
is what an identity provider is. The consequences, in the order they matter:

- **The signing key in the state directory is the power to be anybody on that gateway.** Not to read
  what is stored — to MINT an identity. Whoever can read `oidc.json` can sign an ID token with any
  `sub`, hand it to the gateway, and be that person. The state directory was already documented as
  "anyone who can read this has read access to every transcript on that gateway"; it is now also
  write access to every account. There is no configuration that reduces this, because a provider
  that could not sign would not be one.
- **The blast radius is the gateway, not just this service.** Before this, compromising Hermie Web
  got an attacker the service's own refresh token — one account's worth of access, revocable from
  the gateway's side by signing that session out. Now it gets them every account, and revoking it
  means changing the gateway's `issuer` to something else.
- **TLS is not advice here, it is a precondition.** Authorization codes, ID tokens and refresh
  tokens all cross the wire. Upstream refuses to accept a non-`https` issuer at all — it allows
  `http` only on `localhost`, `127.0.0.1` and `::1`, by name — so this service refuses to be enabled
  on one, with `--allow-insecure-oidc` existing to reproduce that refusal deliberately rather than
  to work around it.
- **Back up the state directory, and understand what you are backing up.** Losing it means every
  account is gone and every session breaks. Copying it insecurely means handing over the gateway. It
  is the same file that already held the push credential and the VAPID key; it is now the sharpest
  object in the deployment.
- **The gateway and this service share no secret.** The only thing that links them is the gateway's
  configured `issuer`, and the trust flows one way: the gateway fetches a public document and a
  public key. There is no client secret — this is a public client, authenticated by PKCE — so there
  is nothing to rotate on both sides at once and nothing to leak from the gateway's configuration.
  Registering it is three lines in `config.yaml`, and `/admin/oidc` prints exactly those three lines
  with this deployment's own values already in them.
- **The password hash is `scrypt`, and argon2id would be better.** ADR-0015 forbids a runtime
  dependency in this package and argon2 is a native module, so the trade is stated rather than
  hidden: N=2^14, r=8, p=1, a per-password salt, ~16 MB and tens of milliseconds per guess, with the
  parameters stored beside each hash so the cost can be raised later without locking anybody out.
  That is a real wall against an offline attack on a stolen file and it is weaker than argon2id at
  the same latency. An operator for whom that difference matters has an identity provider already
  and should use it.
- **A TOTP secret is stored, and has to be.** Verifying a time-based code means recomputing it, so
  the secret is recoverable from the state directory by anyone who can read it. It raises the cost
  of a stolen password; it does not survive a stolen state directory, and nothing that verifies TOTP
  locally could.

### What it deliberately does not do

- **No federation.** No upstream identity provider, no social login, no SAML, no LDAP. A deployment
  that has something to federate WITH does not need this at all — it should point
  `dashboard.oauth.self_hosted` at that thing directly and leave this off.
- **No SCIM, and no directory of any kind.** Accounts are made on the page and that is the whole of
  provisioning. A deployment that needs accounts to arrive from somewhere else needs a real identity
  provider.
- **No dynamic client registration.** There is exactly one client — the gateway — with an id fixed
  per install. A registration endpoint would be a second identity surface to secure for nobody.
- **No implicit flow, no password grant, no `plain` PKCE, no HS256.** Authorization code with S256
  or nothing.
- **No back-channel logout.** `/oidc/logout` ends the sign-in HERE; the gateway's own session lasts
  until its ID token expires, and the page says so rather than implying otherwise.

### Written against the relying party, not against the specification

This is the part most likely to be undone by somebody tidying it later, so the reasoning is recorded
rather than left only in the code. Every shape below is what
`plugins/dashboard_auth/self_hosted/__init__.py` and `plugins/dashboard_auth/_shared.py` actually
do, and where the specification allows something wider, the narrower thing is on purpose:

- **RS256.** Upstream's allow-list is `("RS256", "ES256", "RS384", "RS512", "ES384", "ES512")` and
  excludes HS256 by name. RS256 is first, is the OIDC default, and is what any other relying party
  would accept without configuration.
- **The ID token is the token that matters.** Upstream verifies it and treats the access token as
  opaque — it even stores the ID token in `Session.access_token` and re-verifies it on every
  request. So the ID token's lifetime IS the gateway's session length, and it carries exactly the
  claims PyJWT is told to `require`: `exp`, `iat`, `aud`, `iss`, `sub`.
- **`nonce` is echoed, never demanded.** `pkce_login_start` does not send one.
- **Discovery is pinned twice.** The document's `issuer` must equal the configured one, and the URL
  that served it must share that issuer's origin. That is why the issuer is STORED when the provider
  is enabled rather than rebuilt from a `Host` header per request.
- **The refresh grant must answer a fresh `id_token`**, which upstream errors on by name.
- **The one registered redirect URI is the gateway's `/auth/callback`.** It is tempting to also
  register the native app's loopback URI from [ADR-0004](0004-native-pkce-via-webview.md). That
  would be wrong: `native_flow.py` says the gateway is "authorization server _to the desktop_, OAuth
  client _to the Portal_", so the phone's loopback redirect is registered with the GATEWAY and this
  issuer never sees it. `validate_redirect_uri` confirms it from the other side by refusing any
  redirect URI whose path does not end `/auth/callback`. The list is editable on `/admin/oidc` for
  the deployment that genuinely has a second client, and a loopback entry there is matched by RFC
  8252's any-port rule.

### What is verified

`packages/hermie-web/src/oidc/oidc.test.ts`, end to end over real HTTP against the real server, with
every ID token verified against the **published JWKS** using `node:crypto` directly rather than
through this package's own verifier — a test that used our verifier would hide a bug in it, and the
question is whether PyJWT would accept the token, not whether we like it. It pins the discovery
shape, a full PKCE round trip, that a code is spent on its first exchange including a failing one,
that an unknown client and an unregistered redirect URI are RENDERED rather than redirected, refresh
rotation, that replaying a rotated token revokes the whole family, the TOTP and recovery-code paths,
and that a key rotation leaves tokens signed by the old key verifying.
`packages/hermie-web/src/oidc/crypto.test.ts` pins the primitives against their own specifications:
RFC 6238's published test vectors, RFC 7638 thumbprints, and the two attacks a hand-written verifier
gets wrong — `alg: none` and a token signed by a foreign key.
`packages/hermie-web/src/admin/identity.test.ts` pins the operator's half against the real fake
gateway with two accounts: the role gate, a POST with no CSRF token, that enabling mints an issuer
from the origin the page was reached on, that the printed snippet carries this deployment's real
values, the invitation round trip including that the link is shown once and works once, and the test
sign-in in both its outcomes.

**Not verified:** anything against a real Hermes gateway. Nothing in this round has been accepted by
upstream's PyJWT, only by a test written from reading it. The discovery pin, the algorithm list and
the required claims are all transcribed from that source and are the first things to check if a real
gateway refuses a sign-in. Also unverified: any of these pages in a browser, and the provider behind
a reverse proxy that terminates TLS — which is the configuration the threat model above assumes.

**One gap in the gates themselves, found while writing this.**
`packages/hermie-web/tsconfig.json` excludes `src/**/*.test.ts`, so `npm run typecheck` does not
type-check this package's tests. A test in this round called a three-argument function with two and
the gates stayed green; it was caught by the assertion failing, which is luck rather than a process.
