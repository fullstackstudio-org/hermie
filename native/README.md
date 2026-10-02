# Native Hermie

Hermie is being rewritten as native apps, one platform at a time. This directory is where they live. The
Expo app stays in the repository, and stays the shipping app on every platform that has no native build
yet.

## What lives here

```
native/
  apple/
    HermieKit/     one Swift package with everything the Apple apps share
    Config/        Version.xcconfig, Shared.xcconfig, Signing.xcconfig.example
    xcodegen/      base.yml: the settings and target template both projects include
    scripts/       generate.sh, test.sh, archive.sh
  ios/             project.yml and App/: the iPhone and iPad app
  macos/           project.yml and App/: the Mac app
  android/         reserved, see its README
  web/             reserved, see its README
```

`HermieKit` is split into one target per layer, and the split is the design: the transcript engine, the
protocol and the stores know nothing about SwiftUI, an app extension links only `HermieShared` (and
`HermieStore` for the keychain), and only `HermieUI` draws.

| Target             | Depends on       | Holds                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `HermieProtocol`   | none             | JSON values, JSON-RPC envelopes, events, methods, REST types |
| `HermieTranscript` | Protocol         | the transcript engine, as value types and pure functions     |
| `HermieGateway`    | Protocol         | addresses, sign-in, the HTTP client and the connection actor |
| `HermieStore`      | none             | the keychain, the SQLite store and App Group files           |
| `HermieShared`     | none             | types that are safe inside an extension                      |
| `HermieMarkdown`   | none             | the Markdown block model and its views                       |
| `HermieCore`       | all of the above | the session, the transcript store and the feature models     |
| `HermieUI`         | Core, Markdown   | the views, per feature, and the router                       |

The app shells hold nothing but the `@main` app, its scenes, `Info.plist`, entitlements and the asset
catalog. Both use the bundle id `dev.hermie.app`, so a native build arrives as an update to the Expo one,
and both read and write the keychain items the Expo build already wrote.

There are no third-party Swift packages. Every target builds in the Swift 6 language mode with complete
concurrency checking and warnings as errors.

## Building

You need Xcode 26 or newer and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install
xcodegen`). Both apps need iOS, iPadOS or macOS 26.

```sh
native/apple/scripts/test.sh            # swift test for HermieKit
native/apple/scripts/test.sh --apps     # the same, then generate and build both apps unsigned
native/apple/scripts/generate.sh        # write native/ios/Hermie.xcodeproj and native/macos/Hermie.xcodeproj
```

The `.xcodeproj` files are generated and ignored by git: change `project.yml` or `base.yml`, never the
project. `generate.sh` also writes the build number (the git commit count) and the short commit hash into
an ignored xcconfig, which is where the About line gets them, so run it again after you pull or commit.
The version people see is `MARKETING_VERSION` in `apple/Config/Version.xcconfig`.

A simulator build and an unsigned Mac build need no Apple account:

```sh
xcodebuild build -project native/ios/Hermie.xcodeproj -scheme Hermie \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
xcodebuild build -project native/macos/Hermie.xcodeproj -scheme Hermie \
  -destination 'generic/platform=macOS' CODE_SIGNING_ALLOWED=NO
```

To sign, give the build your team id: export `HERMIE_TEAM_ID`, or copy
`apple/Config/Signing.xcconfig.example` to `Signing.xcconfig` and fill it in. Neither ever goes into the
repository. An unsigned Mac build runs without its sandbox and entitlements, because those are only
granted to a signed app.

To archive for App Store Connect, `apple/scripts/archive.sh ios|macos <outdir>` generates, archives
and exports an `.ipa` or a `.pkg`; `--upload` sends it on. Its variables, the build number and the
native version rule are in [docs/release.md](../docs/release.md#native-apps).

The app transport security setting is a single `NSAllowsArbitraryLoads`, on purpose; see
[ADR-0014](../docs/adr/0014-plain-http-on-private-networks.md) before adding anything beside it.

## Strings

`HermieUI/Resources` holds two String Catalogs, and they are kept differently:

- **`Localizable.xcstrings` is generated.** It is the Expo app's English, Dutch and German, exported
  from the TypeScript catalogues by `npm run i18n`, together with the typed accessors in
  `HermieUI/Generated/Strings.generated.swift` (`Strings.App.Common.cancel`,
  `Strings.Chat.Clarify.step(current:total:)`). Never edit either by hand, and do not let Xcode add keys
  to it: change the TypeScript and run the script. CI fails when they disagree.
- **`Native.xcstrings` is written by hand.** Use it only for a string the native apps have and the Expo
  app does not: a widget, a Shortcut, a system integration. Add it in all three languages, and read it
  with `String(localized: "…", table: "Native", bundle: .module)`. A string both apps show belongs in
  the TypeScript catalogues instead, so the two cannot drift apart.

The apps follow the system's per-app language and have no picker of their own.
[docs/i18n.md](../docs/i18n.md#native-apps) has the details: plurals, the hand-written overrides, and
how the export is checked against the TypeScript.

## Roadmap

- **M0**: the repository restructure, this skeleton, CI, and the golden corpus both worlds test against.
- **M1**: core chat. Connect, sign in, the chat list and a transcript that streams; first TestFlight builds.
- **M2**: daily-driver parity with the Expo app. Until it is complete, native builds go to an internal
  TestFlight group only.
- **M3**: the push relay and system integration: notifications, widgets, share, Shortcuts.
- **M4**: the long tail.
- **M5**: polish, encrypted notifications, the public release, and retiring the Expo build on Apple
  platforms.

Android and the web build come after that; see [android](android/README.md) and [web](web/README.md).
