# 0028. Native SwiftUI apps on Apple platforms, sharing one Swift package

- Status: Accepted
- Date: 2026-10-02
- Supersedes, on Apple platforms: [0002](0002-macos-via-react-native-macos.md),
  [0011](0011-mac-via-the-ipad-build.md)
- Amends: [0001](0001-expo-sdk-54-rn-081.md)

## Context

Hermie has shipped as one Expo and React Native codebase on iPhone, iPad, Android, the Mac and the
browser. On Apple platforms that codebase has been paying a rising bill in native code it does not
own, and the bill is the reason for this record.

- **The Mac is a tablet in a window.** [ADR-0011](0011-mac-via-the-ipad-build.md) made the Mac the
  iPad build because the react-native-macos target could not be made to work. That was the right call
  against that alternative, and it bought a Mac app with no Intel support, no menu that is not
  bridged by hand, a Return key that cannot type a newline, and text that cannot be drag-selected —
  the last of which is why the desktop shell in [ADR-0027](0027-desktop-is-a-webview-over-hermie-web.md)
  exists at all.
- **The SDK keeps asking for native workarounds.** [ADR-0001](0001-expo-sdk-54-rn-081.md) records the
  latest: iOS 27 refuses to launch an app that has not adopted the scene life cycle, and the app now
  carries a config plugin and a local module whose only job is to stand in for an SDK it cannot move
  to without a coordinated upgrade on every platform.
- **Much of the Apple surface is Swift already.** The share extension, the widgets, the Shortcuts
  intents, the Mac bridges and the scene delegate under `expo/hermie/modules/` are Swift, and the
  share extension already opens its own WebSocket with `URLSessionWebSocketTask`
  ([ADR-0026](0026-the-share-sheet-may-deliver.md)). What React Native contributes on these platforms
  is the screens, and the bridge between them and the Swift that already exists.
- **The hot path shares a thread with the scroll.** Every streamed event is reduced on the JavaScript
  thread, which also drives the transcript list. A busy turn and a fast scroll compete for the same
  thread, and on a long transcript that is the difference a reader feels first.

What does not change is just as important. The gateway protocol is not ours and stays as it is. The
hard logic — the transcript engine in `packages/transcript` and the connection and sign-in code in
`packages/gateway-client` — is pure TypeScript with a large test suite, and Android and the browser
keep running it through Expo. A native app on Apple platforms therefore has to reproduce that logic
exactly, not re-imagine it; how that is enforced is
[ADR-0029](0029-expo-native-and-the-contract-directory.md)'s subject.

The options for the platform as a whole:

1. **Stay on Expo and keep paying.** An SDK upgrade fixes the scene life cycle; nothing fixes the
   Mac, and the thread the transcript and the list share is the architecture, not a bug.
2. **Mac Catalyst, or a UIKit app ported to the Mac.** Better than the iPad build in a window, but it
   is still an iPad app's idea of a Mac, which is what [ADR-0002](0002-macos-via-react-native-macos.md)
   already dismissed it for.
3. **Native SwiftUI apps for iPhone, iPad and the Mac, sharing one Swift package.** One language, one
   UI framework and one set of system APIs on every Apple device, with the TypeScript logic ported and
   held to the TypeScript tests.

## Decision

**Hermie on Apple platforms is rebuilt as native SwiftUI apps: one universal iPhone and iPad app and
one Mac app, sharing one Swift package, under the bundle id the Expo build already uses.** Android and
the browser stay on the Expo app until they get native builds of their own, which is not decided
here. Until the native apps reach parity and ship, the Expo app remains the shipping app on Apple
platforms as well.

At the time of writing the native apps are a skeleton: both app shells build, every package target
exists with a smoke test, and the screens show a placeholder. The rules below are the ones that code
is written to; where one says how something will work, it is a decision about code that does not
exist yet.

### Shape

- **One bundle id, one store record.** Both apps are `dev.hermie.app` and go to the App Store Connect
  record the Expo build uses, with the iOS and macOS platforms on it. A native build arrives as an
  update to the Expo one, on every device, without a new listing, and keeps the shared keychain group
  and App Group the Expo build already writes to.
- **One Swift package, thin shells.** `native/apple/HermieKit` holds everything; an app shell holds
  only the `@main` app, its scenes, `Info.plist`, entitlements and the asset catalog. The package is
  split into eight targets, one per layer, and the dependency graph is part of the design: the
  protocol, the engine and the stores know nothing about SwiftUI, and only `HermieUI` draws. An app
  extension links `HermieShared` (and `HermieStore` for the keychain) and nothing else, which keeps
  [ADR-0023](0023-the-shared-container-is-the-seam.md)'s rule that an extension holds no sign-in
  logic enforceable by the linker. [docs/native.md](../native.md) lists the targets.
- **Minimum OS 26 on iPhone, iPad and the Mac.** The current observation, scroll-position and speech
  APIs and the system's own glass materials exist on 26 without fallbacks, so there is one code path.
  A device below 26 keeps the last Expo build, which the store goes on serving it. Supporting iOS 18
  and macOS 15 was considered and rejected: it doubles the matrix a screen is tested against and needs
  hand-made stand-ins for materials that the system draws on 26. The package needs Swift tools 6.2,
  which is what a hosted macOS runner with Xcode 26 has; an API newer than the 26 SDK sits behind
  `if #available`.
- **Swift 6 language mode with complete concurrency checking, warnings as errors.** Actors own I/O and
  shared mutable state: the connection, the credentials, the per-gateway transcript store and the
  SQLite store. Feature models are `@MainActor @Observable`. The engine is pure value types. There is
  no Combine and no `ObservableObject`, and `@unchecked Sendable` appears only with a comment saying
  why it is safe and a reviewer who agreed.
- **No third-party code in what ships.** The binaries link Apple's frameworks and this repository's
  package and nothing else. The one exception agreed in advance is the Markdown fallback below. A build
  tool is not a dependency: XcodeGen generates the project and is not linked into anything.

### What is kept from the Expo build

- **Transport: `URLSessionWebSocketTask`, behind a small `WebSocketTransport` protocol** so tests
  substitute it. It carries subprotocols and headers, which a ticket dial
  ([ADR-0005](0005-ticket-per-websocket-dial.md)) and a front door
  ([ADR-0021](0021-header-based-front-doors.md)) need, and the share extension's sender already dials a
  gateway with it. Rejected: `Network.framework` (more code for the same frames) and any socket
  library (the dependency rule).
- **Sign-in: [ADR-0004](0004-native-pkce-via-webview.md) unchanged.** A `WKWebView` whose navigation
  delegate intercepts the loopback redirect. `ASWebAuthenticationSession` was reconsidered and
  rejected again: it cannot complete on an `http://127.0.0.1` redirect, and it cannot host the
  gateway's own password page in the same session.
- **Persistence: the keychain, one SQLite file and the App Group files.** The SQLite file goes
  through the system's `sqlite3` and holds a key-value table, the bot roster and the transcript cache.
  Rejected: GRDB (a dependency for three tables of JSON), SwiftData (migrations it decides and a model
  context that is awkward off the main actor), and `UserDefaults` for app state (not atomic across
  keys, and wrong for state namespaced per gateway the way [ADR-0024](0024-a-list-of-gateways.md)
  requires).
- **The keychain items keep the shape the Expo build writes.** A generic password with service
  `app:no-auth`, the key's UTF-8 bytes as account and generic attribute, the
  `$(AppIdentifierPrefix)dev.hermie.app` access group and `AfterFirstUnlockThisDeviceOnly`. The native
  app reads and writes the same items, so updating from the Expo build signs nobody out, there is never
  a second copy of a token, the share extension's reader stays valid, and a rollback to an Expo build
  stays signed in too. A new naming scheme with a one-time copy was rejected: two copies of every
  secret for as long as the window lasts, and a migration state machine guarding them. The items may
  be renamed once no Expo build for Apple platforms is left to read them.

### How the screens are built

- **One navigation model.** A `NavigationSplitView` root driven by one observable router, which
  collapses to a stack on a narrow iPhone; extra chat windows on iPad and the Mac through a window
  group keyed by the chat; and on the Mac a Settings scene, menu commands and a menu bar extra.
  Separate iPhone and iPad roots were rejected: two navigation state machines to keep in step.
- **The transcript list is SwiftUI, behind a boundary that allows it not to be.** A `ScrollView` with
  a `LazyVStack` anchored to the bottom, measured in a spike before the chat screen is built on it.
  The engine runs in an actor off the main thread and hands the main-actor models immutable snapshots,
  coalesced to at most one per frame; reducing on the main actor, the way the Expo app reduces on the
  JavaScript thread, was rejected for the reason the Context gives. The list sits behind a small
  `TranscriptList` view, so if the spike misses its hitch budget a collection-view representable
  replaces it without touching the item views. Starting with UIKit and AppKit lists was rejected: two
  implementations before knowing whether one is needed.
- **Markdown: the system parses, our own block model renders.** Foundation's `AttributedString`
  Markdown parser reads the full syntax; a block model of our own and SwiftUI views draw paragraphs,
  headings, lists, quotes, tables (as a `Grid`), code blocks and rules. The parser sits behind a
  protocol, and if block-level golden tests show gaps that preprocessing cannot close, the swift-markdown
  package from the Swift project is the agreed fallback without another round of this record. Rejected:
  a hand-written parser (thousands of lines of edge cases the TypeScript renderer already paid for once)
  and a web view, which [ADR-0020](0020-diagrams-and-math-without-a-webview.md) already ruled out.
- **Highlighting, mathematics and Mermaid come later, and stay native.** Until they are ported, a code
  block is monospaced with a copy button, and a mathematics or Mermaid block shows its source. The
  port takes the existing pure TypeScript parsers and layouts, which can be golden-tested like the
  engine, and draws with `Canvas`; highlighting is a small table-driven lexer. Rejected: running
  highlight.js in JavaScriptCore, for the same reason the engine is not run that way
  ([ADR-0029](0029-expo-native-and-the-contract-directory.md)).
- **The look is the system's.** Native controls and system materials; nothing in `design/tokens.md`
  is recreated. A theme becomes one tint plus light, dark or system. A chat's own colour stays data in
  `ui_meta` ([ADR-0016](0016-ui-meta-sync.md)) and tints that chat's avatar, bubbles and accents. Theme
  fields the native app does not understand are carried through `ui_meta` untouched, so an Expo client
  sharing the same gateway keeps them. Text size is Dynamic Type; the synced text-size setting scales
  the transcript only.
- **Localisation: one String Catalog, generated from the TypeScript catalogues.** A script turns the
  English source and the Dutch and German catalogues (see [docs/i18n.md](../i18n.md)) into the
  catalog, and TypeScript stays the source while the Expo app is alive; strings only the native app
  has go in a second table. The app follows the system's per-app language setting and has no picker of
  its own. A language pinned in the Expo app is applied once, when the native app first imports the
  Expo app's data.
- **Accessibility is a criterion for every screen, not a pass at the end.** Labels and custom actions
  on every custom row, Dynamic Type up to the largest accessibility size, Reduce Motion respected, the
  whole app usable from a keyboard on iPad and the Mac, and the system accessibility audit run in the
  UI smoke test. A screen that fails any of these is not done.

Notifications are not covered here. Moving them off Expo's push service on Apple platforms is a
decision of its own, with its own trade-offs, and a separate ADR will cover it.

## Consequences

- **The Mac becomes a Mac.** Its own windows, menus, Settings and keyboard handling, and text that
  selects. Once the native Mac app is public,
  the desktop shell's macOS build has no reason to exist; its Windows and Linux builds are unaffected
  ([ADR-0029](0029-expo-native-and-the-contract-directory.md)).
- **There are two implementations of everything on Apple platforms until the Expo build retires
  there.** A fix to the engine lands in TypeScript first and is ported; a new screen exists twice for
  a while. That is the cost of not deleting anything before its replacement has shipped, and it is why
  the parity rule in [ADR-0029](0029-expo-native-and-the-contract-directory.md) is enforced by CI
  rather than by care.
- **Devices below iOS, iPadOS or macOS 26 stop getting updates** when the first native build ships.
  They keep the last Expo build, which keeps working against the same gateway.
- **The dependency rule makes some features expensive.** Syntax highlighting, mathematics and
  diagrams are ports, not packages, and arrive late. In exchange there is nothing to audit, update or
  license in the shipped binaries beyond what is in this repository.
- **Concurrency checking is a gate, not a suggestion.** Code that the Swift 6 checker rejects does not
  build. That makes some patterns longer to write, and it moves a whole class of data races from bug
  reports to compile errors.
- **The keychain item shape is now a contract between two apps.** Nothing may change the service, the
  account encoding or the access group while an Expo build for Apple platforms can still be installed
  over, or under, a native one. A mismatch fails silently: the native app simply finds no credential
  and asks the reader to sign in.
- **A reader loses the in-app language picker on Apple platforms.** The system's per-app language
  setting replaces it. That is one less thing for the app to own, and one more place a reader has to
  look.
- **[ADR-0002](0002-macos-via-react-native-macos.md) and [ADR-0011](0011-mac-via-the-ipad-build.md)
  are superseded on Apple platforms**, and [ADR-0001](0001-expo-sdk-54-rn-081.md) is amended: its pin
  still governs every Expo build, which after this decision means Android and the browser in the long
  run, and Apple platforms only until the native apps replace the Expo build there.
