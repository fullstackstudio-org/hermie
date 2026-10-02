// swift-tools-version: 6.2

import PackageDescription

// Everything the Apple apps and their extensions share, as one package with one
// target per layer. The dependency graph is the one in docs/native.md
// and is part of the design: the engine, the protocol and the stores know
// nothing about SwiftUI, extensions link `HermieShared` (and `HermieStore` for
// the keychain) and nothing else, and only `HermieUI` draws.
//
// No third-party packages. Every target builds in the Swift 6 language mode,
// where strict concurrency checking is complete, with warnings treated as
// errors.

let settings: [SwiftSetting] = [
  .treatAllWarnings(as: .error)
]

let package = Package(
  name: "HermieKit",
  defaultLocalization: "en",
  platforms: [
    .iOS(.v26),
    .macOS(.v26)
  ],
  products: [
    .library(name: "HermieProtocol", targets: ["HermieProtocol"]),
    .library(name: "HermieTranscript", targets: ["HermieTranscript"]),
    .library(name: "HermieGateway", targets: ["HermieGateway"]),
    .library(name: "HermieStore", targets: ["HermieStore"]),
    .library(name: "HermieShared", targets: ["HermieShared"]),
    .library(name: "HermieShareKit", targets: ["HermieShareKit"]),
    .library(name: "HermieMarkdown", targets: ["HermieMarkdown"]),
    .library(name: "HermieCore", targets: ["HermieCore"]),
    .library(name: "HermieUI", targets: ["HermieUI"])
  ],
  targets: [
    // Wire types: JSON values, JSON-RPC envelopes, events, methods, REST DTOs. Foundation only.
    .target(name: "HermieProtocol", swiftSettings: settings),
    // The transcript engine: value types and pure functions. Foundation only.
    .target(name: "HermieTranscript", dependencies: ["HermieProtocol"], swiftSettings: settings),
    // Addresses, sign-in, the HTTP client and the connection actor. Foundation and CryptoKit.
    .target(name: "HermieGateway", dependencies: ["HermieProtocol"], swiftSettings: settings),
    // Keychain, SQLite and App Group files. Foundation, Security and SQLite3.
    .target(name: "HermieStore", swiftSettings: settings),
    // Types that are safe inside an app extension. Foundation only.
    .target(name: "HermieShared", swiftSettings: settings),
    // The share extension's outbox writer and direct send, here so they are unit-tested. Foundation only.
    .target(name: "HermieShareKit", dependencies: ["HermieShared"], swiftSettings: settings),
    // Markdown block model and its SwiftUI views.
    .target(name: "HermieMarkdown", swiftSettings: settings),
    // Sessions, stores and the observable feature models the views read.
    .target(
      name: "HermieCore",
      dependencies: [
        "HermieProtocol",
        "HermieTranscript",
        "HermieGateway",
        "HermieStore",
        "HermieShared",
        "HermieMarkdown"
      ],
      swiftSettings: settings
    ),
    // The views, per feature, and the router.
    //
    // The String Catalogs are for Xcode's editor only. The bundle gets the
    // `.lproj/*.strings(dict)` that `npm run i18n` compiles from them, because
    // SwiftPM's native build system (the default up to Swift 6.3) copies an
    // `.xcstrings` resource without compiling it. Excluding the catalogs keeps a
    // second, compiled copy out of the bundle on toolchains that would compile it.
    .target(
      name: "HermieUI",
      dependencies: ["HermieCore", "HermieMarkdown"],
      exclude: ["Resources/Localizable.xcstrings", "Resources/Native.xcstrings"],
      resources: [.process("Resources")],
      swiftSettings: settings
    ),

    .testTarget(name: "HermieProtocolTests", dependencies: ["HermieProtocol"], swiftSettings: settings),
    .testTarget(name: "HermieTranscriptTests", dependencies: ["HermieTranscript"], swiftSettings: settings),
    .testTarget(name: "HermieGatewayTests", dependencies: ["HermieGateway"], swiftSettings: settings),
    .testTarget(name: "HermieStoreTests", dependencies: ["HermieStore"], swiftSettings: settings),
    .testTarget(
      name: "HermieSharedTests", dependencies: ["HermieShared"], exclude: ["Fixtures"], swiftSettings: settings),
    .testTarget(name: "HermieShareKitTests", dependencies: ["HermieShareKit"], swiftSettings: settings),
    .testTarget(name: "HermieMarkdownTests", dependencies: ["HermieMarkdown"], swiftSettings: settings),
    .testTarget(name: "HermieCoreTests", dependencies: ["HermieCore"], swiftSettings: settings),
    .testTarget(name: "HermieUITests", dependencies: ["HermieUI"], swiftSettings: settings),
    // Black-box tests against packages/fake-gateway, macOS only; skipped unless HERMIE_INTEGRATION=1.
    // HermieStore too, for onboarding end to end over in-memory stores.
    .testTarget(
      name: "HermieIntegrationTests",
      dependencies: ["HermieGateway", "HermieProtocol", "HermieCore", "HermieStore"],
      swiftSettings: settings
    )
  ],
  swiftLanguageModes: [.v6]
)
