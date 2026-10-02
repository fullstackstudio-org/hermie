# 0002. macOS through react-native-macos, in the same app package

- Status: Superseded by [0011](0011-mac-via-the-ipad-build.md)
- Date: 2026-09-18

> Superseded on 2026-09-19. The Mac version is the iOS app running as "Designed for iPad" on Apple
> Silicon, and the native macOS target is deleted. The text below is kept as written:
> [0011](0011-mac-via-the-ipad-build.md) lists what a day of building on this decision actually cost,
> and that list is only readable next to the reasoning it undid.

## Context

Hermie should be a real Mac app: a window with a sidebar and a detail pane, not a phone screen
stretched out, and not a web page in a shell. The options were:

1. **react-native-macos** — a real AppKit target running the same React tree.
2. **Mac Catalyst** — the iPad build running on macOS. Cheap, but it looks and behaves like an iPad
   app, and Expo's iOS tooling does not support it well.
3. **A separate desktop app** (Electron, Tauri, SwiftUI) — a second codebase for the same protocol
   and the same chat engine.

Expo modules are not officially supported on macOS. react-native-macos publishes a guide for wiring
them up through CocoaPods, and Expo SDK 54's own podspecs do declare `:osx` for part of the module
set — but only part of it, and that part is not documented anywhere as a contract.

## Decision

macOS is a real target built with **react-native-macos**, living in `expo/hermie/macos/` inside the
same app package as iOS and Android. The directory is committed and maintained by hand: it started
from the react-native-macos 0.81 template and was adapted, rather than being regenerated.

Expo modules are linked into the macOS build through `use_expo_modules!` with an explicit exclusion
list for the modules that ship no macOS slice. Where a module is excluded, a `.macos.ts` or
`.macos.tsx` variant in `src/` supplies the replacement behaviour, so the rest of the app does not
branch on the platform.

Metro serves the `macos` platform and rewrites every `react-native` import to `react-native-macos`.

## Consequences

- One React tree, one chat engine, one protocol implementation. A fix to the transcript reducer fixes
  it on every platform at once.
- `expo/hermie/macos/` is ours to maintain. It does not regenerate with `expo prebuild`, which means
  changes to `app.config.ts` — the bundle identifier, the name, the icon — have to be mirrored there
  by hand. `docs/platform-notes.md` lists everything that was changed relative to the template.
- The macOS module set is smaller than the iOS one, and the gaps are real. Secure storage in
  particular has no macOS implementation, which is why a macOS build is a development build until
  that is closed. Every SDK bump has to re-check the exclusion list.
- If Expo ever supports macOS properly, or react-native-macos stops tracking React Native closely
  enough, this record needs a successor rather than an edit.
