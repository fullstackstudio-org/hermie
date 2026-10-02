# 0017. Push notifications come from Hermie Web, and a device registers itself in `ui_meta`

- Status: Accepted, amended 2026-09-21 (push comes from the `hermie` gateway plugin; Hermie Web's `--push` is the fallback; the heartbeat names the chat and a mute is obeyed); partly superseded 2026-10-03 by [0030](0030-web-client-served-by-the-plugin.md) (the `--push` fallback is retired in that record's staged removal and the plugin's key becomes the only VAPID key; the registration, heartbeat, payload and validation rules stand)
- Date: 2026-09-21
- Builds on: [0015](0015-web-variant-on-its-own-port.md), [0016](0016-ui-meta-sync.md)

## Context

Hermie is a messenger whose correspondents work while nobody is looking. A bot answers a question
twenty minutes after it was asked, a cron job delivers a report at 07:00, a teammate's bot sends a
DM, and an agent stops mid-task to ask whether it may run `rm -rf ./build`. Today every one of those
is invisible until the app is opened, which is the one property a messenger cannot have.

### What the phone can and cannot do

An app that is not running has no socket. iOS suspends it within seconds of backgrounding and
Android's Doze does the equivalent; `attachLifecycle` already tears the gateway connection down
because holding it would be a lie. This is not a limitation to be engineered around — it is the
platform contract, and the whole reason the push transports exist.

So something that is always running has to be watching, and it has to be something the owner already
runs.

### What the gateway does not have

`hermes serve` has no push machinery of its own and no notion of a device. It also has no way to say
who is watching a session:

- **There is no client-presence list.** `session.active_list` returns one row per LIVE session in the
  gateway PROCESS, with a `current` flag that means "this is the CALLING connection's session" and
  nothing about anybody else's. Two clients resumed on the same session are one row.
- **Two clients on one session do not fight.** `session.reclaimed` is broadcast only for
  `idle_timeout`, `lru_evict` and `ws_orphan_reap` — the backend taking a session back — and never
  because a second client resumed it. Upstream's reaper comments describe a session's transport as a
  fan-out of peers, dead "exactly when no peer of its own is alive". A watcher and an app can hold
  the same Bot Chat at once.
- **A watched session is a pinned session.** `_session_is_lru_evictable` refuses to evict a session
  whose transport is alive, and the TTL reaper applies the same exemption. A process that resumes
  every Bot Chat and stays connected therefore keeps every Bot Chat resident for as long as it runs.
  That is a real cost and it is paid knowingly; see Consequences.

### The pieces that already exist

[ADR-0015](0015-web-variant-on-its-own-port.md) put a small Node server next to the gateway:
`packages/hermie-web`, zero runtime dependencies, inside the perimeter rather than on it, already
holding a proxied connection to exactly one gateway and already shipped as a release artefact with a
Docker image and a systemd unit. It is the only always-on thing this project owns.

[ADR-0016](0016-ui-meta-sync.md) established that a profile's `ui_meta` is a per-key
compare-and-swap that Hermie may write under keys it owns, that the app-wide key `hermie-app` lives
on the default profile, and — proved against `hermes serve` 0.21.3 — that a write leaves neighbouring
keys alone and a `null` removes a key. That is a small, ordered, authenticated key-value store that
both a device and a daemon can reach through the connection each already has.

### Options considered

1. **A hosted push service of ours.** Every device's token and every bot's name on somebody else's
   server, an account system, and a permanent operational obligation for a self-hosted product whose
   whole pitch is that the conversation stays with the owner's gateway. Rejected.
2. **Upstream grows push.** Hermie's release cadence becomes upstream's problem and Hermie's device
   tokens become upstream's liability, for a feature only this client wants.
   [ADR-0006](0006-single-gateway-no-relay.md)'s spirit is that Hermie does not ask upstream for
   anything it can do itself. Rejected.
3. **A background task in the app.** iOS background fetch has no schedule anybody can rely on and
   Android's equivalent is killed by every aggressive OEM battery manager. It would work on a test
   device and fail silently on the owner's. Rejected.
4. **A watcher inside Hermie Web.** It is already next to the gateway, already a released artefact,
   already the thing a self-hoster installs. Chosen.

## Decision

**Hermie Web gains a `--push` mode: one service connection to the gateway, watching every Bot Chat,
sending notifications to devices that registered themselves in `ui_meta`.**

### The daemon

`hermie-web --push` holds **one** WebSocket to its single configured gateway and resumes every bot's
canonical Bot Chat, exactly as the app resolves one ([ADR-0007](0007-canonical-bot-chats-only.md)).
It is a reader: it never submits a prompt, answers a question, or changes a setting.

It notifies on four things, and on nothing else:

- a **new bot message** in a chat no client is attached to;
- an **approval or clarify request** opening;
- a **bot-to-bot DM** arriving;
- a **cron delivery or cron error**.

Its credential is whatever the gateway takes. On an ungated gateway that is the session token it
already holds. On an OIDC-gated one it is a refresh token obtained once through the same native PKCE
flow the app uses, via a `hermie-web login` subcommand that prints the authorisation URL and listens
on the RFC 8252 loopback redirect ([ADR-0004](0004-native-pkce-via-webview.md)) — and if the
gateway's provider issues no refresh token, push is **not available** and the command says so rather
than storing an hour-long credential. That is the same condition the app now warns about at sign-in.

### Registration lives in `ui_meta`

A device that wants notifications writes its registration into its own per-user section on the
gateway. **The app never talks to the daemon.** There is no second address to configure, no second
thing to expose, and no endpoint for anything on the network to post to.

Under the `hermie-app` key on the default profile ([ADR-0016](0016-ui-meta-sync.md)), a new
`push.registrations` section, keyed by an installation id the device mints once:

```json
{
  "v": 1,
  "push": {
    "registrations": {
      "<installation-id>": {
        "v": 1,
        "transport": "expo" | "webpush",
        "token": "ExponentPushToken[…]",
        "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" },
        "platform": "ios" | "android" | "web",
        "types": { "message": true, "request": true, "dm": true, "cron": true },
        "preview": false,
        "updatedAt": 1789957143
      }
    },
    "seen": { "<installation-id>": 1789957143 }
  }
}
```

`token` is present for `expo`, `endpoint` + `keys` for `webpush`; never both. The section is rewritten
whole under the compare-and-swap ADR-0016 describes, and a sign-out or a change of gateway removes
this installation's entry — a registration is only meaningful for the gateway it was made on.

The daemon reads the registrations through its own gateway connection, sends Expo pushes through the
public Expo Push API (`https://exp.host/--/api/v2/push/send` — no secret, the token is the address)
and Web Push through VAPID keys it generates per installation on first run, signed with Node's own
`crypto`. Expo receipts are read back and a `DeviceNotRegistered` removes that registration.

### The payload says who, not what

**Bot name and event type only.** No message content, no snippet, no request text, unless the owner
turns `preview` on per device. A notification is delivered by Apple, Google and a browser vendor and
is rendered on a lock screen; the default is therefore the least a notification can say and still be
worth tapping.

### "Nobody is attached" is a heartbeat, not a protocol fact

The gateway cannot be asked who is watching. So the app writes `push.seen[<installation-id>]` while a
chat is on screen, and the daemon suppresses a message notification when any registration's `seen`
stamp is within the window. A short delay before sending absorbs the case where the app is opening.

This is a heuristic and it is written down as one: the failure mode is a redundant notification for a
chat somebody is already reading, which is the right direction to fail in. Requests, DMs and cron
deliveries are **not** suppressed — a question with a countdown on it is worth a buzz even if the
chat is open on a tablet in another room.

### An action is validated before it is answered

An approval notification carries Allow and Deny actions. Tapping one does **not** answer anything by
itself: the app opens, connects to the gateway, re-reads the open requests, and responds only if that
request is still open and still says what the notification said it did. A notification is a hint that
something happened, never an instruction — see the threat model.

### The daemon says it exists, and nothing more

`hermie-app.push.endpoint` in the app-wide `ui_meta` is **informational**: the daemon writes its own
version and a liveness stamp so Settings can say whether push is available and, when it is not, say
what is missing. The app never dials it.

## Threat model

**What is covered.**

- _Nothing on the network can make a device buzz._ There is no inbound endpoint. The only way into
  the path is a write to `ui_meta` on the gateway, which is authenticated by the gateway.
- _A stolen Expo token cannot read anything._ It is a send address. The worst it buys is noise, and
  the payload it can carry says nothing the holder did not already have to know to obtain it.
- _A spoofed push cannot act._ Every action is re-validated against the gateway's own open requests
  before a response is sent, so a forged "Allow `rm -rf /`" is a notification that opens an app which
  finds no such request and says so.
- _Content stays on the gateway by default._ With `preview` off, the push transports carry a bot
  name and a type. Turning it on is a decision the owner makes per device.

**What is not covered, and is accepted.**

- _The daemon's credential is a gateway credential._ It can read every transcript on that gateway,
  because that is what watching them requires. Anyone who can read the daemon's state file has that
  access. It is the same trust level as the gateway's own host, which is where the daemon runs.
- _Traffic analysis._ Apple, Google and any browser push service learn that a device received a
  notification, when, and from which server. They cannot learn what it said; they can learn that
  something happened.
- _A compromised gateway._ It can already do everything. Push adds the ability to make a device buzz
  and to read the registrations, which is strictly less than it already has.
- _`ui_meta` is per profile, not per user._ Two people on one gateway share the `hermie-app` key, so
  each can see the other's registrations — the same regression ADR-0016 accepted knowingly, for the
  same reason: the gateway has no per-user scope. A registration holds a push token, a platform and a
  set of toggles; it holds no message content and no credential for anything but being sent to.
- _Push is only as reliable as the thing running it._ A daemon that is not running sends nothing, and
  nothing on the device will say so beyond the liveness stamp Settings reads. Notifications are best
  effort and the app never treats their absence as information.

## Consequences

**What this buys.** A messenger that behaves like one, on iOS, Android and the browser, with no
account, no hosted service, no inbound port, and one extra flag on a process the self-hoster already
installs.

**One more thing to run, and it holds sessions open.** A watcher that resumes every Bot Chat keeps
every Bot Chat on the gateway's live-session list, and upstream never evicts a session whose
transport is alive. On a gateway with `max_live_sessions` set, the daemon's resumed chats count
against that cap. That is the price of hearing about a message the moment it is written, and the
alternative — polling the REST transcript — trades it for latency and load. The daemon resumes
lazily and drops a chat it has not heard from in a long while, so the resident set follows the bots
that are actually in use.

**Two transports, two failure modes, one code path.** Expo handles APNs and FCM and gives receipts;
Web Push is VAPID and gives an HTTP status. Both reduce to "send, then decide whether this
registration is still real", which is the only part the watcher knows about.

**The app must cope with a notification for a chat that has moved on.** A tap can land on an answered
question, a deleted cron, a bot that no longer exists. Every entry point resolves against the gateway
before it shows anything, which is the same rule the widgets and the deep link already follow.

**Push and the browser build need the same origin.** A service worker and a `PushSubscription` need
https and a registered scope, so Web Push works only where Hermie Web is served over TLS — the same
condition ADR-0015 already puts on exposing it at all. Over plain http the browser build simply does
not offer it.

**An OIDC gateway whose provider issues no refresh token cannot run push.** The daemon would need an
interactive sign-in every hour. `hermie-web login` says so plainly and points at the same
`offline_access` scope the app's own sign-in warning names.

## Amendment, 2026-09-21: push comes from a Hermes plugin, and Hermie Web's `--push` becomes the fallback

### Why this changed

ADR-0017 chose Hermie Web because it was "the only always-on thing this project
owns". That was true of the things _we_ own. It was not true of the gateway,
which is always on by definition and which turns out to have a documented plugin
surface: hooks for the agent's lifecycle, a per-profile state store, a bounded
system-prompt contribution, and discovery through
`hermes plugins install <owner/repo> --enable`.

A plugin inside `hermes serve` removes, rather than adds:

- **No second process.** One thing to run instead of two.
- **No credential.** ADR-0017 accepted that "the daemon's credential is a gateway
  credential… anyone who can read the daemon's state file has that access". In
  process there is no such file, because there is nothing to authenticate to.
- **No pinned sessions.** The entire "one more thing to run, and it holds
  sessions open" consequence disappears. The daemon resumed every Bot Chat to
  watch it, and upstream never evicts a session whose transport is alive, so the
  resident set grew with the bot list. Hooks fire where the work already
  happens; nothing is resumed and nothing is held.
- **No OIDC problem.** ADR-0017's "an OIDC gateway whose provider issues no
  refresh token cannot run push" was a property of needing a long-lived
  credential. In process, that condition is gone entirely.

### What is decided

**Push is delivered by the `hermie` plugin, installed into the gateway with
`hermes plugins install fullstackstudio-org/hermie-plugin --enable`.**
`hermie-web --push` remains supported for a gateway where a plugin cannot be
installed, and the two must not both run: they would notify the same device
twice.

The registration schema, the `seen` heartbeat, the payload policy and the
validated-action rule are **unchanged**. A device that registered for the daemon
is registered for the plugin. The app needs no change to keep working.

### What this costs, and it is not nothing

**Two of the four event types cannot be produced by a plugin.**

- **Bot-to-bot DM.** Hermes fires no hook when one arrives (`tools/bot_mode_dm.py`
  has no fire site). The `dm` type stays in the schema — a device may still ask
  for it and the daemon may still send it — but the plugin does not advertise it
  and never sends one. This is a regression against ADR-0017 as written, and it
  is accepted because the alternative is keeping a second process alive for one
  event type. Closing it means a hook upstream.
- **Cron delivery.** There are no hook fire sites in `hermes_cli/cron.py`. A cron
  run is an ordinary agent session, so the turn hooks fire inside it, but nothing
  carries a job id. The plugin recognises a cron delivery from the session's
  platform string, which is a heuristic: when it misfires, the message is
  notified as a `message`, which it also is.

**The plugin runs with the gateway's own trust.** It is in-process. It can see
what the gateway sees. Read against ADR-0017's own accepted risk, this is a
reduction rather than an addition — the daemon needed a gateway credential on
disk to obtain the same access, and now nothing does.

### Two additions

**Two new types: `turn_done` and `turn_failed`.** `on_session_end` reports
whether a turn completed, failed, or was interrupted. A finished long task and a
turn that died are both worth a buzz, and an _interrupted_ turn is not — somebody
pressed stop, and they know. Both follow the existing rule that an absent type is
off, so no device that predates them starts receiving them.

**A capability advert, under a new `ui_meta` key.** ADR-0017 made
`hermie-app.push.endpoint` informational, written by the daemon. The plugin
writes a richer advert under its **own** key, `hermie-plugin`:

```json
{
  "v": 1,
  "version": "0.1.0",
  "capabilities": [
    "push.expo",
    "push.webpush",
    "push.preview",
    "push.type.turn_done",
    "push.type.turn_failed",
    "context.system_prompt"
  ],
  "modules": { "push": "on", "context": "on", "presence": "planned" },
  "updatedAt": 1790001453
}
```

Its own key, because `hermie-app` belongs to the app and carries a
compare-and-swap revision per ADR-0016; a write from the gateway side would make
the app's next write fail. Its own key is invisible to that revision.

The app reads capability **strings** and never compares version numbers, so an
older plugin simply offers less and a newer one adds strings an older app does
not ask for. An absent advert means an absent plugin, which means: do not offer
the feature. This is the mechanism that lets a gateway nobody ever updates keep
working with an app that keeps shipping.

### A second thing the plugin does

The same plugin injects **device context** — a person's name, device, timezone,
locale and their own free text — into a bot's system prompt, from a `context`
section the app writes beside the registrations under `hermie-app`. It is
rendered once per session and never appears in the transcript.

This belongs in the same plugin rather than a second one for the same reason the
modules exist at all: a person installs a plugin once. It is recorded here
because it puts something new into `hermie-app` and because it changes the
privacy picture — ADR-0017's accepted "`ui_meta` is per profile, not per user"
now covers a display name and free text somebody wrote about themselves, not just
a push token and a set of toggles. On a shared gateway that is a real difference,
and the app should say so where the field is filled in.

## Amendment, 2026-09-21: the heartbeat says which chat, and the key says whose

Two changes land together, because the app asks one advert about both.

**`push.seen[<installation-id>]` becomes `{"bot": "<name>", "at": <unix second>}`.** A bare stamp
said "this device is reading something". That suppressed a notification for the chat the reader had
open — the thing it was for — and, just as effectively, for every chat they did not. A phone with
the researcher's chat on screen was, as far as the notifier could tell, reading the whole roster.
The chat name is the whole of the fix, and it is gated on the capability string
`push.seen.per_chat`: a plugin that predates it reads a number and would treat an object as
unreadable, which is a device that appears to look away for ever and therefore a notification for
every chat it is actually reading. So the app writes the shape the gateway says it can read, and
reads both. A bare number comes back as an entry with no name, which is precisely as much as the
build that wrote it was able to say.

**The registrations move under the per-person key, when the gateway can find them there.** See
[ADR-0016's amendment](0016-ui-meta-sync.md): `ui_meta.per_user` gates the push half and nothing
else, and until it is advertised the registrations stay on the bare `hermie-app` while the rest of
the arrangement has already moved.

**A third string, `push.mute`, says a muted chat is not notified about.** Mute is stored in the
per-person section as `mutes: {"<bot>": <untilEpochSeconds>}` with `0` for forever and a second in
the past reading as unmuted; it silences every type for that person, requests and cron deliveries
included. That is a deliberate narrowing of this record's "requests, DMs and cron deliveries are
**not** suppressed": the heartbeat is a guess about whether somebody is looking, and a mute is a
decision they made. A guess should not silence a question with a countdown on it. A decision should.

### What is unchanged

Everything else in ADR-0017: the registration schema and its `v`, the app never
talking to the notifier, the payload saying who rather than what, `preview` being
per device, `seen` being a heartbeat rather than a protocol fact, requests and
cron deliveries never being suppressed, and every action being re-validated
against the gateway's own open requests before it is answered.

## Amendment, 2026-09-22: seven types, and `cron` becomes the coarse one

**The type list becomes seven.** `cron` was one switch doing two jobs: "the
routine reported" and "the run ended". They are not the same question, and the
person who wants the second rarely wants the first — a nightly digest whose
chatter is noise is precisely the routine whose _failure to run_ is worth
waking a phone for. Folding them together meant that silencing the chatter also
silenced the alarm, which is the wrong way round.

So `cron_done` and `cron_failed` join `message`, `request`, `cron`, `turn_done`
and `turn_failed`. The plugin already raises them (`on_session_end` inside a
cron run, and its `[CRON_FAILURE]` marker); what changes here is that the app
offers a switch for each, globally and per chat, and that the registration
written to `ui_meta` carries all seven.

**`cron` stays the coarse switch and keeps its old meaning.** A notification
raised by a scheduled run answers to the fine type AND to `cron`, so a
registration written before these types existed goes on being notified exactly
as it was. Adding a type must never be how somebody's phone goes quiet, and the
audience is therefore a union rather than a replacement — `registrationsForAny`
in Hermie Web's daemon, one notification per device however many of its switches
matched.

**A device that upgrades adopts a new type as ON; a type it had switched off
stays off.** ADR-0017's wire rule is that an absent type means off, and that is
still right for a REGISTRATION read off a gateway: a device that never named a
type cannot have agreed to it. It is the wrong rule for this device's own
stored preferences, where an absent key is not a refusal but a switch nobody
has been shown. The two rules are `pushTypesOf` and `adoptedPushTypes`, and the
difference between them is stated in both. The upgraded row reaches the
notifier on the address refresh the app already makes on every launch and every
foreground; nothing new has to be written.

## Amendment, 2026-09-22: a tap names its conversation

ADR-0017 was written when a bot had exactly one chat, so naming the bot named
the destination. Round R4b gave a bot branches and retired conversations, and a
turn can now happen in a session nobody is looking at.

**A payload carries `sessionId` and `sessionKind` (`canonical` | `branch` |
`other`), and a tap opens that conversation.** `branch` and `other` open the
non-canonical viewer; `canonical`, an absent kind, and a session id that is the
bot's own canonical one all open the chat, which is exactly what every
notification did before this. A payload that says nothing is therefore read the
way it always was.

The classification is the gateway's, from the session's title, and the app does
not re-derive it: an id it cannot place is not a reason to guess. Where the kind
is absent but the id is present, the app compares it against the canonical id it
already holds for that bot — and where it holds none, it opens the chat rather
than inventing a destination.

**A tap into a non-canonical conversation opens it and answers nothing.** This
is the same rule the cross-gateway tap already follows, for the same reason: an
Allow has to be re-validated against `approval.pending` for the session that
asked, and that session is not the one this connection resumed. The reader
lands on the request and answers it there, which is the direction this feature
is built to fail in.

## Amendment, 2026-09-22: a guessed cron is not a cron

ADR-0017's payload policy is that a notification says WHO and what KIND. The
kind is the part that can be wrong: Hermes fires no cron hook, so every notifier
recognises a scheduled run by a signal it chose, and the signals are not equally
good. Hermie Web's daemon matches one of two headers the scheduler writes, word
for word, and is therefore stating a fact. The plugin prefers `task_id` and
`HERMES_CRON_SESSION`, which are also facts, and falls back to the session's
`platform` string, which is free text.

**So the payload carries `cronCertain`, and a notification worded from a guess
does not claim a scheduled run.** `cron "Morning digest" failed` and `sent you a
message` are indistinguishable to the reader in the one way that matters — the
lock screen shows no workings — so the weaker sentence is the honest one, and it
is true either way: something arrived in that chat, which is what a tap shows.
An ABSENT `cronCertain` is read as certain, because that is every payload sent
before the field existed and is how they were already being read.

**`jobId` is carried and never printed.** It is an id. `cron "8f3a-77" failed`
has told the reader less than `a cron run failed` would, so the NAME goes in the
sentence and where there is no name the general line is used. Resolving an id to
a name is the app's to do — `cronJobFor` / `cronJobName` in `features/cron` —
and it answers nothing, rather than the id, before the crons list has been read.

### What is unchanged

The registration schema and its `v`, the app never talking to the notifier, the
payload saying who rather than what, `preview` being per device, `seen` being a
heartbeat rather than a protocol fact, and every action being re-validated
against the gateway's own open requests before it is answered.
