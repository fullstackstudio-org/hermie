# 0014. Plain http is supported, because a tailnet has already encrypted the path

- Status: Accepted
- Date: 2026-09-20

## Context

A Hermes gateway runs agents that execute commands on the machine it lives on, so the recommended
deployment — the one the README argues for — is a private network: Tailscale, or Headscale for
people who would rather host the control server themselves. On such a network every packet between
the device and the gateway is already inside a WireGuard tunnel. Terminating TLS on top of that
protects nothing that is not protected already, and it costs a certificate, a reverse proxy and a
name that a certificate authority will issue for.

So the ordinary setup is `hermes serve` listening in the clear, reached at one of:

- a Tailscale address, `100.64.0.0/10` or `fd7a:115c:a1e0::/48`;
- a MagicDNS name, `host.tailnet-name.ts.net`;
- a Headscale base-domain name, which is whatever the operator chose;
- a LAN address or a `.local` name;
- `localhost`, when the gateway is on the same machine.

Hermie's JavaScript already accepted all of that: `normalizeBaseUrl` allows `http://` and
`wsUrlFor` derives `ws://` from it. What did not accept it was the operating system.

**iOS.** App Transport Security blocks cleartext by default. The Expo SDK 54 template writes
`NSAllowsArbitraryLoads: false` with `NSAllowsLocalNetworking: true`, and that combination is not
enough. Measured on an iOS 27 simulator against a Release build (the full matrix is in the
2026-09-20 section of [docs/platform-notes.md](../platform-notes.md)): `http://192.168.2.250:9119`
was allowed, and `http://192-168-2-250.nip.io:9119` — a fully qualified name in a public zone
resolving to that same address, which is the shape of a MagicDNS name — was refused with
`NSURLErrorDomain -1022`, "the App Transport Security policy requires the use of a secure
connection". ATS judges the host as written, not the address it resolves to. The same rule governs
the `WKWebView` that renders the sign-in page and the `ws://` dial.

**Android.** Cleartext is off by default for a release build targeting API 28 or newer. Expo's
template sets `usesCleartextTraffic="true"` in the **debug** manifest only, which is the worst shape
a defect can have: every development build works and the gap appears the first time somebody
installs a release.

Three ways out were considered.

1. **Nothing; require https.** Honest, and wrong: it makes the deployment the project recommends
   the one it does not support, and pushes every tailnet user into a certificate they do not need.
2. **Narrow exceptions.** `NSExceptionDomains` is per-domain and the gateway's address is typed by
   the user during setup — there is no domain to name at build time. An exception for `ts.net` with
   `NSIncludesSubdomains` would cover Tailscale's own MagicDNS and nothing else: not Headscale,
   whose base domain is the operator's choice, and not a bare tailnet IP. Android's
   `networkSecurityConfig` has the same shape and the same limitation.
3. **Allow cleartext, and be explicit about it in the app and to the reviewer.**

## Decision

Hermie supports plain `http://` and sets the platform permission that makes it work:

- iOS, through `ios.infoPlist` in `expo/hermie/app.config.ts`: `NSAllowsArbitraryLoads: true`, and
  **nothing else in that dictionary**. The template's `NSAllowsLocalNetworking` is removed with it.
  That is not tidiness: since iOS 10 the presence of `NSAllowsLocalNetworking`,
  `NSAllowsArbitraryLoadsInWebContent` or `NSAllowsArbitraryLoadsForMedia` makes the system IGNORE
  `NSAllowsArbitraryLoads` and fall back to its default of false. The first attempt at this decision
  shipped all three, and the cleartext FQDN was still refused with `-1022`; deleting the other two
  from the same installed bundle allowed it. Web content follows `NSAllowsArbitraryLoads` when the
  web key is absent, so the sign-in view loses nothing by the omission — verified by loading the
  gateway's authorize page over http in the Release build.
- Android, through `expo-build-properties`: `android.usesCleartextTraffic: true`, which puts the
  attribute on the main manifest's `<application>` and so covers release as well as debug. The
  template already sets it in the debug manifest, which is why nothing caught this in development.

Permission is not use, and four things keep it that way:

- **The default is still https.** An address typed with no scheme is probed over `https://` first.
- **The fallback is narrow.** `http://` is tried only when the https probe got no answer at all:
  nothing listening, no answer in time, or a TLS handshake that died because the peer never spoke
  TLS. A rejected CERTIFICATE is not a reason to retry in the clear — it means there IS an https
  server there — and neither is any HTTP status.
- **An explicit `https://` is never downgraded.** The user's scheme is an instruction.
- **The app says what it ended up on.** The probe line reads `Found over http://` when the fallback
  ran, and a cleartext address carries one line describing it. The tone comes from
  `classifyHost` in `packages/gateway-client/src/host-privacy.ts`: loopback, RFC 1918, link-local,
  CGNAT, `.ts.net`, `.local`, `.internal` and unqualified names are stated as fact, and everything
  else is a warning with a `Use https instead` action next to it. Settings repeats only the warning.
  `.internal` was added later the same day, after that warning fired on a real Headscale gateway and
  its `Use https instead` action walked the owner into a self-signed certificate; ICANN reserved the
  suffix for private use and it is never delegated in the public root, so it is as unresolvable from
  outside as `.local`. The measurement is in the 2026-09-20 tailnet section of
  [docs/platform-notes.md](../platform-notes.md).

Whether the transport is appropriate stays the operator's decision. Hermie states the facts and
does not refuse.

## Consequences

- **An App Store review note is now required.** Apple asks for a justification whenever a submission
  lowers ATS. `docs/release.md` holds the text: a user-configured self-hosted server, reached over a
  private VPN, whose address is not known at build time. A reviewer could still push back, and the
  fallback position — a `ts.net` exception plus `NSAllowsLocalNetworking`, which serves Tailscale
  and abandons Headscale — is recorded here so it does not have to be re-derived under time
  pressure.
- **The app may now make a cleartext request to any host, as far as the OS is concerned.** What
  stops it is that there is nowhere else to call: Hermie talks to the configured gateway and to the
  identity provider that gateway redirects the sign-in page to. There is no analytics SDK, no update
  server (`updates.enabled` is false) and no third-party endpoint. That property is worth
  re-checking whenever a dependency that fetches something is added.
- **A wrong address is now reachable rather than refused.** Before this, ATS was accidentally acting
  as a second opinion on a public http address. It never was a good one — it says nothing on Android
  debug builds and nothing about a private address — and the warning in the address step is the
  deliberate version of it.
- **The "never downgrade past a certificate error" rule is weaker on a device than in this package.**
  React Native's `fetch` rejects every transport failure with `TypeError('Network request failed')`
  and discards the underlying error, so on a phone the resolver cannot tell a rejected certificate
  from a port that speaks no TLS, and falls back for both. The rule is implemented and tested where
  a real message arrives; on device the mitigation is that the fallback announces itself and warns
  on a public host. `docs/platform-notes.md` has the measurement and what closing it would take.
- **The probe can cost two round trips.** A scheme-less address that ends up on http pays the https
  probe first. It is bounded by `PROBE_TIMEOUT_MS`, and the common failure on a tailnet — a closed
  port — is refused immediately rather than waiting it out.
- **`dashboard.public_url` matters more, not less.** The gateway builds sign-in redirects from it,
  and it has to match the address in use down to the scheme. That was already true; a deployment
  that can legitimately be either http or https makes it easier to get wrong.
