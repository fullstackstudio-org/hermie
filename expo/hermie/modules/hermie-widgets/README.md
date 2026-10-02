# hermie-widgets

Home-screen widgets on three platforms, from one file the app writes.

| Piece                           | What it is                                                        |
| ------------------------------- | ----------------------------------------------------------------- |
| `ios/HermieWidgetsModule.swift` | The app's side on Apple: write the file, ask for a redraw.        |
| `widget/`                       | The WidgetKit extension's own target. Swift, plist, entitlements. |
| `plugin/with-hermie-widgets.js` | Adds that target to the generated Xcode project at prebuild.      |
| `android/`                      | Two `AppWidgetProvider`s and the same three functions in Kotlin.  |

The JavaScript side is `src/platform/widgets.ts` (the seam), `src/features/widgets/snapshot.ts`
(what a widget is told, pure and tested) and `src/features/widgets/widget-sync.ts` (when it is
told it).

## The shape of the thing

A widget process is not the app. It has no gateway, no socket, no keychain and no store — it wakes
up, reads one file, draws, and is killed. So everything derived is derived **once**, in the app,
while the app still has the state to derive it from, and written down as a versioned JSON document:

```json
{
  "version": 1,
  "generatedAt": 1789954934928,
  "bots": [
    {
      "name": "researcher",
      "displayName": "Researcher",
      "avatarPath": "avatars/researcher.png",
      "initials": "R",
      "colour": "#2A72DC",
      "presence": "online",
      "lastLine": "Retry semantics: what actually changed Short version: the backoff…",
      "lastAt": 1789954860,
      "unread": 0,
      "needsInput": false
    }
  ]
}
```

`presenceOf`, `unreadCountSince` and `formatPreview` are the same functions the chat list calls, for
the reason `presence.ts` gives: a widget that says "Online" over a row that says "Needs input" is
two bugs that look like one. `colour` is `ACCENTS[…].bubble` and not `.fill` — `bubble` is the value
`npm run contrast:check` measures white against, and Lime's `fill` is `#C7FF4A`, which white
measures about 1.3 : 1 on.

## Where the file goes

|         | The snapshot                                        | The avatars                       |
| ------- | --------------------------------------------------- | --------------------------------- |
| Apple   | `widget-snapshot.json` in the App Group container   | `avatars/<name>.png` beside it    |
| Android | one string in `SharedPreferences("hermie.widgets")` | `filesDir/hermie-widget-avatars/` |

Apple needs the App Group (`group.dev.hermie.app`) because an extension is a second sandbox.
Android does not: an `AppWidgetProvider` is a `BroadcastReceiver` in the app's own process, and the
launcher only ever holds the `RemoteViews` it was handed. That is the whole difference, and it is
why the entitlement half of the story has no Android equivalent to get wrong.

**The App Group is spelled in four places and nothing checks three of them at compile time.** The
plugin asserts the extension's entitlements at prebuild, `__tests__/ios-widgets-plugin.test.ts`
asserts the two Swift files, and `docs/platform-notes.md` names it for whoever has to find it in the
Developer portal.

## Updates are pushed, never polled

`.never` on iOS, `updatePeriodMillis="0"` on Android. Everything a widget shows is something only
the app can know and the app already knows the moment each of it changes, so it writes the file and
asks for a redraw. A refresh policy on top of that would spend the day's widget budget re-reading a
file that has not changed.

The cost is stated plainly because a reader will hit it: **a phone whose Hermie has not run for a
week shows a week-old widget.** `generatedAt` is in the file so the picture can say when it was
true. This is the honest trade for a client with no background delivery of its own.

## Families

| iOS                                         | Android                      | Shows                           |
| ------------------------------------------- | ---------------------------- | ------------------------------- |
| `systemSmall`, configurable by AppIntent    | `HermieSmallWidgetProvider`  | one bot                         |
| `systemMedium`, configurable by AppIntent   | `HermieMediumWidgetProvider` | up to three bots, or one folder |
| `accessoryRectangular`, `accessoryCircular` | —                            | "N need input"                  |

The medium widget's configuration is a FOLDER, not a chat — the small one already answers "which
conversation", and a folder is the only way this app lets somebody say "these bots, and not the
others". Unconfigured it is the whole list, which is what it was before it could be configured.
Its header's two numbers follow the CHAT LIST's folder rules rather than the per-bot rules the rows
follow, which means a folder can show a count no row inside it shows; `snapshot.ts` explains both
sides and `docs/platform-notes.md` flags it as the owner's to settle.

Two things Android does not have. There is no accessory family — `widgetCategory="keyguard"` went
away in Android 5 and was never replaced — so the lock-screen count is Apple-only. And there is no
per-widget configuration activity, so neither the small nor the medium widget can be pinned there:
one always shows the most recent chat and the other the most recent three.
`res/xml/hermie_widget_small_info.xml` says why that is a stated limitation rather than a half-built
picker.

## Taps

`hermie://chat/<bot>` on every platform, parsed by `src/platform/deep-link.ts` and acted on by both
shells — plus `hermie://folder/<id>` from a folder widget's header, which opens the chat list with
that folder expanded and scrolled to. The scheme was already registered — Expo writes `CFBundleURLTypes` and the Android intent
filter from `scheme` in `app.config.ts` — so what the widgets needed was a reader, not a
registration. The grammar is deliberately narrow: a URL scheme is registered with the SYSTEM, so any
app on the device can send one, and opening a chat that already exists is the whole of what a link
may do.

## Traps worth knowing

- **A pod and a native target may not share a name.** Both write `<name>.swiftmodule` into the same
  products directory. The extension is `HermieWidgetsExtension` for that reason; with both called
  `HermieWidgets` the app fails to compile its own autolinking file with a deployment-target error
  that names neither.
- **`xcode`'s `addTargetDependency` does nothing when the project has no `PBXTargetDependency`
  section**, which a one-target project does not. The plugin creates the two empty sections first
  and asserts the dependency landed.
- **`pod install` re-writes the whole pbxproj with its own quoting.** A build setting matched by its
  quoted VALUE works exactly once. The plugin addresses configurations by uuid.
