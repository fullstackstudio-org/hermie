# 0007. Only canonical Bot Chats

- Status: Accepted
- Date: 2026-09-19

## Context

A Hermes gateway stores every session that was ever started from the CLI, the desktop app, cron
jobs and messaging platforms. Hermes Desktop offers all of them in a sidebar, plus a "Bot Mode"
where each profile (bot) has one persistent conversation, the session titled exactly `Bot Chat`.
That title is the only identity of the canonical chat; the gateway reports it as
`canonical_session` on `profiles.list` and creates it hidden when it is missing.

Hermie's purpose is chatting with bots, not administering sessions.

## Decision

Hermie shows **one conversation per bot: the canonical Bot Chat**. There is no session browser, no
side chats and no session creation from the app. When a profile has no canonical session yet, Hermie
looks it up by title (`session.list` with `title: 'Bot Chat'` and `include_hidden: true`) and only
then creates it, exactly as Hermes Desktop does, so a chat is never forked by accident.

Cron runs are the one exception: a routine's run history opens its run sessions read-only.

## Consequences

- The home screen is a list of bots, which maps directly onto a messaging-app conversations list.
- Everything the app persists is keyed by the profile name and the durable session id, never by the
  runtime session id.
- The same chat is shared with Hermes Desktop and the CLI when they point at the same gateway.

## Amendment (2026-09-22): branches and past conversations, beside the canonical chat

Round R4b added three things that all touch this decision, so it is worth saying precisely which
part of it moved and which part did not.

**What has not moved: a bot is still reached by exactly one chat.** The canonical `Bot Chat` is
still the hidden session resolved by title, still the only one the roster points at, still the only
one with a composer, and still the only one a notification, a widget, a deep link or a DM card can
land in. Nothing in this round creates a second place to talk to a bot.

**What has moved: the app now admits that the one chat has neighbours, and shows them.** It always
did — `/new` has been retiring conversations under `Bot Chat · <date time>` since it was written,
and those rows were simply invisible to this app. Now:

- **`session.branch`** forks the canonical chat at one message into an ordinary VISIBLE session of
  the same profile, titled `Branch · <first words>`. It is not canonical, it is not hidden, and the
  canonical chat is untouched by construction rather than by care.
- **A Conversations page** lists the profile's sessions from `session.list` (with `include_hidden`,
  because the canonical one is hidden by definition), grouped into the current Bot Chat, the
  branches and the past conversations.
- **A non-canonical session can be opened read-only**, under a banner naming it and offering the way
  back. There is no composer on it, and that is this ADR's decision still being enforced: a second
  composer is exactly how an app grows a second chat per bot. To carry on inside a branch, the
  reader makes it the Bot Chat — a swap, which keeps the invariant rather than suspending it.

**The one-canonical rule is now a TYPE rather than a check.** `features/sessions/session-model.ts`
gives every listed conversation a `kind`, and `conversationActions` answers an EMPTY action list for
the canonical row. Delete, Rename and "Make this the Bot Chat" are unreachable for it because there
is no branch of code in which they are offered, not because each surface remembers to ask. The
controller's `deleteConversation` deliberately does NOT repeat the check, so that nobody reads the
surfaces as being allowed to be careless.

**Where the grouping comes from, and its known limit.** `SessionListRow` carries no parent and no
kind — `session.create` takes a `parent_session_id` and upstream keeps it, but the listing never
reads it back — so the groups are derived from the TITLE prefixes this app itself writes. A
conversation renamed out of its prefix stops being grouped as a branch and becomes an ordinary past
conversation. It is still listed, still openable, still named what the reader called it. The
alternative was a parentage table in `ui_meta` that would go stale against any other client on the
same gateway; a grouping that can be wrong in a way the reader can see and fix beats a shadow index
that is wrong silently.

### What is verified

`expo/hermie/__tests__/session-branch.test.ts`: the branch title, that branching leaves the
canonical chat's session, rows and flags alone, that a branch opens under a key of its own without
clearing the bot's unread watermark, and that the canonical row is offered no actions while every
other row is offered four. `expo/hermie/__tests__/conversations-page.test.ts`: which id each of
`session.title`, `session.delete` and `session.resume` is addressed by, and both rollback paths of
the canonical swap. `packages/fake-gateway/src/upstream-shapes.test.ts` holds the fake's
`session.branch` and `session.delete` to the contract — including that the fake invents no canonical
guard upstream does not document, because the guard is this app's.

**Not verified:** anything against a real gateway. See the round's section in
`docs/platform-notes.md`, in particular the reading of `session.branch`'s `count`.

## Amendment (2026-09-22): a chat of one's own, beside the shared one

### What this closes

This record's consequence list ends on a fact it accepted without comment:

> The same chat is shared with Hermes Desktop and the CLI when they point at the
> same gateway.

Shared with other CLIENTS was the point. Shared with other PEOPLE was the same
sentence read a second way, and on a gateway two colleagues sign in to it is the
only reading that matters: one transcript, two people typing into it, and a bot
whose memory belongs to neither of them. [ADR-0025](0025-hermie-web-is-a-service-layer.md)
named per-user chats as a later part of its direction and said they would be off
by default. They are: nothing below happens unless a reader asks for it.

### What is decided

**A bot has one SHARED chat and, per person, at most one private one.**

- The shared chat is unchanged in every respect. It is still the hidden session
  titled exactly `Bot Chat`, still the only one the roster points at by default,
  still the one a DM, a cron delivery or another client lands in.
- The private chat is a **visible** session on the same profile, titled exactly
  `Chat · <display name, else user id>`, created with `parent_session_id` set to
  the canonical chat and `follow_profile_config: true`.

**The title is the identity, exactly as `Bot Chat` is.** It is resolved by
`session.list {profile, title, include_hidden: true}`, twice, before anything is
created — the same three steps and the same fail-closed rule the canonical
resolution has, for the same reason: a lookup that errored is not a person
without a chat, and minting on that answer splits a conversation in two.

**Session titles are taken to be unique per PROFILE**, which is the only reading
under which this record's own canonical chat can exist on every bot. It is an
inference rather than a probe; `docs/platform-notes.md` carries it as the
round's open question.

**Without an identity there is no private chat and no switch.** A session-token
gateway with an owner id gets one under `Chat · owner`; one that names nobody is
left exactly where this record left it, with no new surface at all. That is the
rule [ADR-0016](0016-ui-meta-sync.md)'s amendment already follows for the
app-wide settings key.

**One chat per bot is still what the app SHOWS.** The switch chooses which of
the two a bot's row opens; it does not put two rows in the list, two composers on
a screen or two unread counts on a badge. The store key stays the bot's name and
only the session under it changes, so the composer, the approvals, the unread
watermark, the widget and every notification route go on meaning what they meant.

**The private chat may be opened and nothing else.** `conversationActions`
answers `['open']` for it — not renamed, because its title is how every device
this person signs in on finds it again; not adopted as the Bot Chat, because that
would hand everybody on the gateway a transcript that was private a second ago;
not deleted, because there is no undo and `/new` inside the chat retires rather
than destroys.

### What it costs

- **A second registry lookup per chosen bot, per connection.** Who the reader is
  and which bots they chose both arrive after the first roster read, so the
  roster is re-pointed once both are in rather than by re-reading `profiles.list`.
- **The transcript cache on disk is keyed by bot**, so switching forgets it —
  the same thing "Make this the Bot Chat" already does, and for the same reason.
- **Another client sees the private chat in its session list**, named after the
  person. That is not a leak this app can close: the gateway has no per-user
  scope and the title is the only key there is. It is why the chat is named
  rather than opaque — a row somebody can read and delete beats one they cannot
  explain.

### What is verified

`expo/hermie/__tests__/user-chats.test.ts`: the title ladder and the empty answer
that turns the feature off; that the lookup runs twice before a create and that
the create is visible, follows the profile and names its parent; that a failed
lookup mints nothing; that concurrent asks resolve once; that a new identity
drops the memo; that the roster row is re-pointed so its preview and unread are
the reader's own; that a cold open resolves the private chat rather than
short-circuiting on the roster's shared one; that the switch moves the chat, the
roster and the disk cache together and puts the choice back when the gateway
refuses; and that the Conversations page gives it a group of its own, leaves the
canonical row canonical while the pin is on the private chat, and offers it
nothing but Open. `packages/fake-gateway/src/upstream-shapes.test.ts` pins the
per-profile title uniqueness this rests on.

**Not verified:** anything against a real gateway.
