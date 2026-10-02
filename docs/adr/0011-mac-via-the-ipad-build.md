# 0011. The Mac version is the iPad build

- Status: Superseded on Apple platforms by [0028](0028-native-apps-on-apple-platforms.md); still how
  the Expo build reaches the Mac until the native Mac app replaces it
- Date: 2026-09-19
- Supersedes: [0002](0002-macos-via-react-native-macos.md)

> Note, 2026-10-02: the Mac is getting a native SwiftUI app of its own, built from the same Swift
> package as the iPhone and iPad app ([0028](0028-native-apps-on-apple-platforms.md)). Until it ships,
> the Mac version is still the Expo iPad build described here, and `npm run mac` still builds it.
> Nothing in this record applies to Android or the browser.

## Context

[ADR-0002](0002-macos-via-react-native-macos.md) chose react-native-macos so that the Mac would be a
real AppKit app rather than a stretched phone screen. A day of building on it produced the bill.

What was measured, all of it on this machine and all of it on 2026-09-19:

- **The build aborted the moment the sign-in web view mounted.** Fabric's generated
  `RCTThirdPartyComponentsProvider` lists react-native-screens classes, which are not linked on
  macOS, so the dictionary it builds contains `nil` and the app dies before a pixel of the page.
- **No keychain.** `expo-secure-store` is ios/tvos only. The macOS stand-in kept tokens in
  AsyncStorage, an unencrypted file in the app container, which is why every document in the
  repository said a macOS build was a development build.
- **No `Modal`.** `RCTModalHostView.m` is wrapped in `#if !TARGET_OS_OSX`, so every bottom sheet in
  the app red-boxed and had to be re-implemented as an absolutely positioned overlay.
- **No react-native-screens**, therefore no native stack, therefore the compact shell could not
  exist there and `Shell.macos.tsx` selected the sidebar layout unconditionally.
- **No NetInfo.** Importing the package threw at module scope and killed the app on launch.
- **`secureTextEntry` masked but never reported typing**, so onboarding could not be finished at all
  until `SecretField` stopped masking on that platform.
- **A programmatic `.focus()` could abort the process** inside AppKit's `_realMakeFirstResponder:`,
  on the main thread, where a JavaScript `try`/`catch` cannot help.
- **Nothing could drive it.** No scripted mechanism delivered a key to a react-native-macos view, so
  the platform could not be tested past a button press. Every claim about it was "builds and
  launches".
- **It set the floor for the whole project.** react-native-macos publishes 0.81.9 and nothing newer,
  which is the sole reason [ADR-0001](0001-expo-sdk-54-rn-081.md) pins Expo SDK 54 / RN 0.81 — and
  with it holds back Reanimated 4, FlashList 2 and MMKV 3 across all platforms.

Against that, the iOS Release build was run on the **My Mac (Designed for iPad)** destination on the
same afternoon, and the OIDC sign-in page opened in the in-app web view without trouble.

The options, reconsidered:

1. **Keep react-native-macos.** Eight platform seams to maintain, no secret store, an SDK pin on
   every other platform, and a target nobody can test.
2. **The iPad build on Apple Silicon.** One binary, every Expo module, a real keychain, a real
   `Modal`, a real navigator — and the same sidebar layout, because `useLayoutMode` already gives a
   wide window the sidebar shell.
3. **A separate desktop app.** A second codebase for the same protocol. Not seriously on the table.

## Decision

The Mac version of Hermie is the **iOS app running as "Designed for iPad" on Apple Silicon**. The
native macOS target is deleted: `expo/hermie/macos/`, every `*.macos.ts(x)` variant, the
`react-native-macos` dependency, the Metro platform and import rewrite, and the macOS CI and release
jobs.

Where a Mac genuinely differs from an iPad, one seam answers for it:
`expo/hermie/src/platform/runs-on-mac.ts`, backed by a local Expo module
(`expo/hermie/modules/hermie-mac`) that exposes `ProcessInfo.processInfo.isiOSAppOnMac`. React Native
offers nothing equivalent — `Platform.isMacCatalyst` reads the compile-time `TARGET_OS_MACCATALYST`
flag, which is false for the unmodified iOS binary macOS runs this way. Three things use it today:
Return sends in the composer, the status-bar safe-area inset is dropped, and the developer screen
reports which it is.

Distribution is the App Store and TestFlight. Apple offers an iOS app on Apple Silicon Macs from the
same listing unless it is opted out in App Store Connect, so there is nothing extra to build.

## Consequences

- **Apple Silicon only.** An Intel Mac cannot run it. react-native-macos could have; nothing else
  about that trade was worth the difference.
- **No downloadable `.app` on GitHub Releases.** A Mac user installs from the App Store or gets a
  TestFlight invite. The Developer ID certificate, the notarisation step and the four secrets that
  fed them are gone from `release.yml`.
- **The SDK pin is now a choice rather than a constraint.** ADR-0001's binding reason has lapsed.
  Deliberately not acted on in this change: an SDK bump is its own piece of work.
- **The secret store gap closes.** `expo-secure-store` links and the app is signed with
  `application-identifier`, which is its default keychain access group. Not yet exercised at runtime
  on a Mac — `docs/platform-notes.md` says so plainly rather than claiming it.
- **Eight platform seams collapsed into one.** Sheets, safe area, haptics, status bar, secret store,
  attachments, connectivity and the shell each went back to a single implementation. The seam that
  replaced them answers a narrower question, and `SecretStore` and `KeyValueStore` stay as interfaces
  because tests substitute them.
- **A local native module is new ground for this repo.** It is autolinked from
  `expo/hermie/modules/`, needs no hand edits under the generated `ios/`, and is Apple-only, so
  Android's build graph is untouched. `.easignore` had to learn the difference between the generated
  `ios/` and a module's `ios/`; a bare `ios/` pattern silently dropped the module from an EAS
  archive.
- **A bare Return sends and nothing types a newline.** iOS hands JavaScript no modifier state for a
  text field, so Shift+Return is indistinguishable from Return. Enter-to-send is worth more on a
  desktop than the newline key is; closing the gap needs a native key-command seam.
- **If Apple ever ships a first-class Mac story for Expo**, or the App Store route stops being
  acceptable, this record needs a successor rather than an edit.
