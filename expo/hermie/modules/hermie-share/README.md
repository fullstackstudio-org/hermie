# hermie-share

Share to Hermie: send an image, a file, a link or some text from any app
straight into a chat.

## The shape of it

Three processes and one directory.

```
 another app                    Hermie
 ───────────                    ──────
 share sheet ──┐
               │  writes        ┌──────────────────────────┐   reads
 iOS extension ┼───────────────▶│  share-outbox/<id>/      │◀──────────  the app
 (share/)      │                │    manifest.json         │
               │                │    <copied files>        │             uploads,
 ACTION_SEND ──┘                └──────────────────────────┘             sends,
 (android/)                                                              then clears
```

Nothing that writes an entry can send it. A share extension has no gateway, no
socket and no credentials — they live in the app, and the app may not even be
running. So the outbox is a **durable queue on disk**, not a handoff: the entry
survives the extension being killed, the app being killed, and the phone having
no route to the gateway for a day.

The file format is written down once, in TypeScript, in
`src/features/share/outbox.ts`. It is versioned, it is parsed defensively, and
it is the only thing the three sides share.

## Where each half lives

| Path                            | Target                 | What it is                                          |
| ------------------------------- | ---------------------- | --------------------------------------------------- |
| `ios/HermieShareModule.swift`   | the app                | Lists and clears entries. Decodes nothing.          |
| `share/`                        | `HermieShareExtension` | The sheet somebody sees inside another app.         |
| `android/…/HermieShareStore.kt` | the app                | Turns an `ACTION_SEND` intent into an entry.        |
| `plugin/with-hermie-share.js`   | prebuild               | The Xcode target, the App Group, the intent filter. |

## The one asymmetry worth knowing

**iOS asks which chat; Android asks afterwards.**

The iOS extension can read the roster — it is in the App Group, written there
by the widgets — so it shows a list and the entry names a bot. Android's
`ACTION_SEND` reaches the app with no sheet of ours anywhere in the flow, so the
entry names no bot and `ShareTargetSheet` asks once the app is up. The manifest
allows both shapes on purpose; `bot` is optional.

## Things that fail silently, and what guards them

- **A mismatched App Group.** Nothing fails to build and nothing fails to
  launch; sharing simply never delivers. `plugin/with-hermie-share.js` refuses
  to prebuild when `share/HermieShareExtension.entitlements` names a different
  group from the app's, and `__tests__/ios-share-plugin.test.ts` pins that the
  four places that spell it agree.
- **A principal class the loader cannot find.** `Info.plist` names
  `ShareViewController` as a string; the Swift class carries
  `@objc(ShareViewController)` for that reason. Without it the share sheet
  presents a blank panel and logs nothing.
- **An entry written before its files finished copying.** The manifest is always
  written LAST, and the app skips a directory that has no readable manifest.
- **A share delivered twice.** The entry is cleared only after the message has
  actually been sent. The gap fails towards "sent twice, visibly" rather than
  "sent nowhere, silently"; see the module comment in `share-delivery.ts`.

## What needs a device

Everything about the sheet itself. The parsing, the delivery flow and the
plugin's pure halves have tests; what has not been seen is the extension in a
real share sheet on an iPhone, in the Mac's share menu under the "Designed for
iPad" build, or the chooser row on Android. `docs/platform-notes.md` says so in
the same words.
