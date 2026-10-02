# 0019. The chat list groups into folders, and a bot is in exactly one

- Status: Accepted
- Date: 2026-09-21
- Amends: [0012](0012-local-chat-list-layout.md), [0016](0016-ui-meta-sync.md)

## Context

[ADR-0012](0012-local-chat-list-layout.md) gave the chat list named **dividers**, and it chose their
shape deliberately:

> Dividers and chats live in ONE array rather than in a tree of sections, which is what makes "move
> this bot into that section" a swap of two adjacent positions instead of a graft between two
> containers.

That was the right shape for a heading. It is the wrong one for what people actually wanted, and the
gap shows up in three places at once:

- **A divider has no inside.** There is nothing to close, so a list of forty chats under six
  headings is still a list of forty chats. The whole point of grouping is to be able to stop looking
  at a group.
- **A closed group has to be accounted for.** The moment something can be hidden, the thing hiding
  it has to say what is in there — an unread total, a question waiting — or hiding it means missing
  things.
- **There is nowhere to drop a row onto.** A heading is a line between two rows, so "put this in
  Finance" could only ever be expressed as "put this after the Finance line", which is the same
  gesture as "put this before the first chat under Finance" and reads as neither.

The one-flat-array trick also stopped paying for itself. Stepping past a heading changed a bot's
section for free, which was elegant — and it meant `moveBy(bot, 1)` on the last chat of a group
silently moved it into the next one. With a heading that is arguably a reordering. With a container
it is a mistake.

## Decision

**The chat list groups into folders. A bot is in exactly one folder, or in none.**

### The shape

Two lists that mean one thing, in `expo/hermie/src/store/folders.ts`:

```ts
entries: ({ kind: 'folder'; id: string } | { kind: 'chat'; name: string })[]
folders: { id: string; name: string; colour?: AccentName; bots: string[] }[]
```

`entries` is the **top level** in order — folders and loose chats interleaved — and a folder appears
in it by id only. `folders` carries each one's name, colour and contents. Two lists rather than a
tree because the top-level order and a folder's contents are two independent edits: dragging a
folder past a chat touches `entries` alone, and dragging a chat within a folder touches `folders`
alone.

**The invariant is enforced, not assumed.** `normalise` runs on every read and every write: a bot
appears at most once (the first position winning, so a bot that is both loose and in a folder stays
where the reader can see it), a folder id appears at most once, a folder named in `entries` with no
definition is dropped, and a folder defined but never placed is appended rather than lost. Two
copies of one row is a list in which every drag is ambiguous, and the data comes off a disk and a
gateway this build does not control.

### Where a drop lands

A position is no longer a single index. It is a **container and an index inside it**, because "third
from the top" and "third inside Finance" are different places the same number would name. So
`drag-order.ts` was split: it keeps the geometry — which gap the finger is over, which way the other
rows move, how far — and `features/bots/folder-rows.ts` owns what each gap MEANS.

Two anchors are not rows anybody drags, and both exist for a reason a divider never had:

- **`folderIn:<id>`** is the bottom half of a folder's own header and means "inside this folder,
  first". It is what makes _drop onto the folder_ a real gesture, and it is the only way into a
  **collapsed** folder, which by definition has no children to drop between.
- **`folderEmpty:<id>`** is the placeholder row an open, empty folder draws, so a folder somebody has
  just emptied is not a one-way trip.

Anchors are derived from the **arrangement**, never from the rendered rows. The rendered list has
rows that stand for no position (a folder header stands for two) and hides rows that still have one
(a collapsed folder's children), and an archived chat keeps its place in the arrangement while being
drawn in the drawer — so counting visible rows would slide every drop below it by one.

### What is synced and what is not

`entries` and `folders` ride in the per-person `ui_meta` section
([ADR-0016's amendment](0016-ui-meta-sync.md)) with the order, the theme and the mutes. **Which
folders are open does not.** That is about the window in front of somebody — a Mac with everything
folded away must not fold a phone's list, and the phone has the room to keep them open — so it lives
on the device beside `sidebarCollapsed`, exactly where ADR-0012 put that.

### The migration, and why the section version does NOT move

Every divider becomes a folder holding the chats below it up to the next divider. Chats above the
first divider stay loose. That is the only reading that preserves what the reader was looking at: a
heading's rows ARE its rows, and they stop where the next heading starts. It runs in one place,
`readArrangement`, which both the disk read and the gateway read go through.

`folders` is an **additive field and `v` stays at 1**, which is a deliberate departure from the
obvious move. Bumping it would make an older build read the whole app-wide section as unreadable —
and a section an older build cannot read is one it **re-seeds from its own local copy**, because
`seedWhatTheGatewayLacks` treats an absent section as "nobody has decided anything yet". So a bump
would not protect the folders from a two-month-old phone. It would hand that phone the power to
delete them, along with the theme, the mutes and the push registrations sharing the key. An older
build that simply does not mention `folders` costs the reader their folders on its own next write,
which is the same last-writer-wins trade ADR-0016 already made for the order.

### What the folder row does

Name, an optional colour on its chevron, and — **only while it is closed** — an aggregate unread
count and a needs-input dot. Open, every row inside is on screen carrying its own count, and a total
above them would be the same information twice.

The two numbers treat mute **differently**, and the difference is the point.

The unread count includes muted chats. Closing a folder hides rows that were each carrying their own
badge, so a count that skipped the muted ones would make collapsing a folder _delete_ information —
four messages visible while the folder is open and nothing at all while it is shut. Mute is about not
being interrupted, and a badge on a list somebody opened on purpose is not an interruption; it is the
same call `BotRow` already makes when it draws the bell and the unread pill side by side.

The needs-input dot excludes them ([ADR-0017's amendment](0017-push-through-hermie-web.md)). That dot
is a summons — a bot is blocked and stays blocked until this reader answers — and summoning somebody
to a conversation they silenced is exactly what mute is for.

Archived chats are excluded from both, for the reason they always were.

_Corrected 2026-09-22._ This paragraph previously said a muted chat contributes nothing to either
number, and `folder-rows.ts` implemented that for both. The owner's rule is the split above.

Its menu is New folder, Rename, Colour, Mute folder and Delete. **Mute fans out** — a folder has no
mute of its own, it applies the chosen span to every chat inside at once. A mute stored on the folder
would be a second place a chat can be silent from, and a chat dragged out of a muted folder would
then carry a silence nobody could see or lift.

**Delete keeps the chats**, and returns them to the top level _at the folder's own position_, in
their own order. Deleting a container should not also be a reordering: the reader can still see where
the group was.

"Archived" stays exactly what it was — a special group with its own header and its own rules, not a
folder. It is not in the arrangement, it cannot be dropped into, and archiving still takes a chat out
of every count.

## Consequences

- **`moveBy` no longer crosses a group.** Up and down mean the next row _inside the same container_.
  Changing folders now says which folder out loud — the drag, the row menu, or `moveToFolder`. This
  is a deliberate loss of ADR-0012's elegance and it removes a class of accident the flat array made
  free.
- **The rendered list and the arrangement have genuinely diverged**, where before one was a filter of
  the other. That is the cost of collapsing, and it is paid once, in `folder-rows.ts`, rather than at
  every call site.
- **Two lists can disagree**, which is why `normalise` is not optional and why it runs on the way in
  as well as on the way out.
- **A folder's open state is per device and is therefore not backed up.** Reinstalling opens
  everything. That is the right failure: the alternative is a phone that arrives with six groups
  already folded away because a Mac folded them.
- **The `dividers` name is gone from the strings and from the UI.** A build that still writes
  `divider` entries into the section will be migrated by the next reader that opens it, and its own
  next write will drop the folders — see above.

## Amendment (R4): the drag is keyed by ROW, and a folder is a row

The original build made folders reorderable by a menu and by two accessibility actions, and
draggable not at all: `use-row-drag.ts` took a **bot name** everywhere — `arm(name)`,
`rowHandlers(name)`, `onCommit(name, target)` — and rebuilt the lifted anchor as `` `bot:${name}` ``
in two places. This file has described the list in row **keys** since the day it was written, so the
one kind of row the hook could not speak the key of was the one kind it could not pick up: the
lookup for a folder's own anchor could only ever miss, which put the lift's origin at anchor 0 and
moved every neighbour the wrong way.

The hook now takes and reports keys and nothing else. It does not know what a bot is and it does not
know what a folder is; `onCommit` hands the key back and the screen decides what it means. That is
what let the folder row get the identical lift, shadow, neighbour shift and settle rather than a
second implementation of the gesture standing beside the first — including the z-order fix, which
belongs to `DragCell` and reads `liftedKey`.

One rule is added, and it is the only thing about a folder drag that is not a chat drag:

- **A folder only ever lands at the top level, because folders do not nest.** An arrangement is a
  top level and a set of folders holding chat names, so a drop target inside some other folder has
  no meaning for a folder. `topLevelIndexOf` turns it into the position that folder occupies, which
  is what "drop it next to that one" means and the only reading a reader can predict. Dropping a
  **chat** onto a folder's row still puts it inside — that anchor (`folderIn:<id>`) is unchanged.

## What is verified

`expo/hermie/__tests__/folders.test.ts` covers the invariant (a duplicate bot, one bot named by two
folders, a folder nobody placed, an id nothing defines, and the invariant holding across a run of
moves), the migration (each divider's own chats, the chats above the first one, a folder stopping
where the next divider starts, the reading order preserved, and a blob written by something else
entirely), moving between containers, deleting a folder at its own position, folding the roster in,
the aggregate counts with mute and archive applied, the rows a list draws open and closed, every drop
target including the collapsed-folder case and the archived-chat offset, and the commit arithmetic
end to end.

`expo/hermie/__tests__/drag-reorder.test.ts` keeps the geometry half: midpoints, ragged rows, the
synthetic half-row over a folder header, and how far the neighbours move.
`expo/hermie/__tests__/chat-layout-store.test.ts` covers what the store adds — the disk keyed by
gateway, and the open/closed set surviving a reload and being forgotten with the folder.
`expo/hermie/__tests__/bots-screen.test.tsx` drives the screen: adding a folder, naming it, the empty
folder's own row, a search narrowing past it, and moving a bot in from the row menu.

`expo/hermie/__tests__/folder-drag.test.tsx` covers the amendment: what a row key parses to and
which anchors are positions rather than rows, a folder target inside another folder becoming that
folder's own top-level place, the no-move and index-correction arithmetic for a folder, the grip and
the pan handlers appearing on the folder row in edit mode, and a committed drop moving the folder
among the top-level rows.

**Not verified by a test:** the gesture itself. A `PanResponder` needs a touch and the boxes it reads
come from a real layout pass, so the drag is exercised as arithmetic and confirmed by hand.

## Amendment (2026-09-22): pinned chats, and the band a drag may not leave

A chat can be pinned. A pinned chat sorts to the top of whatever container holds it — its folder, or
the top level — and the rule is one line: **a stable partition, pinned first.** Nothing is reordered
within either half, so pinning three chats brings them up in the order they already had, and
unpinning one drops it back into the gap it left.

**It is a display sort and never a move.** `Arrangement` is untouched by a pin. That is the whole
reason it is a separate key rather than `moveBotTo(0)`: a pin that moved the row would have nowhere
to put it back, and "unpin" would mean "leave it wherever the top of the list has drifted to".

**At the top level a pinned chat rises above the FOLDERS too.** "First within the top level" is what
was asked for, and a band that stopped at the first folder would not be the top of anything a reader
can see. A folder has no pinned-ness of its own and is never pinned.

### The drag now reads the displayed order

This is the part that had to be got right, and it is the part round four's handover warned about.

An anchor pairs a row's place ON SCREEN with the arrangement position a drop on it commits to, and
pinning makes those two orders different. So `dragAnchors` **walks the displayed sequence** — the
geometry is measured down the screen, and anchors in a different order from the rows would put every
drop line where the finger is not — while each anchor's `target` stays an index into the **untouched
arrangement**, which is the space `moveBotTo` and `moveFolderTo` read.

**The clamp, stated as a rule:** a pinned row may only be dropped among the pinned rows, and an
unpinned row only among the unpinned ones. It is applied to the SLOT, before the slot becomes a drop
line — so what the reader watches and what they get are the same answer. A clamp on the commit alone
would draw a line somewhere the row then refused to go, and because the sort re-runs on every
arrangement change, a pinned row "dropped" below the band would spring back to the top and the
gesture would look undone.

Three details the rule needs:

- a row dragged past the boundary **rests at the boundary** rather than snapping to the far end of
  its band, for the reason `nextFocus` clamps rather than wrapping;
- a folder is clamped to the unpinned band, which is "pinned chats sort first" seen from the
  dragging end;
- `folderIn:` and `folderEmpty:` mean "the top of that folder" and are legal for **either** band, so
  pinning has made no chat undraggable into a folder — **but only when the reader aimed at one.**
  Without that second half, a pinned row dragged to the bottom of the list walked back up looking
  for somewhere legal, met a folder's header first, and was filed inside the folder. Landing a chat
  somewhere nobody pointed is worse than the thing the clamp exists to prevent, and a test now
  covers it.

### Where a pin is stored, and why the version is not bumped

In the arrangement slice of the app-wide `ui_meta` section (ADR-0016), beside the order and the
folders, as `pinned: string[]` — a decision about where the reader keeps a chat, which is what that
whole section is about.

**The section version is deliberately NOT bumped**, which is the second time that instruction has
been declined for this section. `readSection` answers `null` for any section whose `v` is greater
than the reader's own, and a build that meets one re-seeds the whole app-wide section from its local
copy. Bumping to 2 would therefore not protect `pinned` from an older build — it would hand every
older build the power to delete the folders, the order and the mutes, for everyone, the first time
one of them wrote. The field is additive, in exactly the shape `folders`, `botNameOrder` and
`textSize` already use; a build that has not learned it leaves this reader's pins alone until it
writes the section itself, which costs the pins and nothing else.

### What is verified

`expo/hermie/__tests__/pinned-chats.test.ts`: the partition at the top level and inside a folder,
that pinning reorders nothing within either half, that unpinning restores the list exactly, that the
anchors are emitted in display order while their targets stay arrangement indices, every case of the
clamp including the folder-filing regression above, the disk round trip, and the `ui_meta`
projection — including that the version is still 1, that the key is sent even when empty, and that
an absent key leaves local pins alone.

**Not verified:** the gesture itself, for the reason this ADR already gives.
