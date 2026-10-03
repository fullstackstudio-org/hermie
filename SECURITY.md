# Security policy

## Reporting a vulnerability

Report security issues privately to **security@fullstackstudio.nl**. Please do not open a public
issue for anything exploitable.

Include what you can: the version or commit, the platform, what an attacker can achieve, and the
steps to reproduce. If you have a proof of concept, a small one is worth more than a long report.

You will get an acknowledgement within three working days and an assessment within ten. If the issue
is confirmed, we will agree a disclosure date with you; we aim to ship a fix before it, and we will
credit you in the release notes unless you prefer otherwise.

## Scope

In scope: the Hermie app and the packages in this repository.

Out of scope, because they are other people's projects — report them upstream:

- Hermes Agent itself, including `hermes serve` and its authentication endpoints
  ([NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)).
- Identity providers, access proxies and other infrastructure a gateway sits behind.

## What Hermie stores and where

Knowing this helps when assessing an issue:

- **Secrets** — access token, refresh token, session token, any extra request headers and the
  Cloudflare Access service token — go in the platform keystore through `SecretStore`. On iOS and
  Android that is the system keychain, with a device-only, after-first-unlock accessibility class. A
  Mac runs the same iOS build (ADR-0011) and therefore the same `expo-secure-store`.
- **Non-secret configuration** — the gateway URL, display preferences — goes in plain key-value
  storage.
- **Chat transcripts** are cached locally so the app can paint before the gateway answers. They are
  not encrypted beyond the protection the operating system gives the app container.
- **iCloud Keychain** (the native Apple apps only, [ADR-0032](docs/adr/0032-icloud-gateway-sync.md)).
  If "Sync with iCloud Keychain" is on, Hermie stores your list of gateways (name, address, how you
  sign in, and your user id on that gateway) and the credentials that are the same on every device (a
  session token, a Cloudflare Access service token, custom headers) in your iCloud Keychain. iCloud
  Keychain is end-to-end encrypted: Apple cannot read it and neither can we, and it reaches only
  devices signed in to your Apple Account that you have approved. Sign-ins through an identity
  provider or a password stay on the device that made them. Messages, drafts, the app lock and
  notification registrations are never stored there. Nothing is sent to us. If iCloud Keychain is
  off, the same data stays on the device.

  For an assessment: anyone who holds the person's iCloud Keychain (an approved device, or the
  account and a device passcode) holds every session token in it, which is full access to that
  gateway. Only the sync engine reads the synced items; a credential from them is written to the
  device-only keychain only for the origin it was entered for, and the Cloudflare Access pair never
  for a plain-http gateway. The app shows what will be stored and asks before it first writes there.

The gap that used to be here — macOS had no keystore-backed `SecretStore`, so tokens went to
unencrypted app storage — is closed. The native macOS target is gone, and the Mac runs the iOS build
with the iOS keychain, and that is now **exercised rather than assumed**: on 2026-09-19 a Mac window
stayed signed in across a quit and a relaunch, which is a keychain read and a keychain write of the
token in the ordinary path.

One observation from the same session, recorded because it is not explained: the FIRST launch of that
build did ask for a sign-in again. The cause was not established — a fresh install and a new wrapper
are both in the picture, and a different keychain access context is a plausible reading — so it is
written down as something seen once, not as a known behaviour.

## Access proxies in front of the gateway

Setup's **Advanced** step carries a credential for whatever stands between Hermie and the gateway:
either arbitrary request headers, or the **Cloudflare Access** preset, which is a service token's
Client ID and Client Secret sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

- **Where it lives.** In the platform keystore through `SecretStore`, in its own item, **bound to
  the gateway origin it was entered for**. A record whose origin does not match the configured
  address is dropped rather than sent; a record with no origin counts as a mismatch. A service
  token is issued for one Access application, and one that followed the app to another address
  would be a tenant-wide credential handed to a host that never asked for it.
- **Where it goes.** Every REST call, the WebSocket dial and its ticket mint, both of the probe's
  requests, and the in-app sign-in page — where it also becomes a document-start script so the
  page's own `fetch` carries it. That script attaches the headers only when the page's origin and
  the request's origin are both the gateway's, so a sign-in that has navigated to the identity
  provider does not take the token with it. On Android the in-app page is not used at all when
  headers are configured: its WebView re-sends them across a cross-origin redirect
  ([ADR-0004](docs/adr/0004-native-pkce-via-webview.md)).
- **Where it does not go.** Never over `http://` or `ws://` — the headers are withheld and the
  setup screen says so. Never into a log: header values are redacted wholesale rather than by a
  list of known names, and the developer screen is told only `cf-access: present`.
- **What it cannot do.** A service token authenticates a REQUEST, not a browser. A top-level
  navigation the sign-in page performs carries no headers, so an Access policy covering `/auth/*`
  and `/login` cannot be satisfied this way; those paths must be exempt.
  [ADR-0021](docs/adr/0021-header-based-front-doors.md) has the reasoning and the limits.

## The app lock

Settings → Privacy & security → **Require unlock** puts `expo-local-authentication` in front of the
app: Face ID, Touch ID, Optic ID or Android's BiometricPrompt, with the device passcode as the
platform's own fallback. Off, immediately, or after 1, 5 or 15 minutes in the background; a cold
start always asks.

What it is and is not worth stating precisely, because a lock that is described too generously is
worse than none:

- **A locked app does not render its contents.** The plate is not an overlay — the gate above the
  gateway provider does not mount its children, so there is no live transcript, no chat list and no
  open socket behind it. That is also what the operating system's app-switcher snapshot gets, which
  is why "immediately" locks on the way out rather than on the way back.
- **It does not encrypt anything.** The credentials are in the keystore either way, and the
  transcript cache is protected by the app container and nothing more. This keeps a person who
  picks up an unlocked phone out of your chats; it does not keep out someone with the device, its
  passcode and time.
- **It is per device and is never synced.** The threshold has its own key in plain key-value
  storage and is deliberately not part of the settings section ADR-0016 carries to the gateway.
- **It cannot be switched on with nothing enrolled.** A device with no biometric and no passcode is
  told to set one up rather than being locked behind a prompt that cannot succeed. A prompt that
  fails, is cancelled, or cannot run at all leaves the app locked — a broken module is not a way in.
- **There is no app lock in a browser**, and the settings screen says so rather than offering one: a
  plate drawn over this app's own DOM is enforced by the same JavaScript it is protecting.
- **Notification previews are not the lock's business.** What a banner shows on a locked screen is
  the operating system's setting and the notification's own payload; [ADR-0017](docs/adr/0017-push-through-hermie-web.md)
  is where that payload is decided.

## Transport

Hermie talks to one gateway, at an address the user types during setup, and to the identity provider
that gateway redirects the sign-in page to. It is not known at build time, so the app cannot declare
per-domain transport rules for it: iOS ships `NSAllowsArbitraryLoads` and Android
`usesCleartextTraffic`, which permit cleartext to **any** host either platform is asked to reach.
[ADR-0014](docs/adr/0014-plain-http-on-private-networks.md) records why, and which narrower options
were measured and ruled out.

Permission is not use. The app has no address of its own to call: every request goes to the
configured gateway. An address typed without a scheme is probed over `https://` first and only tried
over `http://` when https does not answer at all; an address typed with `https://` is never
downgraded; and the app says on screen when the connection it ended up with is in the clear.

**Which transport is safe is the operator's call, and it is a real one.** Over Tailscale, Headscale
or on the same machine, plain `http://` is encrypted by WireGuard or never leaves the host, and TLS
on top adds nothing. Over the open internet it is a different sentence: the session token, the bearer
token, the sign-in and every message are readable by anyone on the path, and Hermie warns about
exactly that case rather than refusing it. Hermie does not pin certificates and does not ship a trust
store of its own; a self-signed certificate has to be trusted by the device.

## Hermie Web

`packages/hermie-web` is part of this repository and carries its own attack surface, beyond what the
app itself does. It authenticates nobody — the gateway's own session cookie does that — but it holds
secrets of its own in its state directory (`0700`, files `0600`):

- the service login (a session or refresh token) it spends on push and on the message cache;
- the VAPID key pair, once `--push` is used;
- an **administrator secret**, stored as a scrypt hash and never shown back, for a gateway with no
  accounts of its own to gate `/admin` with;
- and, only where its built-in identity provider is turned on, every account's password hash, its
  own OIDC signing key, and refresh tokens for the people it has signed in.

**`/admin` is gated by a gateway user id on this service's own list**, or by the administrator
secret above when the gateway has none. It issues no session of its own: every request is checked
fresh against the gateway's `/api/auth/me`.

**`/admin/danger` → Run setup again** clears the stored gateway address, the administrator list and
secret, the branding, the feature switches, the push policy, the cache retention, the per-person
options, and the service login — asking a second time first, on a page that lists all of it. It
never clears the built-in identity provider's accounts, signing key or client id: discarding that
key on a re-run would sign out every account on the gateway, and turning the provider off is a
separate, explicit action on `/admin/oidc`. The cached messages and the VAPID key are kept unless a
box is ticked for each.

**The built-in OpenID Provider, when turned on, is the identity root of that gateway.** Whoever can
read the state directory can mint any account on it, not merely read what is stored — there is no
setting that reduces this, because that is what an identity provider is. It refuses to enable on a
plain-`http` origin that is not loopback, because the gateway itself refuses a non-`https` issuer
outside `localhost`/`127.0.0.1`/`::1`.

**The message cache holds transcript content on disk**, in the same state directory, scoped so that
a private chat is cached only for the person who read it and a shared Bot Chat is cached for
everybody; `--cache-max-mb 0` turns it off.

None of this changes the app's own trust model above: the app still speaks only to the gateway it is
configured with, and a Hermie Web instance is exactly that — a gateway address, reached the way any
other gateway is.

## Supported versions

| Version            | Supported                         |
| ------------------ | --------------------------------- |
| `main`             | Yes — fixes land here first       |
| The latest release | Yes                               |
| Anything older     | No; upgrade to the latest release |

Hermie has not had a release yet, so today that means `main`. Once there is one, security fixes go
to the latest released version and no further back: there is one codebase, and a build from source
is always an option.

Hermie is a client. A fix in the gateway it talks to is an upstream release, on upstream's schedule,
and the two version numbers are unrelated.
