# 0024. A list of gateways, one live at a time, everything on disk keyed by which

- Status: Accepted
- Date: 2026-09-22
- Amends: [0006](0006-single-gateway-no-relay.md)
- Touches: [0012](0012-local-chat-list-layout.md), [0016](0016-ui-meta-sync.md),
  [0017](0017-push-through-hermie-web.md)

## Context

[ADR-0006](0006-single-gateway-no-relay.md) said one gateway per install. It gave one reason and the
reason was about the **relay**: Hermes Desktop can hold connections to several gateways at once and
route bot-to-bot envelopes between them, a phone cannot, and a relay that depends on an app staying
in the foreground would deliver some messages and drop the rest with nothing on screen to say which.

That reason has not weakened and nothing here contradicts it. What it did, though, was fold a second
decision in with it:

> Setup adds it; changing the gateway means running setup again, which also clears the local cache.

That sentence is not about the relay. It is about storage, and it was true because there was exactly
one of everything on disk: one `hermie.gateway.config`, one `hermie.auth.access_token`, one cached
roster. "Change gateway" meant overwriting all of it, so moving between two machines meant signing
in again in each direction and losing the arrangement and the cached conversations every time.

People do have two. A machine at home and one at work; a personal gateway and a client's; a
production gateway and the one they are testing a plugin on. Every one of those is a person paying a
sign-in and a cold start for a trip they make several times a day.

## Decision

**Hermie keeps a list of gateways and holds exactly one live connection.**

The relay half of ADR-0006 stands unchanged: Hermie never runs the relay loops, holds one socket,
and bots message each other only inside the gateway they live on, where delivery is server-side and
works while the app is closed. Two gateways configured is not two connections — it is one
connection, and a switch that tears it down and dials the other.

### A gateway is a record with a random id

`{ id, name, address, authKind, signedInUser?, addedAt }`, in `hermie.gateways`, with
`activeGatewayId` beside it. The id is random and minted once. It is deliberately **not** the
address: two entries can legitimately hold the same address — the same host under two accounts — and
an address is a thing a reader edits. Everything on disk keys off the id, so correcting a port costs
one row redrawing rather than an arrangement.

The list is **per device and never synced**. Which machines a phone can reach is a fact about the
phone and the networks it is on, and syncing it would require choosing a gateway to sync it to,
which is the question the list exists to answer.

### Everything gateway-specific is namespaced, through one helper

`namespace(gatewayId).key(base)` produces `<base>@<gateway id>`, and it is the only place a stored
key learns which gateway it is about. That is not tidiness: the one-time move has to be able to name
every key it carries across, and a suffix spelled out by hand at one more call site is a key left
behind that then starts a second life as "the one nobody claimed". The separator is `@`, every base
key is dotted and every id is hex, so a namespaced key splits one way.

Namespaced: the configuration, the six keychain items, the auth ring, the read watermarks, the
per-account settings, the push registration, the chat arrangement, and every cached transcript and
roster row.

**Four things are not, and each is a decision rather than an omission:**

- The **registry** itself. It is what knows the ids.
- The **app lock** (ADR-0017's neighbour in `features/lock`). It is about the device in somebody's
  hand, and a phone that unlocked itself by switching gateway would not be a lock.
- The **push installation id**. ADR-0017 keys a device's registration by an id minted once, and its
  own words are the argument: a device that re-minted it "would leave a dead registration behind
  each time and the daemon would go on sending to tokens that nothing answers". Per gateway is that
  same failure at a slower rate.
- **Light or dark.** It was inside the settings blob and is now `hermie.appearance` on its own,
  because it is about the eyes in front of the screen rather than about an account. Everything else
  in that blob either follows the account through ADR-0016's `hermie-app:<user_id>` or is keyed by
  bot name, and bot names are a gateway's own — two gateways can each have a `researcher`.

The price of splitting the appearance out is stated here rather than discovered: the **theme** still
follows the account, so a chosen preset now lands one disk read later than light-or-dark does,
behind the splash. `ThemeProvider` sits above the lock and the wizard and has no gateway id to ask
with.

### The move off the unsuffixed keys happens once, and before anything is read

On the first launch after this, the single configured gateway becomes entry one — same address, same
credentials, same cached conversations — and its storage follows its entry. It runs before the
configuration is read, because the configuration is one of the things being moved. It is decided by
the registry key being **absent** rather than by the list being empty, so a reader who removed their
last gateway does not find it back the next morning. Every step is independent and the whole thing
never throws: a keychain that refuses one item costs a sign-in, not a launch.

The chat arrangement was already keyed by gateway — by ADDRESS, which was the only name a gateway
had when ADR-0012 was written. It is re-keyed to the id, and that changes one behaviour knowingly:
**"Change gateway" now keeps the arrangement**, because it edits an entry rather than replacing the
one gateway. Moving to a genuinely different machine is "Add gateway", which is a different act with
a different entry.

### What travels on the wire is a key derived from the address

The local id is exactly the wrong thing to put in a push payload or a deep link: it is minted on one
device, means nothing on another, and nothing outside the app has ever seen it. The notifier —
whether that is the gateway plugin or `hermie-web --push` — knows its own **address**.

So registrations, notifications, `hermie://chat/<bot>?gateway=<key>` and the widget snapshot carry
`gatewayKey`: **FNV-1a, 64-bit, over the UTF-8 bytes of the origin, as 16 lowercase hex digits.** It
is specified rather than implemented once because three programs have to produce it — the app, this
project's daemon, which [ADR-0015](0015-web-variant-on-its-own-port.md) makes
zero-runtime-dependency and which therefore carries its own copy, and the gateway plugin, which is
Python. A shared test vector is how each copy proves it agrees. The ORIGIN and not the address: a
path prefix in somebody's configuration is the same gateway reached a different way.

**It is not a secret and not a security boundary.** A key SELECTS a gateway the owner has already
configured; a forged, stale or malformed one selects nothing and leaves the app where it is, which
is what every entry point in this project already does with a payload it cannot resolve.

**A tap from another gateway switches and then stops.** An Allow cannot be re-read against
`approval.pending` on a gateway whose connection does not exist yet, so the reader lands on the
request and answers it there. That is ADR-0017's "a notification is a hint, never an instruction"
taken one step further.

### One gateway's storage is removable

"Remove" in the list takes the address, the credentials, the cached conversations, the arrangement
and the settings. It is the mirror of the migration and is written against the same list of keys: a
key that is namespaced but not named there outlives the gateway it belongs to for ever, because
nothing will have a reason to look at it again.

## Consequences

- **Two people's worth of gateways on one phone now cost one tap.** That is the whole point.
- **A switch is a teardown and a dial.** The screens paint from the new gateway's own cache while
  that dial is in flight, which is the same path a cold start takes.
- **Adding does not switch.** Describing a second machine is not asking to be moved onto it, and an
  add that switched would drop a socket mid-conversation. Only a first entry becomes active, because
  there is nothing to tear down and nowhere else to point.
- **Switching keeps the push registration on the gateway being left.** A reader stepping away from a
  machine still wants to hear about the bots on it, and the daemon there is still running. This is
  the one path where keeping the row is the point rather than something that could not be helped.
- **Removing a gateway cannot retire its registration** unless it happens to be the live one: taking
  a device out of the section is a write over that gateway's socket. The screen says so rather than
  leaving it to be discovered, and the daemon's own receipts retire an address nothing answers.
- **`clearUrlCache()` is still global.** `URLCache` is keyed by bundle identifier and cannot be
  scoped to one gateway, so forgetting one empties what the platform cached for all of them. It
  costs a redirect lookup, which is the cheapest thing on this list.
- **The registry is one more thing that can be corrupt.** It is versioned and read defensively, and
  a version it does not know leaves an empty list — which lands on the wizard, with every gateway's
  namespaced storage still on disk and unreachable. That is the worst outcome here and it is a
  re-run of setup rather than a loss.

## What is verified, and what is not

The suites cover the leak the whole design exists to prevent —
`expo/hermie/__tests__/gateway-namespaces.test.ts` signs in to two gateways and checks that each
one's tokens, settings, watermarks, arrangement and cached rows stay its own, that the installation
id does not — and the move off the unsuffixed keys, the list's arithmetic
(`gateway-registry.test.ts`), the screen (`gateways-screen.test.tsx`), the routing key and what a
tap from another gateway does (`gateway-routing.test.ts`), and the dead-connection card
(`gateway-stopped-multi.test.tsx`). The two copies of `gatewayKeyOf` are pinned to one vector.

**What has not been seen:**

- **Two real gateways.** Everything above is the fake gateway, mocked stores and a mocked keychain.
  No device has been set up against two `hermes serve` instances and switched between them, so the
  claim that a switch paints from cache and then reconciles is a reading of the code paths a cold
  start already takes, not a measurement.
- **A real push tap routing across gateways.** No notification carrying a `gatewayKey` has been
  produced by a real notifier and tapped on a real device. The app's half is tested against
  synthesised payloads.
- **The plugin's half does not exist yet.** The gateway plugin has to add `gatewayKey` to its
  payload, and until it does, a notification from a plugin-notified gateway carries no key and is
  read exactly as it always was: open that chat on the gateway that is live.
- **The widget's tap does not carry the key.** The snapshot now holds it, and the native widget code
  (`expo/hermie/modules/hermie-widgets`) still builds `hermie://chat/<bot>` without the parameter.
  The JavaScript half is ready and the Swift half is a separate change.
- **The SQLite and IndexedDB namespacing is checked by the statements it issues**, not by a round
  trip through an engine: there is neither in the test environment. What that does catch is the one
  thing that could leak — `DELETE FROM bots` with no `WHERE` on it.
