# 0016. Per-client settings live in `ui_meta`, one section per concern, last writer wins

- Status: Accepted, amended 2026-09-22 (the app-wide section says when it was chosen)
- Date: 2026-09-21
- Amends: [0012](0012-local-chat-list-layout.md)

## Context

ADR-0012 put the chat list's arrangement — order, dividers, archived, per-chat colour — in the
device's own key-value store, and ended on a condition: _"If the gateway ever grows a per-client
metadata scope, this is the one module to change."_

It has one. A profile row carries `ui_meta` (a free-form object) and `ui_meta_revisions`
(`Record<string, number>`), and `profiles.configure` takes `ui_meta` together with
`ui_meta_expected_revisions` and answers with `applied.ui_meta_revisions` and
`applied.ui_meta_conflicts`. Upstream's own docstring, which
`packages/hermes-shared/src/gateway-contract.generated.ts` carries verbatim, says what that
machinery is:

> Sections are independent; `ui_meta_expected_revisions` is a per-key compare-and-swap.

So the unit is the **top-level key**. Each key has its own revision counter; a write names the keys
it is changing and leaves every other key alone; a key whose expected revision disagrees with the
stored one is refused on its own while the rest of the same request still applies.

That matters more than it looks. `ui_meta` is not ours: the marker `ui_meta: {"hermes-bots": {}}` is
what makes a profile show up as a bot at all (see docs/GLOSSARY.md), and it is written by another
tool. A client that stored its settings by replacing the bag would un-bot every profile it touched.
Per-key writes are what make the scope safe to use, not merely convenient.

`ui_meta` is also **per profile**, and Hermie has two kinds of setting:

- ones that are about one bot — archived, colour — which have an obvious home on that bot's profile;
- ones that are about the whole app — chat order, dividers, themes, the verbosity and bot-to-bot
  defaults — which are about no single bot.

The second kind needs somewhere app-wide, and the gateway offers no scope that is not a profile.
The default profile (`is_default` on the roster row, the profile `hermes serve` runs as) is the one
row every client can find without being told which bot to ask.

There is also the question ADR-0012 answered the other way, and it has not gone away: two people can
use the same gateway, and one of them grouping four bots under "Finance" is a statement about how
**they** work. The gateway has no per-user scope inside a profile either. What has changed is the
trade: ADR-0008's trap was a setting on a phone silently changing what a colleague's **desktop**
shows, and that trap was about `config.set` — the global configuration file that Hermes Desktop, the
TUI and the messaging platforms all read and act on. `ui_meta` under our own key is read by nothing
but Hermie.

## Decision

Hermie's settings are stored in `ui_meta` under keys it owns, and are **never** written anywhere
else on a profile.

**Two keys, both versioned.**

- `hermie` — on **that bot's** profile. Everything that is about one conversation: `archived`,
  `colour`.
- `hermie-app` — on the **default** profile. Everything that is about the window: chat order, the
  named dividers, the theme (the preset choice and any user themes), and the `showBotToBot` /
  verbosity defaults.

Each carries a schema version of its own, because they will not move together:

```json
{ "v": 1, "archived": true, "colour": "teal" }
```

A reader that meets a `v` it does not know ignores that section and keeps its local copy, rather
than guessing at a shape. A writer never lowers `v`.

**Last writer wins, per section, guarded by the revision.** Every write sends the revision the
client last read for that key. The gateway refuses a stale one and says what it found; the client
takes the newer value, re-applies its own change on top and writes again. There is no merge of two
divergent arrangements: an order is a list, and a list merged with another list is neither of them.

**Local cache first.** The device's store stays the thing the UI reads, so the app paints before the
socket has answered and works with no gateway at all. Reconciliation runs on connect and on
`sessions.changed` / profile-change events. A write goes to the local store first and to the gateway
after; a write the gateway refuses or never receives stays local and is retried on the next
reconcile.

**The local-only fallback stays.** A gateway too old to carry `ui_meta`, or one that refuses the
write, leaves Hermie exactly where ADR-0012 left it: keyed by gateway address, on the device. That
is not a degraded mode to be apologised for — it is the behaviour ADR-0012 chose, still correct.

## Consequences

- The arrangement follows a person to a second device, which is the whole point, and is no longer
  lost with the app's data.
- Two people on one gateway now share an arrangement. That is a real regression against ADR-0012's
  reasoning and it is accepted knowingly: the gateway has no per-user scope, and the alternative is
  that nobody's arrangement follows them anywhere. If the gateway grows one, this is the ADR to
  supersede.
- Every write is a round trip that can be refused, so every writer has to be able to handle the
  refusal. That is the cost of the compare-and-swap and the reason the revision is stored beside the
  value rather than being derived.
- A bot's section lives on that bot's profile, so deleting a profile takes its colour and its
  archived flag with it. That is the right lifetime.
- `hermie-app` on the default profile means a gateway whose default profile a client cannot read has
  no app-wide settings. It falls back to local, which is the same path a refused write takes.

## What is verified, and what is not

`packages/fake-gateway/src/ui-meta.test.ts` pins the semantics above against the fake gateway: the
round trip, that a write leaves `hermes-bots` alone, that a named key is replaced whole, that
revisions count per key from zero, that a stale expected revision is refused with
`{ expected, actual }` while the other sections of the same request still apply, that a blind write
with no expected revision is accepted, and that a key written as `null` is removed.
`packages/gateway-client/src/ui-meta.test.ts` drives the CLIENT over a real socket against that
fake: the round trip between two devices, the conflict retried, an offline write synced when a
gateway appears, and the marker untouched.

### The probe, and what it settled (2026-09-21)

Run against `hermes serve` **0.21.3** (`upstream b25ce157`) on the reviewer gateway, on the `guide`
profile, which already carried `ui_meta: {"hermes-bots": {}}`:

```
before  ui_meta keys : ['hermes-bots']        revisions: {}
write   applied      : {"ui_meta":true,"ui_meta_revisions":{"hermie":1}}
after   ui_meta keys : ['hermes-bots','hermie']
MARKER SURVIVED      : true
REVISION MOVED       : true (0 -> 1)
stale   applied      : {"ui_meta":false,"ui_meta_conflicts":{"hermie":{"expected":0,"actual":1}},
                        "ui_meta_revisions":{"hermie":1}}
cleanup applied      : {"ui_meta":true,"ui_meta_revisions":{"hermie":2}}
final   ui_meta      : {"hermes-bots":{}}
```

Every claim in this record held. The marker survived a write of a neighbouring key; the revision
moved by exactly one; a stale expected revision was refused with the `{ expected, actual }` shape the
fake reproduces, and refused means refused — the loser's value was not on the profile. The same probe
on the **default** profile (`default`, `is_default: true`, which carries no `hermes-bots` marker
because it is not a bot) wrote and removed `hermie-app` and left `guide` and `notes` untouched, which
is the other half of the decision above.

**One thing the fake had wrong, and it is the reason the probe was worth running.** A key written as
`null` is REMOVED by the real gateway; the fake stored the null. So the fake was the more forgiving
of the two, and a client that drops a section by writing null — which is this client — would have
left a dead key on a real profile while every test stayed green. The fake deletes it now.

**Not the protocol, but worth writing down.** Upstream answers the WebSocket upgrade **without**
echoing `Sec-WebSocket-Protocol`, at the origin as well as through the proxy, while the fake gateway
echoes `hermes-gateway-v1`. RFC 6455 permits the omission and a browser accepts it, but Node's `ws`
refuses a 101 with no subprotocol when it asked for one. Nothing in Hermie is known to be affected —
the app's own dial has always worked against real gateways — but the fake is stricter than the thing
it stands in for here, and that asymmetry is the kind that hides a client bug rather than a server
one.

The gateway was left as it was found: both keys removed, both bags back to their original contents.
Only the revision counters moved, which they cannot be asked not to.

## Amendment, 2026-09-21: the app-wide key carries a person's name

### What this closes

This record ended on a regression it accepted knowingly:

> Two people on one gateway now share an arrangement. That is a real regression against ADR-0012's
> reasoning and it is accepted knowingly: the gateway has no per-user scope… If the gateway grows
> one, this is the ADR to supersede.

The gateway still has no per-user scope. The arrangement turned out not to need one. The key is a
**string this client chooses**, so a person's name inside it separates two readers exactly as
completely as two scopes would — the separation is as strong as the fact that nothing but Hermie
writes these keys, which was already the premise the whole decision rested on.

### What is decided

**The app-wide key is `hermie-app:<user_id>`.** `<user_id>` is the gateway's own identity for
whoever is signed in — the value `/api/auth/me` answers, which the device-context store already
reads — and `owner` on a session-token gateway, where there are no accounts and therefore nobody to
name. An ungated gateway therefore lands on `hermie-app:owner` and keeps one arrangement, which is
the right answer for a gateway with one person on it.

Everything that is **arrangement or preference** lives there: the chat order, the folders
([ADR-0019](0019-folders-in-the-chat-list.md)), the theme (preset and user themes), the per-bot
settings, the mutes, and the device-context section.
Push registrations stay keyed per installation inside it, as they already were.

The per-bot key `hermie` is **unchanged**. Archived and colour are about the bot, not about who is
looking at it, and they live on that bot's own profile as before.

**A reader the gateway has named nobody on writes no arrangement at all.** Not under the legacy key,
not under a guessed one. That is the same rule the context section already follows — writing
somebody's settings under a name the gateway never agreed to is worse than writing none — and it
leaves that reader exactly where ADR-0012 left them: synced per bot, arranged on the device.

### The anonymous section, and the one copy out of it

The bare `hermie-app` is now the **legacy** key. It is read once, when a person has no key of their
own and an anonymous section exists, and its contents are copied into theirs. After that it is never
read again and never written. It stays on the gateway as the anonymous default, because an older
build on another device goes on reading it and emptying it would undo that device's list.

The copy is **filtered**, and that is the part worth recording. `push` and `context` are maps keyed
by device and by person, and on a shared gateway the legacy key holds everybody's rows mixed
together. Copying them would put one phone in two people's sections, and a notifier that reads both
sends to that phone twice. A registration not carried across is one connect away from being written
again — the app re-registers this device every time it starts — and a notification delivered twice is
not recoverable at all, so the direction to fail in is not a close call.

A person who arrives **after** the copy starts from the app's defaults, never from whoever got to the
gateway first.

### What this costs

- **One more round trip's worth of ordering.** The key cannot be named until the identity is known,
  so the reconcile now waits for `/api/auth/me` rather than racing it. A reconcile that ran first
  would find no section, paint the defaults, and only then learn there was an arrangement to load.
- **A gateway whose identity call fails loses app-wide sync**, where before it would have shared the
  anonymous one. That is a narrower behaviour on purpose; see above.
- **Anything outside the app that reads `hermie-app` has to learn the new shape.** In this repo that
  is `packages/hermie-web`'s push watcher, which now pools the registrations of every
  `hermie-app:*` key — deduplicated by installation id, newest row winning — and falls back to the
  bare key only while nobody has one of their own. The gateway-side `hermie` plugin reads
  `hermie-app:<user_id>` first and `hermie-app` second, for one version, and says so with the
  capability string `ui_meta.per_user`.
- **The push half waits to be told, and only the push half.** The arrangement moves to the
  per-person key the moment this app ships, because nothing but this app reads it. The
  registrations do not: one written where the notifier is not looking is a phone that has silently
  stopped buzzing, and nobody discovers that except by not being woken up. So on a gateway whose
  advert lacks `ui_meta.per_user`, the app writes the arrangement to `hermie-app:<user_id>` and the
  registrations to the bare `hermie-app`, as a read-modify-write that changes nothing else in it.
  Both keys go out in one `profiles.configure`, whose sections are independent.
- **The per-key compare-and-swap now guards more keys.** Two people writing at once contend on
  nothing, which is a straight improvement; the cost is that a profile's `ui_meta` grows a key per
  person who has ever used the gateway.

### What is verified

`packages/gateway-client/src/ui-meta.test.ts`, over a real socket against the fake gateway: that two
people on one gateway do not see each other's theme or order, that a token gateway writes under
`owner`, that a second device of the same person reads the same arrangement, that a reader with no
identity writes no app section while its bot sections still sync, that the anonymous section is
inherited once and only once, that `push` and `context` are left behind by the copy, that a person
arriving afterwards starts from the defaults, and that the anonymous section itself is left exactly
as it was. `packages/hermie-web/src/push/roster.test.ts` pins the pooling, including that a device
named under two keys is notified once.

## Amendment (2026-09-22): `pinned`, and the rule about not bumping `v`

Round R4b adds `pinned: string[]` to the app-wide section, beside `entries`, `folders` and `mutes`.
It is additive and the section version stays at 1.

That is now the second time a round's brief has asked for "a schema bump with tolerance" on this
section and been declined, so the reason is worth stating here as a **rule** rather than as an
exception in two places:

> **Adding a field to the app-wide section never bumps `v`.** `readSection` answers `null` for any
> section whose `v` is GREATER than the version the reader knows. A build that meets an unknown `v`
> therefore treats the whole section as unreadable and re-seeds it from its own local copy. Bumping
> does not protect the new field from older builds — it hands every older build the power to DELETE
> the order, the folders and the mutes, for everyone, the first time one of them writes.
>
> An additive field costs an older build only that field, on its own next write, which is the same
> last-writer-wins trade this ADR already made for the order.

A bump would only ever be right for a change that makes the section's EXISTING keys mean something
different — at which point being re-seeded is the correct outcome rather than data loss.

`folders`, `botNameOrder`, `textSize`, `push.perBot` and now `pinned` all follow this rule.
`expo/hermie/__tests__/pinned-chats.test.ts` asserts the version is still 1, so the decision has to
be taken again deliberately rather than by accident.

## Amendment (2026-09-22): the same key, read through a service

[ADR-0025](0025-hermie-web-is-a-service-layer.md) turned Hermie Web from a proxy into a process that
holds state on behalf of readers it has no user database for. That raises a question this record did
not have to answer before: **when several people use one Hermie Web, whose settings does it carry?**

### What was checked, and what it found

The answer is "each person's own, and the service does nothing to make that true", which is the
right answer but worth stating rather than assuming:

- **The key is named by the browser, not by the service.** The app reads `/api/auth/me` through the
  proxy with its own cookie, gets its own `user_id` back, and writes `hermie-app:<user_id>`. Two
  tabs signed in as two people name two keys without Hermie Web knowing either of them.
- **`profiles.configure` is carried, never rewritten.** The proxy pipes the request body and the
  WebSocket frames byte for byte; there is no code path that could merge, reorder or attribute a
  write. Per-key compare-and-swap therefore behaves through the proxy exactly as it does on a
  socket to the gateway.
- **The per-BOT key `hermie` is still shared**, and that is unchanged and correct: `archived` and
  `colour` describe the bot.
- **The service's own caches are per gateway** and hold nothing of anybody's settings. The identity
  memo (`identity.ts`) is keyed by the whole cookie and lives fifteen seconds.

**One thing was found, and it was introduced by the same round.** [ADR-0007](0007-canonical-bot-chats-only.md)'s
amendment gives each person a private conversation on each bot. ADR-0025 wrote that message-cache
entries are "per gateway, not per user, and that is written down rather than hidden", on the grounds
that the only conversation a bot had was one ADR-0007 already made shared. That reasoning expired the
moment a second kind of conversation existed: a private transcript read through the proxy landed in a
cache any other signed-in reader could ask for by session id.

So **cache entries now carry an owner**. The service link's own writes are the canonical Bot Chats
and stay shared; a proxied transcript read is stored under the reader the gateway names, and is
served back to that reader alone — as a miss rather than a refusal, because a refusal also confirms
that the conversation exists. A private entry is never aliased by the bot's name, because
`/hermie/cache/<bot>` means "this bot's shared chat".

The cost is the honest one: **without `--push` there is no service link, so Hermie Web cannot tell a
shared chat from a private one and keys every proxied capture to its reader.** A second person's
first open of a shared chat is then cold, which is where it was before ADR-0025. An ungated gateway
has nobody to name and its entries stay shared, which is the only behaviour a gateway with no
accounts can have.

### What is verified

`packages/hermie-web/src/users/isolation.test.ts`, over real sockets through the real proxy with two
cookie sessions belonging to two accounts: that each is answered with their own identity, that their
app-wide sections land in separate keys and neither write touches the other's, that one reader's
revision moves while the other's stands still, that the per-bot section is still shared, and that a
private chat cached from one reader's transcript read comes back to them and is a miss for the other.
`packages/hermie-web/src/cache.test.ts` pins the ownership rules themselves, including that a
canonical chat stays shared however many people read it and that an owner survives a restart.
`packages/hermie-web/src/identity.test.ts` pins the ladder and the memo.

The fake gateway's `/api/auth/me` answered a fixed tester until this round; it now answers the
caller, which is what upstream does and what makes any of the above mean anything.

## Amendment (2026-09-22): "last writer wins" needs a definition of last

### What was reported

Two things, on the same day, and one cause under both:

- "I set my theme to Graphite on macOS. The moment I open another device, it resets the theme to
  whatever was active on that device."
- "Folders do not seem to be synced between my devices."

Neither was a second device merely showing the wrong thing. The second device then wrote its own
copy home, so the choice was gone from the gateway as well and the device it had been made on lost
it on its next reconnect. A theme and an afternoon of folders, deleted by opening a phone.

### What was actually wrong

This record decided **last writer wins, per section, guarded by the revision**, and that is still
the right rule. What was missing is that "last" was being read as _whichever device flushed last_,
and a device flushes the app-wide section for several reasons that are nobody choosing anything:

1. **Its own rows in the section moved.** `push` and `context` are maps keyed by installation and
   by person and they are written on every connect. The section they live in is the same one that
   holds the theme and the folders.
2. **A disk read landed late.** The stores are read from disk in one effect and the socket comes up
   in another. The gateway's copy went into the stores and the device's own landed on top of it a
   moment later — and `store/ui-meta-bridge.ts` is a DIFF over the local stores, so it read that as
   a change somebody had just made.
3. **The live roster was folded into the list.** `useChatLayoutStore.reconcile(botNames)` puts a new
   bot at the end and drops one that is gone. On a second device it runs against whatever list that
   device is holding — nothing at all, on a first sign-in — and it runs before the gateway's copy has
   been read, because the roster arrives on the same connection and does not wait for it.

In all three cases `withPendingKept` took the local section as "the newest by definition", handed it
to the stores over the top of the gateway's, and then flushed it.

### What is decided

**The app-wide section carries `updatedAt`: when the person last CHOSE any of it, in seconds.** It is
additive and the section version stays at 1, by the rule this record already states for `pinned`.

- **Newer wins. A tie goes to the gateway**, so that one of two devices stops.
- **Undated on both sides keeps the local copy**, which is the behaviour before the field existed
  and the one a change made on a plane needs.
- **A dated section beats an undated one.** Only the dated one can say when anybody chose it.
- **A gateway with no section at all still takes this device's**, which is `seedWhatTheGatewayLacks`
  and is older than the dates.
- **A local section dated later than the gateway's IS an unsent change**, whatever the process
  remembers. The dirty bit lives with a socket; a change made offline and then followed by a
  relaunch used to arrive with nothing marked and was quietly replaced.

**The date moves for choices only.** It is taken in the bridge's own diff — one place, every field,
nothing to forget when the next field is added — over the section MINUS `push`, `context` and the
date itself. And the chat list's own housekeeping — the roster's fold, and the sweep of mutes that
have already lapsed — is COUNTED (`chores`) rather than dated: both are still persisted and still
sent, because a bot that has appeared belongs in the list and the section should not collect last
spring's deadlines, but neither claims that anybody arranged anything.

**Nothing is watched or compared until the disk has answered.** `UiMetaBridgeOptions.ready` holds
both the subscription and the reconcile behind this gateway's reads, so the baseline the diff works
from is what the device HOLDS rather than the app's defaults.

**A section that arrives is now written to disk.** `applyAppSettings` used to be deliberately silent,
on the grounds that persisting would write the arriving value back where it came from. It would not:
that is the local store, and the bridge is deaf while a copy goes in. What the silence actually cost
was the next launch, which read the theme the person had replaced.

### What this costs

- **Two devices whose clocks disagree resolve by the clock, not by the truth.** The guard is that a
  date is never allowed to be older than the one the device already holds, so a choice made here is
  always newer than the copy it replaces — but a phone an hour ahead does win an argument it might
  not deserve. A tie going to the gateway keeps that from becoming a loop.
- **One more field in a section every build reads.** A build that predates it writes the section
  undated, and then loses to any dated one. That is the intended direction: the build that can say
  when something was chosen is the one to believe.
- **The fold's own addition can be dropped once.** A new bot folded into a stale list on a second
  device is not re-folded into the arrangement that then arrives, so its position waits for the next
  roster change. Losing one row's place for one connect is a great deal better than losing the
  folders.

### What is verified

`packages/gateway-client/src/ui-meta.test.ts`, over a real socket against the fake gateway: the later
choice winning in both connect orders, a tie going to the gateway, an undated local change still
kept, a dated section beating an undated one, and a gateway with no section still being seeded.
`expo/hermie/__tests__/app-settings-sync.test.ts` and `expo/hermie/__tests__/arrangement-sync.test.ts`
drive the real stores against a gateway that remembers: the theme and the folders arriving on a
second device in both connect orders, neither device writing back over the other, the date adopted
rather than re-taken, an offline change landing on the next connect, a relaunch reading the arriving
copy rather than the replaced one, and the list's housekeeping being sent without being dated.

## Amendment (2026-09-22): `labels`, the name the reader gave a bot

Round R25a made the editable name on a bot's sheet the APP's own name for it, because no call a
client has writes a profile's `display_name` — `profiles.configure` has no such field,
`profiles.create` has none, and `PATCH /api/profiles/{name}` renames the profile instead. Round R29
syncs it: `labels: Record<string, string>`, keyed by handle, in the **app-wide** section.

The app-wide one and not the bot's own, although a bot's name looks like the most per-bot thing
there could be. Two reasons, and the first is the decisive one:

- **It is the READER's name, not the profile's.** The gateway's own display name is untouched and
  unwritable; this is what one person calls a bot. `hermie-app:<user_id>` is per person by
  construction, and the per-bot `hermie` key is shared by everybody on the gateway — two colleagues
  do not have to agree on what a bot is called, for the same reason they do not share a bedtime.
- **The date already lives there.** A name is a choice, so it has to be dated to win against an
  older copy, and `updatedAt` dates the app-wide section. Putting a choice in a section with no date
  would mean a rename made offline lost to whatever the gateway happened to be holding.

Additive, and the section version stays at 1, by the rule this record states for `pinned`. The key
is **always written, empty included**: absent means "this build knows nothing about names", and an
emptied field has to be able to say the other thing, or a name taken back on one device stands for
ever on the next. The per-bot section is unchanged and still carries `archived` and `colour` alone.

`expo/hermie/__tests__/bot-name-sync.test.ts` drives it on two devices against the gateway that
remembers: a rename arriving on the second device, one made with no socket landing on the next
connect, an emptied field clearing the name on a device that still had it, and a rename being dated
as a choice while the roster's fold beside it is not.

## Amendment (2026-09-22): `current`, the conversation each bot is on

The sub-chats round replaces the two-position "Shared Bot Chat / My chat" switch with a list per
bot: the group chat (the canonical `Bot Chat`) and any number of the reader's own chats. What the
switch recorded as `myChats: string[]` becomes a map in the **app-wide** section:

```json
{ "current": { "researcher": "<stored session id>" }, "myChats": ["researcher"] }
```

- **`current: Record<bot, storedId>`** names the reader's own chat a bot is on. A bot with no entry is
  on its group chat. Ids, not titles: the title family (`Chat · <lead>[ · <label>]`) is how the chats
  are LISTED, the stored id is how one is remembered and addressed.
- **`myChats` is kept and still written**, as the projection "every bot with a `current` entry". It
  is all an older build reads, and it tells that build to open its own chat (the bare-lead one) rather
  than the shared one. A bot `myChats` names and `current` does not is a **legacy entry**: the
  bare-lead chat, found by title, never minted, until something resolves it to an id.
- Not `myChats` spelt `bot#id`. That list is a list of bot NAMES to every build that reads it, and
  overloading it would have handed older builds names of bots that do not exist.

**Additive, and `v` stays at 1**, by the rule this record states for `pinned`.
`current` is **always written, `{}` included**: moving the last bot back to its group chat is
removing an entry, and an omitted key would read as "this build knows nothing about it".

**Absent is not empty.** A section without `current` — every section an older build writes — leaves
the device's map exactly as it was; the device re-imposes the projection on whatever `myChats`
arrived, so a bot it holds an id for is not reported to older builds as back on its group chat. The
cost is the one this record already accepts for every additive field: an older build's switch back
to "shared" does not reach a newer device that has an id for that bot.

**A pick is a choice, and it is dated.** `current` sits among the section's choices, so the bridge's
diff moves `updatedAt` when the reader picks a conversation, and the device where somebody last
picked is the one every other device follows. Two things are not choices and are sent undated, as
the roster's fold is: forgetting an id the gateway no longer lists, and resolving a legacy entry to
the id it names (`setCurrent(bot, id, { chore: true })`). Re-picking the conversation a bot is
already on changes nothing and dates nothing.

**Following happens on the next open, never under a live chat.** The section arrives on reconnect
and replaces the stored map at once; the chat controller (built after the stores) applies it only to
bots whose chat is not open on that device, so an open chat stays where it is until the reader leaves
it or picks a row.
Two devices open on the same bot can therefore show different conversations until one of them
leaves — accepted, and the owner's decision.

**What stays on the device.** The conversation column's Hide/Show (`conversationsCollapsed`) is
local like `sidebarCollapsed`. So are the per-conversation read watermarks (`lastSeen` keyed
`bot#<storedId>`, `seenCounts`) and the last-opened time the own-chat list sorts by: they are this
device's reading and this device's habit, and a list reordering on a phone because a desktop was used
is a list moving under somebody's thumb.

`expo/hermie/__tests__/current-conversation-sync.test.ts` drives it on two devices against the
gateway that remembers: a pick arriving on the next open, the later pick winning in both connect
orders, an offline pick landing on the next connect, a move back to the group chat carried as `{}`,
the date moving for a pick and not for the fold, a stale-id correction or a re-pick, `myChats` still
projecting the parked bots, a section without `current` leaving the map alone, a legacy-only section
yielding an empty map and a readable legacy set, and the column choice never leaving the device.
`app-settings-sync.test.ts` asserts the section is still at version 1.
