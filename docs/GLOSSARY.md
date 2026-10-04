# Glossary

Hermes Agent reuses a handful of everyday words for very specific things, and two of them are called
"gateway". This page pins down the terms Hermie's code and documentation use, so that the same word
means the same thing everywhere.

## Gateway

The process started by `hermes serve`. It listens on port 9119 by default and exposes the WebSocket
endpoint `/api/ws` plus a REST surface on the same origin. This is what Hermie connects to, and when
this documentation says "the gateway" without qualification, this is what it means. Hermie talks to
exactly one at a time.

## Messaging gateway

A different thing with a confusingly similar name: the process started by `hermes gateway`. It runs
the scheduler that fires cron jobs and delivers messages to external channels. `hermes serve` does
not run it, which matters operationally — a machine that only runs `serve` will accept and list cron
jobs but never execute them. Hermie reads the `gateway_running` flag from the cron API and shows a
banner when it is false.

## Hermie Web

The process started by `npx @hermie/web` (`packages/hermie-web`): one small Node server, next to the
gateway and on its own port — 9120 by default — that serves Hermie's browser build and proxies
**one** gateway onto its own origin. It is not a third kind of gateway and it authenticates nobody;
it exists because the gateway's browser session is an `HttpOnly` cookie, a cookie belongs to an
origin, and the gateway refuses a WebSocket whose `Origin` is not its own. Being same-origin is what
lets a page use that session honestly. The gateway it points at is fixed when the process starts.
[docs/web.md](web.md) is the design and [ADR-0015](adr/0015-web-variant-on-its-own-port.md) the
decision.

## Designed for iPad

How Hermie runs on a Mac: Apple offers an unmodified iPhone/iPad app on Apple Silicon Macs from the
same App Store listing, and that is the Mac version — not a port, not a separate target, and not a
Catalyst build. There is no macOS project in this repository; `npm run mac` builds the iOS scheme for
the `platform=macOS,variant=Designed for iPad` destination and wraps the product so macOS will launch
it. The one place the code knows the difference is `isiOSAppOnMac`, read through a local Expo module,
because `Platform.isMacCatalyst` is compile-time and false here.
[ADR-0011](adr/0011-mac-via-the-ipad-build.md) records what the native macOS target cost and why it
was dropped.

## Application identifier

`dev.hermie.app` — `ios.bundleIdentifier` and `android.package` in `expo/hermie/app.config.ts`, and
the keychain access group that follows from it. One string for both platforms, so there is one place
to get it wrong instead of two. It is the container as far as the operating system is concerned: a
build made under the previous identifier is a different app to the system and has to be signed in
again once.

## Bot

A Hermes **profile**, seen from the user's side. A profile carries its own system prompt, model
settings, tools and memory, and Hermie presents each one as a contact you chat with. Profiles are
identified by name; the marker `ui_meta: {hermes-bots: {}}` in a profile's configuration is what
makes it show up as a bot rather than as a bare profile.

## Bot Chat

The one canonical conversation per bot. It is an ordinary Hermes session whose title is exactly
`Bot Chat`, usually hidden from the session list. Hermie never creates a second conversation with a
bot: one bot, one thread, the way a messaging app works. The session is found through
`profiles.list` (which returns it as `canonical_session`), falling back to a title search and finally
to creating it.

## Runtime session id, stored session id, resolved id

Three identifiers for what feels like one conversation, and mixing them up is the classic source of
"my messages went to the wrong chat".

- The **runtime `session_id`** is what the gateway uses for the live session right now. It changes
  when a session is reclaimed, restarted or forked. It is never persisted.
- The **stored session id** is the durable identifier of the conversation as it was created. This is
  what Hermie writes to its cache and what it resumes on.
- The **`resolved_id`** is the root of the lineage: the id the REST endpoints use to address the
  conversation's message rows, which may differ from the stored id after a fork or a rewind.

The rule: persist the durable id, resume on it, and address REST rows by `resolved_id`.

## Ticket

A single-use, short-lived credential for opening a WebSocket. A gated gateway does not accept a
bearer token on the socket, so the client first calls `POST /api/auth/ws-ticket` over HTTP and then
dials with the ticket in a subprotocol. Tickets live about thirty seconds and are consumed by the
dial: every reconnect mints a fresh one. Reusing a ticket is a bug, not an optimisation.

## Dial plan

Everything one WebSocket dial needs, minted immediately before it: the URL, the subprotocols and any
extra headers. It exists as its own thing because a ticket is single-use and short-lived, so the
credentials for a socket cannot be computed once and reused. The socket factory is _armed_ with a
plan, consumes it when the socket is built, and refuses to dial without one — which turns ticket
reuse into an error at the call site instead of a puzzling 4401.

## Session token

The credential for an **ungated** gateway — one with authentication disabled. It is a long-lived
shared secret sent as the `X-Hermes-Session-Token` header on REST calls and as a query parameter on
the WebSocket. It is unrelated to the PKCE tokens and does not expire on its own. The browser client
reads it from the dashboard's own bootstrap (`window.__HERMES_SESSION_TOKEN__` in the gateway's
`index.html`), so there it is exactly as public as the dashboard on that gateway, and keeps it in
memory only ([`native/web/README.md`](../native/web/README.md), "Gateways without sign-in").

## Native PKCE

The sign-in flow Hermie uses on a gated gateway: the OAuth authorisation code flow with PKCE, with a
loopback redirect URI. The gateway exposes it at `/auth/native/authorize` and
`/auth/native/token`, and advertises it as `native_pkce` in `GET /api/status`. Hermie opens the
authorisation page in an in-app web view and intercepts the loopback redirect before it is loaded —
nothing actually listens on that port. Password-based providers run through the same flow and end at
the same redirect, so there is one code path rather than two.

## Loopback redirect

The address the native PKCE flow ends on: `http://127.0.0.1:38007/callback?code=…&state=…`. Nothing
listens on it. It is a value the sign-in web view reads out of a navigation it then refuses to
perform, not a request anything serves. The gateway only accepts loopback **IP literals** here —
`localhost` is rejected, because a public route that honoured an arbitrary host would be an open
redirect leaking a live authorisation code.

## Extra headers

Request headers the operator configures during setup, sent with every REST call, every WebSocket
dial and the sign-in page's initial request. They exist for an access proxy in front of the gateway,
Cloudflare Access most commonly. Names must be valid HTTP tokens, CR and LF are stripped from values
so a pasted secret cannot smuggle a second header in behind it, and the headers the transport owns
(`Authorization`, `Host`, `X-Hermes-Session-Token`, …) cannot be overridden. They are stored in the
secret store rather than with the rest of the gateway configuration, because they usually are one.

## Connection test

The step in setup that has to pass before anything is written to disk: one authenticated REST call,
then a full WebSocket dial through to `gateway.ready` and a `profiles.list`, then a disconnect. Its
result is tied to a **payload key** — a fingerprint of the address, the extra headers, the
authentication mode, the provider and the credential — so that changing any of them invalidates the
result instead of leaving a stale "it worked" on screen.

## Fake gateway

The stand-in for `hermes serve` in `packages/fake-gateway`, used by the tests and by anyone
developing without a real agent. It answers the public status endpoints, both authentication flows,
the native PKCE round trip and the JSON-RPC surface, and exposes hooks a real gateway has no business
having: forcing a close code, dropping a socket without a close frame, or refusing the next upgrade.
It is a test double, not a second implementation — where behaviour matters, it follows the upstream
source.

## Turn

One round of the conversation: everything from the moment a prompt is submitted until the assistant's
message completes. A turn carries the assistant's text, its reasoning, the tool calls it made and any
questions it asked. Hermie's transcript state tracks at most one active turn per chat.

## Interim message

A partial assistant message the gateway emits while the turn is still running — a draft that will be
replaced, not appended to. It has to be rendered as provisional and discarded when the real content
arrives, which is why it is a distinct event rather than another delta.

## Tool card

The transcript item representing one tool invocation: which tool, with what arguments, how long it
took, and what came back. It appears when the tool starts and is completed in place. How much of it
is shown — a one-line summary, the arguments, the full output and diff — is a display choice, not a
change to what was recorded.

## Subagent and delegation

A **subagent** is a child agent a bot spawns to do part of a task, running in its own session. A
**delegation** is the unit of work handed to it. Subagent activity arrives as its own event family
and is always delivered regardless of the verbosity the gateway is configured for, which is why
Hermie can show live delegation progress even on a quiet gateway.

## DM

A message one bot sends another with the `message_agent` tool. It is fire-and-forget: the call
returns a queued acknowledgement with a delivery identifier, and the reply arrives later as a
separate row that has to be joined back to the original by process identifier. In the receiving bot's
transcript the message appears as a user-role row prefixed with the sender's name.

## Verbosity level

Hermie's own display filter: **Quiet**, **Normal** or **Verbose**, chosen per chat. It decides what
of the recorded transcript is shown — Quiet hides tool activity behind a single working indicator,
Verbose expands everything including raw arguments and output. It is a client-side selector over
data that was already received.

## `display.tool_progress`

The gateway-side setting that decides what is _sent_ in the first place: `off`, `new`, `all` or
`verbose`. Only `verbose` includes raw tool arguments and results. It is global — shared with the
desktop app and the terminal interface — so Hermie never changes it silently; it shows what it is set
to and offers an explicit button that says what changing it will affect.

The distinction matters: Hermie's verbosity level cannot show what the gateway never sent.

## Foreign turn

A turn that starts in a chat without Hermie having submitted it — because the same bot was prompted
from the desktop app, from the terminal, by a cron job, or by another bot. Hermie has no local record
of the user message that caused it, so it inserts a placeholder and reconciles the tail of the
transcript against the server instead of guessing.

## Live chat

A Bot Chat that Hermie has resumed and kept attached. Hermie does not detach when you leave the
screen: a bot only streams a teammate's message into a chat that is resumed, so closing on navigation
would turn bot-to-bot traffic into a list of messages you have to go looking for. A live chat keeps
receiving events, keeps its place in the runtime-id map, and is re-resumed after a reconnect.

## Item origin

Where a transcript item came from, and therefore what reconciliation may do to it: `history` for a
persisted row, `live` for something that arrived on the socket, `optimistic` for a message submitted
locally and not yet echoed back, `inflight` for the tail rebuilt from a resume snapshot, and
`foreign` for the placeholder standing in for a turn somebody else started. Only settled items reach
the chat cache — an unanswered question and an unechoed submit both describe a moment, not the
conversation.

## Chat cache

The on-device copy of the roster and of the last couple of hundred items per chat, in SQLite. It
exists so a chat is on screen before the gateway has answered: the cached items are painted first and
then reconciled against the live transcript, which keeps item identifiers stable instead of
remounting the thread under you. It is written when a turn completes, when a chat is left and when
the app goes to the background — never mid-stream.

## Approval queue

The gateway-side queue that owns an approval's lifetime: its timeout, its coalescing, and the fact
that answering one on any surface resolves it everywhere. Hermie acknowledges a card with
`approval.received` when it appears, which only marks it as seen, and answers the server request
itself when you choose. A card rebuilt after a reconnect has no request to answer, so that one goes
back as `approval.respond` against the queue entry's own identifier.

The answers are `once`, `session`, `always` and `deny` — the queue's own vocabulary, from
`tools/approval_prompt.py`. The sheet renders exactly the `choices` the request carried, in the
order it carried them, and never a choice the server did not offer.

## Sealed bubble

An assistant bubble the client closed mid-turn because something else had to be drawn after it — a
tool call, most often. The turn is still running; the bubble is simply no longer the one receiving
deltas.

It matters at the end of the turn. `message.complete` carries the turn's full reply, and with the
streaming bubble sealed there is nothing live for it to land on, so a naive client paints the same
words a second time under the tool card while the gateway stored a single row. Hermie settles the
completion onto the sealed bubble whenever the two texts are prefix-compatible in either direction —
streaming can drop characters and the final can add a trailing delta, but only one message can
satisfy that test, so no flag is needed to make it safe.

## Row identity

The number the gateway's store gave a persisted message (`messages.id`), carried as `row_id` on the
frames that finish a row (`message.interim`, `message.complete`, a tool's `tool.complete`) and on
history rows. A client that is told which row a live frame is about settles its bubble onto that
row instead of drawing a second one beside it. Hermie pairs by this id whenever the gateway sends
one and falls back to matching words only when it does not, which is what an older gateway gets. The
engine's name for it on an item is `rowId`; see `packages/transcript/README.md`.

## Call key

The client's key for one tool call: `"<call_row_id>/<call_index>"`, the assistant row that holds the
call and the call's position in that row's `tool_calls`. It is unique inside a session however a
provider numbers its `tool_id`, so a card is found by it first and the provider's `tool_id` stays as
the fallback for a gateway that sends no call identity. A tool card keeps it as `callKey`, and the
chat state indexes cards by it in `byCallKey`.

## Turn id

A random identifier the gateway mints once per turn and stamps on every frame of that turn's stream.
It is also written on the prompt's row (`display_metadata.turn_id`), so a prompt shown from history,
from an optimistic send or from a resume snapshot is recognised as the one that opened the running
turn, and no placeholder is stood up beside it. It carries no identity of its own and a client
cannot choose it.

## Replay epoch

An identifier the gateway sends on connect, marking the generation of its event log. It lets a
reconnecting client ask for everything it missed since the last sequence number it saw. If the epoch
has changed, or the gateway reports the replay as truncated, missed events cannot be replayed and the
client re-hydrates the conversation from scratch.

## Desktop contract

The gateway's protocol version for rich clients, reported as `desktop_contract`. Hermie requires
version 7 or newer and refuses to connect below it. Failing at the door with a clear message is
better than discovering halfway through a conversation that an event shape has changed.

## Routine

A scheduled prompt: the gateway calls it a cron job, Hermie calls it a routine. It carries a
schedule, the instructions to run, and a delivery target. Two things about it are easy to get
wrong. First, it is the **messaging gateway** (`hermes gateway`) that fires routines, not
`hermes serve`; a gateway process that is down leaves every routine looking healthy and firing
nothing, which is what `gateway_running` in the `cron.manage` answer reports and what the banner on
the Routines list says out loud. Second, a routine is described by the same job in two shapes: WS
`cron.manage` answers `_format_job` rows keyed `job_id` with a `prompt_preview`, and
`GET /api/cron/jobs/{id}` answers the stored job keyed `id` with the full `prompt`.

## Schedule string

The one field a routine's timing lives in. The gateway parses it (`cron/jobs.py::parse_schedule`)
and accepts an interval (`every 30m`), a weekday/time phrase (`every day at 9am`,
`every monday at 9am`, `weekdays at 9am`), a five- or six-field cron expression, a one-shot delay
(`in 2h`), or an ISO timestamp. Hermie's schedule builder emits only those forms, and never
computes when the routine will next fire: the parse happens in the gateway's timezone, so
`next_run_at` as the server returned it is the only trustworthy answer.

## Run

One execution of a routine. A run is an ordinary session whose id is `cron_{job_id}_{timestamp}`,
which is the whole binding between a job and its history — `GET /api/cron/jobs/{id}/runs` scans that
id range, and the transcript comes back from plain `session.history`. That is why a run renders
through the same engine as a conversation and why it has no composer: the session is finished and
there is no agent behind it to send anything to.

## Activity

The cross-bot timeline: every message one bot sent another, every reply that came back, and every
`delegate_task` fan-out, in one list. It exists because bot-to-bot traffic is invisible in any single
conversation — a delivery is written into the sender's transcript as a dispatch and into the
recipient's as an inbound message, and neither chat shows both halves.

Activity is a **view**, never a second store. Its rows are derived from the same `ChatState`s the
chat screens read, which is what lets a row open the conversation it came from and land on the exact
message rather than at the bottom of it. Bots nobody has opened are filled in by a background load:
the newest rows of each canonical chat, read through the same `rowsToItems` as everything else, so
opening that chat afterwards reconciles onto the items instead of duplicating them.

Because both halves of a delivery are on the wire, one delivery would otherwise appear twice. The
sender-side dispatch wins: it is the row that knows whether the message was queued, delivered or
failed. An inbound row is only shown when no dispatch matches it — which is exactly the case where
the sender's chat is not loaded.

The three counters above the list each come from a different call, and none of them is transcript
state: **bots working** from `session.active_list`, **sub-agents** from `delegation.status` per
profile, and **deliveries out** from `agents.list` filtered to the `bot_mode_dm.py --run-delivery`
runner. They are polled while the screen is on top and dropped when it is not.

## Delivery process

The background process a `message_agent` hand-off spawns to carry the message to the other bot. The
tool call itself returns `queued` with a `process_id` and nothing else — it is fire-and-forget — and
the teammate's reply arrives much later as a `process_complete` row that is joined back onto the
dispatch by that id. While it is out, the process is listed by `agents.list`, which is the only place
a client can count deliveries that have left but not landed.

## Subagent roster

`subagent.list`, the gateway's snapshot of the children that are live right now. It exists because
`subagent.*` events have no replay: a conversation opened halfway through a delegation never saw its
children start, and the stream alone would leave them invisible until the next one reported. Hermie
reads the roster when a chat opens and every five seconds while anything is delegating, and folds it
in without ever resurrecting a child the stream already saw finish.

It is a roster of LIVE children only. A child that has finished is dropped from it and lives on in
the transcript, which is why a reconcile must add and refresh but never remove.
