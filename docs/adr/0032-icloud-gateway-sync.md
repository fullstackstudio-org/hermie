# 0032. Gateways follow the Apple Account through iCloud Keychain

- Status: Accepted
- Date: 2026-10-02
- Amends: [0024](0024-a-list-of-gateways.md)
- Touches: [0021](0021-header-based-front-doors.md), [0028](0028-native-apps-on-apple-platforms.md)

## Context

[ADR-0024](0024-a-list-of-gateways.md) made the gateway list per device and never synced. Someone who
uses Hermie on an iPhone, an iPad and a Mac under one Apple Account therefore sets every gateway up
three times, and types a session token or a Cloudflare Access pair three times. The native apps
([ADR-0028](0028-native-apps-on-apple-platforms.md)) are the place to fix that, and the owner asked
for it.

What has to stay true while doing it: the device-only keychain items the Expo app reads stay exactly
as they are, so installing the Expo build over a native one keeps working; the app lock stays a
fact about each device; push registrations stay per installation; nothing of the person's goes to a
server of ours; and no third-party code.

Three facts about the gateways decide what can travel. A session token is one process-wide secret,
the same for every client of that gateway. A Cloudflare Access service token is a static pair by
design. A refresh token from an identity provider is not safe to copy: the gateway holds no token
state and hands rotation to the provider, and a provider that rotates refresh tokens with reuse
detection revokes the whole session when a second device replays the token the first one already
spent. The app cannot tell which kind of provider it is talking to.

Mechanisms considered:

1. **iCloud Keychain, synchronizable generic-password items.** No new entitlement (the keychain
   access group is already declared), no iCloud container, end-to-end encrypted, and a store the
   person already understands. It sends no change notice, so the app has to look when it has a
   reason to, and it cannot tell whether iCloud Keychain is switched on.
2. **`NSUbiquitousKeyValueStore`.** Rejected: it needs the iCloud capability and new provisioning,
   Apple holds the keys under standard data protection, so gateway addresses would be readable by
   Apple, and the secrets would still need the keychain, which makes two stores to keep in step.
3. **A CloudKit private database.** Rejected: a container, a schema to deploy, account-status
   handling and push subscriptions, for fewer than sixty-four small records.

And for the identity-provider sign-ins: sync the refresh token as it is (rejected: the rotation
fact above), special-case the provider name that does not rotate (rejected: it is a name, not a
guarantee), or a device-to-device handoff (rejected: without a fresh interactive login the gateway
cannot mint a second grant, so a handoff could only copy the same token).

## Decision

### What travels, and what never does

Each gateway is one synchronizable item in iCloud Keychain, in the existing access group, service
`hermie.sync.v1`, accessible after first unlock. It holds:

- the gateway's address, name, how it signs in (and the provider's name and label), the user id on
  it as a hint, and when it was first added;
- the credentials that are the same on every device: the session token, the Cloudflare Access pair
  and the custom headers, each stored together with the origin it was entered for.

Never in it: identity-provider and password sign-ins (access and refresh tokens, token metadata),
the app lock, messages, drafts, transcripts and caches, push registrations and the installation id,
the share-sheet delivery record, which gateway is live on a device, and anything about appearance or
voice. A device that takes an identity-provider gateway from iCloud shows it with "Sign in needed",
and the person signs in on that device; each device then holds its own grant.

The privacy statement says the same in the person's words; it is in `SECURITY.md` and the app's
privacy page, verbatim:

> If "Sync with iCloud Keychain" is on, Hermie stores your list of gateways (name, address, how you
> sign in, and your user id on that gateway) and the credentials that are the same on every device
> (a session token, a Cloudflare Access service token, custom headers) in your iCloud Keychain.
> iCloud Keychain is end-to-end encrypted: Apple cannot read it and neither can we, and it reaches
> only devices signed in to your Apple Account that you have approved. Sign-ins through an identity
> provider or a password stay on the device that made them. Messages, drafts, the app lock and
> notification registrations are never stored there. Nothing is sent to us. If iCloud Keychain is
> off, the same data stays on the device.

### Two sets, one bridge

The device-only items that every part of the app (and the Expo build, and the extensions) reads are
unchanged: not synchronizable, this device only. The synced set lives beside them under its own
service and is read by one actor only, `GatewaySyncEngine`. It copies a shareable credential between
the two sets in the direction the merge decides. The extensions do not link it. Runtime code never
reads the synced set, so a value from iCloud reaches a connection only after the engine has checked
it.

### Identity is the gateway key

The item for a gateway is addressed by the gateway key of its origin, the same FNV-1a hash the
deep links already use. Two devices that configured the same gateway by hand meet in one item with
no matching step. The local id stays random and per device. When one device holds two entries at one
origin (ADR-0024's two-accounts case), the oldest is the synced one and the other stays on that
device. A record whose address does not hash to its own key, and one whose address names another
origin than the local gateway, are left alone: FNV-1a is not collision resistant.

### The merge

Every synced field is a register: a value, a hybrid timestamp in milliseconds and a device tag; the
greater stamp wins, ties go to the device tag. A local write is stamped with the later of the
device's clock and one above the highest stamp it has seen in that record, so a device with a slow
clock still wins with its newest edit, and one with a fast clock never outranks a later edit made
elsewhere.
The keychain's own conflict handling, where one whole item wins, is only the transport: each device
merges what it reads field by field with what it last knew and writes the item back when the merged
form differs. The form is canonical JSON, so writing it back is idempotent.

"Remove from All Devices" writes a tombstone. It loses only to an address register written after
it, which is the gateway being added again; a rename made elsewhere at the same time does not bring
it back. A device remembers a tombstone for three years of its own time, so a stale copy that turns
up later is cut again, and while a tombstone is young it writes it back if a concurrent whole-item
write lost it. Tombstones are pruned once their stamp is 180 days old and the device first saw them
180 days ago, both by its own clock.

Absence never deletes anything. A gateway whose item disappears stays on the device, marked as no
longer in iCloud, and is not published again by itself. Credentials follow the same rule: one that
is missing on a device is put back from iCloud, and only a clear the person asked for ("Sign Out on
All Devices", removing a front door or headers) goes out as cleared.

When a device meets a record for a gateway it already had (two devices set up by hand before sync),
the record wins for the name, the provider, the user hint and the auth kind, and the local value wins
for the three credentials, which are then published.

### Intents

Everything the person does that the merge must hear of is an intent on the engine, and nothing else
writes the gateway list or a gateway's credentials: add, adopt, remove from this device or from all
devices, sign out (here, or the session token on all devices), clear a credential, change the auth
kind, change the address, "Sync this gateway", "Sync with iCloud", the disclosure, "Sync Again" and
"Delete Everything from iCloud Keychain". Each intent is committed to the sync state before its
destructive step, so a crash in between leaves something the next reconcile finishes, never an
intent lost. A test scans the sources for any other path that writes the list or a credential.

### When it runs, and the order it applies a plan

A reconcile runs at launch (after the gateway list is read, never blocking the first frame), when a
scene becomes active (at most every thirty seconds), a second after a local change to a synced
field, when Settings → Gateways is opened, and on "Sync Now". There is no timer and no background
task. One reconcile runs at a time; triggers that arrive meanwhile join the next.

It reads everything first (the gateway list, every gateway's configuration, the device-only
credentials, the synced items) and stops if any read fails, because a partial read would look like
a deletion. The merge is one pure function of that snapshot. A plan is applied in this order, each
step safe to repeat:

1. the session layer is told which gateways are about to be purged;
2. one SQLite transaction checks that the sync state and every field the plan changes are still
   what the snapshot read, then writes the gateway list, the configurations, a provisional sync
   state that marks every credential write as pending, and a journal of the gateways whose
   device-only items must go;
3. the device-only credentials, each only if it still holds what the snapshot read;
4. the writes and deletes in iCloud Keychain; one that fails is left for the next reconcile, whose
   merge puts the register back;
5. the final sync state, if nothing was recorded since the provisional one.

An intent that arrives while a reconcile runs makes it throw its plan away and start again.

### A credential goes only to the origin it was entered for

Every shared credential carries its origin, and the engine writes it to the device-only set only
when that origin is the gateway's. The Cloudflare Access pair is never written for a plain-http
gateway ([ADR-0021](0021-header-based-front-doors.md)). Changing an address within its origin is a
field edit. Changing it to another origin is a removal of the old key everywhere and a new gateway
under the new key: the credentials of the old origin are deleted on this device (the binding is
recorded before they go, so a crash in between cannot hand them to the new origin) and are never
carried over.

### One switch, on by default, answered once

"Sync with iCloud" is on by default. Before the engine writes anything to iCloud Keychain on a
device, the person sees one sheet that lists what would be stored and what never is, says where it
lives, and offers "Sync with iCloud" or "Keep on This Device". It appears once per device, when there
is something to store (a gateway on the device) and iCloud Keychain can be used. "Keep on This
Device" turns sync off; turning it on later in Settings asks the same question first. Until it is
answered, the engine writes nothing to iCloud. The launch does not read it either; setup does, just
before its first step, and lists what it found under "Available from iCloud" with the same words
about what is stored and where. "Use These Gateways" there is the answer: it takes them all, and a
gateway whose sign-in cannot travel continues with the sign-in step. When the store cannot be used
(an unsigned build, no keychain access group) the sheet is not shown and Settings says so.

Settings → Gateways → iCloud Sync has the switch, where sync stands and when it last finished, one
row per gateway with "Sync this gateway", "Sync Now", "Sync Again" for a gateway no longer in iCloud,
and "Delete Everything from iCloud Keychain". Turning the switch off asks whether to also remove this
device's gateways from iCloud ("stop syncing" for each); other devices keep their copies either way.
Removing a synced gateway asks "from This Device" (it stays in iCloud and on the other devices, and
is hidden here) or "from All Devices" (a tombstone); either way the sign-in is handed back to the
gateway first, as for any removal. Gateways in iCloud that were removed from this device are offered
back under "Available from iCloud"; one that needs a sign-in opens the same sign-in sheet as
Settings, and a finished sign-in clears its "Sign in needed".

## Consequences

- **Setting up a second device is one tap** for session-token gateways and a sign-in for the others.
  The privacy promise changes: someone who holds the person's iCloud Keychain now holds every
  session token in it, which is full access to that gateway, and a gateway runs agents that execute
  commands. The disclosure says this is what is stored, and "Sync this gateway" is the per-gateway
  way out.
- **Nothing is pushed, so nothing is instant.** A change reaches another device when that device has
  a reason to look and iCloud has delivered the item; how long that takes is Apple's.
- **The app cannot tell whether iCloud Keychain is on.** With it off, the items are stored on the
  device and do not travel, with no error. Settings says Hermie cannot see this.
- **ADR-0024's "never synced" no longer holds for the list.** The local id, the namespacing of
  everything on disk and the per-device live gateway are unchanged.
- **An identity-provider sign-in is per device**, until a gateway can hand out a shared, revocable
  handle that does not rotate; that is a change on the gateway and is not decided here.

### Known limits

These follow from a store with no notifications, no transactions and no global clock. Each is
covered by a test that pins the behaviour, and the confirmations in Settings say the ones a person
can run into.

- **"Delete Everything" is told only from an empty store.** A device learns that everything was
  deleted by reading no Hermie item at all after it had read one of its gateways' items. So:
  - "Stop syncing" of the only item in the store reads, on every device that had read it, exactly as
    "Delete Everything": their gateways go device-only and they are told, until "Sync Again".
  - A device whose gateways it never read back, and that had read no item, publishes them again
    after a real "Delete Everything"; it cannot tell that from its own first write being lost.
  - Losing this device's own copy of the synced set (a backup restored before iCloud Keychain caught
    up, signing out of the Apple Account with "delete from this device", iCloud Keychain turned off
    and on) reads as "Delete Everything": the gateways go device-only and re-attach by themselves
    when their items come back, except those added here and not yet read back, which stay
    device-only until "Sync Again".
  - It is not a barrier while the deletions spread: a device that reads a half-deleted store and
    writes one gateway (a rename, a token edit, putting back a register it misses, a young tombstone
    written back) brings that gateway back, and the other devices attach to it again.
- **Clocks, both ways.** "Added after the removal" compares this device's clock with the remover's
  when this device had not yet seen the removal. With the remover's clock far behind, a gateway
  added before the removal (with sync off here) still counts as newer and is published over it.
  With the remover's clock far ahead, and the tombstone first seen in the same reconcile as the add
  (a new device or a reinstall, the store unavailable during its first reconcile), a gateway added
  after the removal counts as older: it stays on this device only, and the person is told, until
  the tombstone is pruned. A move recorded before this build (with no move time) counts as an add
  as of the reconcile that sees it.
- **Switching a gateway on again, or "Sync Again".** When the store already shows this device's own
  address register for that gateway, it is published without a fresh address stamp (a fresh one
  would climb a millisecond per switch-on past a removal stamped just above it by a slow clock). A
  device that switched it off after reading that register, and whose delete was lost or undone by a
  stale write from a third device, deletes that publish again.
- **A credential write left pending by a crash.** If its register then vanished from the store (a
  stale whole-item write) while no device still holds its value, it stays unresolved on that device:
  its local value is neither published (it may be one this device only received) nor cleared
  (nobody asked to), until the record has a value for that field again. The same holds after the
  device lost its print key.
- **A device that has only unread entries.** Until a device has read back an item of its own, an
  item it cannot find is "not yet there" rather than "gone", so it publishes; see the second point
  under "Delete Everything".
- **A device offline for more than 180 days** may come back after a tombstone was pruned; it keeps
  the gateway, device-only.

## What is verified, and what is not

Verified in the package's tests, against in-memory stores and a fake iCloud with several devices
and delivery the test controls: the conflict table, first attach, tombstones and their memory,
limits, a convergence property test over random edits and delivery orders on three devices, every
intent, a crash after every step of applying a plan and inside every intent, that no captured log
holds a credential, the settings model against two engines, and the shell's disclosure and Settings
pages in UI tests on throwaway simulators (which use the in-memory stores, never iCloud Keychain).

Not yet seen:

- **Two real devices on one Apple Account.** Nothing here has travelled through iCloud Keychain.
  That items travel at all from this app's access group, how long delivery takes, the behaviour with
  iCloud Keychain switched off, and that the iOS and macOS builds of one team share the group are
  the two-device script's to show, and it has not been run.
- **The Mac's data-protection keychain** with a signed build. Unsigned builds and `swift test` report
  the store unavailable, which is tested; a signed Mac build syncing is not.
- **Sign-in for a gateway taken from iCloud** against a real identity provider. The UI tests reach
  the sign-in sheet; completing a provider's sign-in there is the sign-in flow's own tests' and the
  two-device script's.
