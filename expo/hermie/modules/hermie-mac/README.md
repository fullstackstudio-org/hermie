# hermie-mac

Three things about a desktop keyboard that JavaScript cannot find out for itself.

| Export                       | Kind     | Answers                                                                    |
| ---------------------------- | -------- | -------------------------------------------------------------------------- |
| `isMac`                      | constant | Is this the iOS app running on an Apple Silicon Mac?                       |
| `isShiftDown()`              | function | Is either Shift key down right now?                                        |
| `hasHardwareKeyboard()`      | function | Is a hardware keyboard attached at all?                                    |
| `onEscape`                   | event    | Escape was pressed, while this app was in front.                           |
| `onShortcut`                 | event    | A desktop chord was pressed — ⌘K, ⌘V, ⌘1…9 and the rest of the allow-list. |
| `readPasteboardAttachment()` | function | What `UIPasteboard.general` is holding, as an image or a file.             |

## `isMac`

`ProcessInfo.processInfo.isiOSAppOnMac` is the only answer Apple gives, and React Native does not
expose it. `Platform.isMacCatalyst` is a different question — it reads `TARGET_OS_MACCATALYST`, a
compile-time flag that is false for an unmodified iOS binary running on a Mac, which is exactly what
Hermie ships (see `docs/adr/0011-mac-via-the-ipad-build.md`).

A constant rather than a function: the answer is fixed for the lifetime of the process, and the
JavaScript side needs it during the first render — a layout that waits for a promise flashes the wrong
geometry first.

## The two keys, and why GameController

Both exist because UIKit will not give a React Native `TextInput` what is needed, and both are read
from GameController's HID state, which is below the responder chain entirely.

- **Shift** is missing rather than absent. A text field's `onKeyPress` payload on iOS is exactly
  `{ key, eventCount }` — no modifier flags — so Shift+Return and Return arrive as the same `"\n"`.
  The composer asks `isShiftDown()` while handling the Return and, for Shift, writes the newline into
  the draft at the caret itself. Polled and not pushed: a modifier event would have to be raced
  against the Return it belongs to.
- **Escape** never arrives. It inserts no text, so it never reaches a `UITextView` delegate. A
  `UIKeyCommand` would have to sit in the responder chain, and a presented `Modal` leaves that chain —
  which is the case that matters most, because a sheet is the main thing Escape should close.
  `GCKeyboardInput.keyChangedHandler` is not routed through the responder chain at all.

`onEscape` is only emitted while `applicationState == .active`. HID state does not care which app is in
front, and a keystroke meant for another window must not dismiss a sheet nobody is looking at.

The handler is installed on `GCKeyboardDidConnectNotification` as well as immediately, because a
keyboard can arrive after launch — an iPad in a case, a Mac waking a Bluetooth keyboard. All keyboards
coalesce into one object, so that fires once rather than per device.

GameController asks only to be linked; its own header says so, and there is no entitlement or
Info.plist key. The podspec declares the framework.

**Not verified at runtime.** Whether `GCKeyboard.coalesced` is populated for an iOS app on a Mac is
reasoned from the SDK, not watched. If it is nil, everything here degrades to "no keyboard": `false`,
and an event that never fires. `docs/platform-notes.md` tracks it.

## ⌘V is two steps, not one

`onShortcut` reports the chord — the same GameController handler `onEscape` uses, widened to an
allow-list of desktop shortcuts (see `src/platform/desktop-shortcuts.shared.ts`) — for every text
field in the app, and it never intercepts anything: a plain-text ⌘V has already landed in the
focused `UITextView` through the ordinary responder chain by the time JavaScript hears about it.

`readPasteboardAttachment()` is the second step, called only by the composer and only while its own
field has the caret. It asks `HermiePasteboard` what `UIPasteboard.general` is actually holding — an
image, written out fresh because there is no file behind one; a file URL, copied into the app's own
tmp directory the way `hermie-drop` copies a dropped one — and answers an empty list for a
pasteboard holding only text, which a plain `UITextView` already pastes on its own.

## Shape

The module is Apple-only on purpose. `expo-module.config.json` declares no Android platform, so
autolinking never offers it there, and the JavaScript side reads it with
`requireOptionalNativeModule` — which returns `null` rather than throwing — so Android, the web and the
Jest environment all get the honest answer with no second implementation. Two seams consume it:

- `expo/hermie/src/platform/runs-on-mac.ts` — `RUNS_ON_MAC`
- `expo/hermie/src/platform/keyboard-modifiers.ts` — the keyboard three, with `useEscapeKey` in
  `expo/hermie/src/ui/` deciding which open thing an Escape belongs to
- `expo/hermie/src/platform/desktop-shortcuts.ts` — `onShortcut`, including ⌘V, with `useShortcut`
  deciding which registered screen a chord belongs to
- `expo/hermie/src/platform/native-paste.ts` — `readPasteboardAttachment()`, read by the composer
  once ⌘V has been delivered to it

It is a local module under `expo/hermie/modules/`, which Expo's autolinking scans by default, so `ios/`
stays fully generated and nothing there is edited by hand. One trap worth knowing: a module's `ios/`
directory is not the generated project, and an ignore rule that says `ios/` without anchoring will
swallow it — `npx expo-doctor` fails when that happens, which is how it was caught in `.easignore`.
