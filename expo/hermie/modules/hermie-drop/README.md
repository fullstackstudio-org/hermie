# hermie-drop

A view that accepts files dragged onto it, so the chat can take an attachment the way every desktop
messenger does.

| Export               | Kind     | Answers                                                       |
| -------------------- | -------- | ------------------------------------------------------------- |
| `HermieDropView`     | view     | Files were dropped on this region; a drag entered or left it. |
| `supportsFileDrop()` | function | Does this binary register the view at all?                    |

## Why a view rather than a module function

A drop belongs to a REGION. Dropping a file on the chat should attach it; dropping one on the sidebar
should not, and a module-level "did somebody drop something" event could not tell the two apart. So
the whole module is one view, and the call site wraps whatever should accept a file — see
`src/chat-ui/DropZone.tsx`.

## What it accepts

`UTType.item` is the root of the type tree, so an item conforming to it is any file at all, which is
what the composer takes. `.image` and `.fileURL` are named alongside it because a drag out of a photo
app or a browser advertises one of those and not always a file.

The operation is always `.copy`. A `.move` would empty the folder the reader dragged out of, which is
not a thing an attachment should ever do.

## The copy is load-bearing

`loadFileRepresentation` hands back a URL that is deleted as soon as its completion handler returns,
and the upload this feeds starts several turns later. So every item is copied into
`tmp/hermie-drop/<uuid>/<name>` first — a directory per drop, so two files with the same name from
two folders cannot overwrite each other.

## Not only a Mac thing

`UIDropInteraction` is the same interaction on an iPad: Split View, Stage Manager, a drag out of
Files. On an iPhone there is no drag session to receive and the interaction never fires, so the
JavaScript side needs no platform check — `DropZone` renders its children either way.

## What is unverified

The native half has never been exercised. No agent here can drag a file onto a window, and a
simulator cannot start a drag from a Finder that is not in it. What is checked is the JavaScript
side — the payload normalisation and the fallback — by unit test. See the drag-and-drop section of
`docs/platform-notes.md` for what to try in a Mac window.
