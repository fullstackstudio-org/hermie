# Working on the native apps

Hermie's Apple apps are being rebuilt natively in SwiftUI, next to the Expo app that still ships.
This page is for contributors to that rebuild: how the code is split, the rules it is written to, how
to build and test it, and how it is kept in step with the TypeScript reference.

The decisions behind it are [ADR-0028](adr/0028-native-apps-on-apple-platforms.md) (the apps and how
they are built) and [ADR-0029](adr/0029-expo-native-and-the-contract-directory.md) (the repository
layout and the parity rule). [native/README.md](../native/README.md) has the directory map and the
milestones.

**Where things stand.** The native tree is a skeleton: both apps build and show a placeholder,
every package target exists with a smoke test, and CI builds both apps. The engine, the gateway
client, the stores and the screens are still to come. Anything below that says "will" describes a
rule for code that has not been written yet.

## What you need

- A Mac with **Xcode 26** or newer. The package needs Swift tools 6.2 and the iOS and macOS 26 SDKs.
- **XcodeGen**: `brew install xcodegen`.
- **Node and the workspace** (`nvm use && npm ci`, as in [CONTRIBUTING.md](../CONTRIBUTING.md)) for
  anything that touches `contract/` or the fake gateway.

No Apple account is needed to build, test or run in the simulator. Signing is only for a device or
an archive; see [Building and testing](#building-and-testing).

## The targets, and what may import what

`native/apple/HermieKit` is one Swift package with one target per layer. The dependency graph is
declared in `Package.swift` and the compiler enforces it, so an import that crosses it does not
build.

| Target             | May import     | Holds                                                         | Apple frameworks                       |
| ------------------ | -------------- | ------------------------------------------------------------- | -------------------------------------- |
| `HermieProtocol`   | nothing        | JSON values, JSON-RPC envelopes, events, methods, REST bodies | Foundation                             |
| `HermieTranscript` | Protocol       | the transcript engine: value types and pure functions         | Foundation                             |
| `HermieGateway`    | Protocol       | addresses, sign-in, the HTTP client, the connection actor     | Foundation, CryptoKit                  |
| `HermieStore`      | nothing        | the keychain, the SQLite store, App Group files               | Foundation, Security, SQLite3          |
| `HermieShared`     | nothing        | types that are safe inside an app extension                   | Foundation                             |
| `HermieMarkdown`   | nothing        | the Markdown block model and its views                        | SwiftUI                                |
| `HermieCore`       | all six above  | the session, the transcript store, the feature models         | Foundation, Observation                |
| `HermieUI`         | Core, Markdown | the views, per feature, and the router                        | SwiftUI, with small `#if os()` islands |

The rules that follow from it:

- **Only `HermieUI` and `HermieMarkdown` import SwiftUI.** The engine, the protocol and the stores
  are testable with `swift test` and no simulator.
- **The engine is a transliteration.** `HermieTranscript` mirrors the exports of
  `packages/transcript` one to one: the same function names, the same state shape, the same JSON
  encoding. A function that reads the clock in TypeScript takes `now` as a parameter in Swift. Do not
  improve the engine in the port; improve it in TypeScript and port the change (see
  [Parity](#parity-with-the-typescript-reference)).
- **An app shell holds no logic.** `native/ios/App` and `native/macos/App` contain the `@main` app,
  its scenes, the app delegate adaptor, `Info.plist`, entitlements and the asset catalog. Everything
  else is in the package.
- **An app extension links `HermieShared`, and `HermieStore` if it needs the keychain, and nothing
  else.** No extension signs in, refreshes a token or resolves anything on its own
  ([ADR-0023](adr/0023-the-shared-container-is-the-seam.md),
  [ADR-0026](adr/0026-the-share-sheet-may-deliver.md)).
- **No third-party packages.** Adding one needs a decision recorded first. The only one agreed in
  advance is a Markdown parser fallback, described in ADR-0028.

## Concurrency

Every target builds in the Swift 6 language mode, with complete concurrency checking and warnings
treated as errors. The rules the code is written to:

- **Actors own I/O and shared mutable state**: the gateway connection, the credentials, the
  per-gateway transcript store and the SQLite store.
- **Feature models are `@MainActor @Observable`.** Views read them; they do not own state of their
  own beyond what is local to a view.
- **The engine is pure.** Value types and functions, no actors, no clocks, no I/O. That is what makes
  it replayable from the golden corpus.
- **The main actor receives snapshots, not events.** The transcript store applies events off the
  main thread and publishes immutable snapshots to the models, at most one per frame.
- **No Combine and no `ObservableObject`.** Streams are `AsyncStream` or `AsyncThrowingStream`.
- **`@unchecked Sendable` needs a reason.** Write a comment saying why the type is safe, and expect
  the reviewer to read it.

## Building and testing

All three scripts live in `native/apple/scripts/` and run from any directory.

```sh
native/apple/scripts/test.sh                  # swift test for HermieKit
native/apple/scripts/test.sh --filter Core    # extra arguments go to swift test
native/apple/scripts/test.sh --apps           # then generate both projects and build both apps unsigned
native/apple/scripts/generate.sh              # write native/ios/Hermie.xcodeproj and native/macos/Hermie.xcodeproj
native/apple/scripts/generate.sh ios          # one of them
```

- **The Xcode projects are generated.** Change `project.yml` or `native/apple/xcodegen/base.yml`,
  never the `.xcodeproj`, which git ignores. Settings shared by both apps live in
  `native/apple/Config/Shared.xcconfig`.
- **Run `generate.sh` again after pulling or committing.** It writes the build number (the git commit
  count) and the short commit hash into an ignored xcconfig, and the About line shows them.
- **Signing comes from your environment.** Export `HERMIE_TEAM_ID`, or copy
  `native/apple/Config/Signing.xcconfig.example` to `Signing.xcconfig` (ignored) and fill it in. Never
  commit a team id.
- **Archiving** is `native/apple/scripts/archive.sh ios|macos <outdir> [--upload]`;
  [docs/release.md](release.md#native-apps) has its variables, the build number and the version rule.

CI runs the same steps: `.github/workflows/native.yml` runs the package tests and builds both apps
unsigned whenever `native/`, `contract/`, the `transcript`, `gateway-client` or `fake-gateway`
packages, or the workflow itself change.

## Parity with the TypeScript reference

The TypeScript packages are the reference while Android and the browser still run them. The native
port is held to them through `contract/`, which the TypeScript side generates and the Swift side
replays. [contract/README.md](../contract/README.md) is the specification: what each file holds, the
canonical JSON rules a port must follow when it compares, and how each kind of file is replayed.

```sh
npm run golden         # regenerate everything under contract/ from the TypeScript code
npm run golden:check   # regenerate into a temporary directory and fail if contract/ differs
```

Generation is deterministic: running `npm run golden` twice changes nothing.

**When `golden:check` fails in CI.** A change to `packages/transcript`, to the pure functions of
`packages/gateway-client`, or to `packages/fake-gateway` changed observable behaviour. If that was
not intended, it is a regression: fix it. If it was, run `npm run golden`, read the diff under
`contract/` (the summary counts in `contract/README.md` change with it), and commit the regenerated
files in the same pull request as the change that caused them.

**When the native job fails after the corpus changed.** The TypeScript behaviour moved and the Swift
port has not followed. Port the change so the replay passes again. Do not edit anything under
`contract/` by hand to make it pass, and do not change the TypeScript reference to match a port: if
the two disagree, TypeScript is right until it is deliberately changed.

Two things are not covered by recorded data, and need Swift tests of their own:

- **Calls that cannot be recorded**, such as those taking a callback or a non-finite number. They are
  skipped and counted in `contract/README.md`.
- **Stateful code that runs on a clock**: the connection state machine and the token coordinator.
  These are ported by hand with a test clock and a fake transport, using the TypeScript tests as the
  list of cases.

The Swift side replays the corpus in `swift test`: the transcript golden files in
`HermieTranscriptTests` (with a coverage report and minimum coverage per suite), the gateway vectors
in `HermieGatewayTests`, and the wire fixtures in `HermieProtocolTests`. So the native job enforces
the second direction.

## Transcript engine

`HermieKit/Sources/HermieTranscript` is a transliteration of `packages/transcript/src`: one Swift file
per TypeScript module, the same function names, and the comments that explain a rule carried over.
Read the header of `ChatState.swift` before changing the model and the header of `Reducer.swift`
before changing the reducer.

- **The representation is native.** A `ChatState` is an id-keyed `items` dictionary, an `order`
  array and the `by…` indices, as in the TypeScript. Each item kind is a struct, and `TranscriptItem`
  is an `indirect` enum over them, so an item is one pointer and copying a state costs a dozen
  retains. Vocabularies are open enums. Every type keeps the keys it does not know in `extra` and
  writes them back, so a state written by the TypeScript engine, or by a newer Swift one, survives a
  round trip. `subagents` is a `JSRecord` because the TypeScript walks it in insertion order.
- **The core is `inout`, the TypeScript signature is a wrapper.** Every reducer function has an
  in-place form, `applyEvent(into: &state, event, now)`, and the pure form
  `applyEvent(state, event, now) -> ChatState` is a thin wrapper over it. The transcript store
  owns its state and calls the in-place form, so a `message.delta` appends to one string without
  copying anything. The corpus replays the pure forms, and `ReducerBranchTests` checks that the two
  agree. `now` is always an argument; nothing in the engine reads a clock.
- **JavaScript semantics are spelled out.** Strings are compared, measured and sliced as UTF-16 code
  units, and regular expressions are rewritten for ICU. The helpers live once, in
  `Support/JSText.swift` (`JS.trim`, `JS.same`, `JS.nonEmpty`, `JS.truthy`, `JS.localeCompare`,
  `jsStableSorted`, …) and `Support/JSRegExp.swift` (`JSRegExp`, `JSPattern`). Use them rather than
  Swift's `==`, `count` or `trimmingCharacters`, which answer differently.

### The parity gates

`Tests/HermieTranscriptTests/ParityGates.swift` holds the engine to the corpus. It fails the build
unless every suite in `contract/transcript/golden` passes in full, every operation that
`golden-summary.json` records is registered and passes in full, the replay covers exactly
`ParityGates.corpusCalls` calls, no call passes only because `null` and an absent key were treated
alike, and every stream scenario passes with no checkpoint pending. `GoldenReplayTests` prints the
coverage table and writes `.build/golden-coverage.json`.

```sh
native/apple/scripts/test.sh --filter 'ParityGates|GoldenReplay|GoldenStream'
HERMIE_GOLDEN_FILTER='reducer,*/visibleItems' native/apple/scripts/test.sh --filter GoldenReplay
```

**Adding an operation.** When the TypeScript engine exports a new function and its tests call it,
`npm run golden` records the calls and the parity gates fail until the port follows:

1. Port the function under its TypeScript name, in the file of its module.
2. Register it in the golden table of its area,
   `Tests/HermieTranscriptTests/Golden/GoldenOps+<Area>.swift`. The entry decodes the recorded
   arguments with `GoldenArgs`, calls the Swift function and returns its `jsonValue`.
3. Name its owner in `GoldenRegistry.owners`, which groups the coverage report.
4. If the corpus grew, set `ParityGates.corpusCalls` (and `streamCount`, for a new scenario) to the
   new totals in the same commit as the regenerated corpus.

**Branches the corpus does not reach.** The corpus only holds the calls the TypeScript tests make.
`HistoryBranchCases.swift` and the fixture in `ReducerBranchTests.swift` add cases for the branches
the corpus does not reach. Each case keeps its inputs next to the result the TypeScript engine gives
for them. Do not write an expectation by hand. Write the inputs, give the expectation a placeholder
(`"result":null`, or `"expected": null` for a reducer scenario), and let the TypeScript engine fill
it in:

```sh
npm run golden:branch-cases         # rewrite every expectation from the TypeScript engine
npm run golden:branch-cases:check   # fail if any expectation is stale
```

Run it again after a deliberate TypeScript change, and read the diff: a changed expectation is a
behaviour change the Swift side has to follow.

### Rules for the code that drives the engine

The transcript store owns a `ChatState` per chat and feeds it events. The engine is only correct if
the store keeps to these rules:

- **Everything is a value.** Every type in the engine is a `Sendable` value, safe to build, read and
  reduce off the main actor.
- **Copies are cheap and writes after a copy are not free.** Copying a `ChatState` is O(1). The first
  write after a copy was published copies `items` once (a retain per item), and every later write is
  O(1) again. Do not keep `let before = state` across a mutation to compare with, and do not compare
  states with `==`, which walks both. Publish on a dirty flag that the store sets when it applies
  something.
- **One ordered stream.** Gateway events and server requests go through one serial stream into the
  reducer, in the order the gateway sent them. Nothing may `await` between taking an event off the
  stream and applying it.
- **Sessions are the store's job.** The reducer ignores an event's `session_id`, so the store routes
  each event to the chat of its session. The reducer also does not reset the `seq` watermark
  (`lastSeq`) when the runtime session changes. The store has to reset it, or every event of the new
  session up to the old high-water mark is dropped as a replay.
- **Order of the calls.** Apply `session.info` before `applyResumeSnapshot`. Keep `beginLocalTurn`
  or `beginSteer`, then `confirmSubmit`, in sequence for one prompt. Apply `applyProcessCompletion`
  only after the `tool.complete` of the dispatch it completes.
- **`now` is wall-clock milliseconds** (`Date.now()` in the TypeScript), passed in on every call.
- **Persist through `JSONValue`, never `Codable`.** Write a state with `state.jsonValue`
  and `canonicalData()`, and read it with `JSONValue(parsing:)` and `ChatState(decoding:)`. Do not use
  `JSONEncoder` or `JSONDecoder`: they recurse, and a tool result nested 250 levels deep crashes
  Foundation's encoder.

### Known divergences

The port answers like the TypeScript on every input the TypeScript tests use. On malformed or
hostile input it deliberately does not:

- **Dictionary keys** (`items`, the `by…` indices) are Swift `String`s, so two keys that are
  canonically equivalent Unicode but different code units are the same key. In JavaScript they are
  two keys.
- **A fractional `seq`** on an event cannot be stored: `lastSeq` is an `Int`.
- **A clarify's answers** are kept sorted by question id, not in the order the wire listed them.
- **A numeric request id** is stored as its string form. The TypeScript keeps the number.
- **`subagentTree` is at most `subagentTreeMaxDepth` (32) levels deep.** A deeper subagent is listed
  as a root of its own, so a long chain of parent links cannot crash the app through recursion.
- **Counters wrap.** `seq` and `version` are `Int`, and stepping one past `Int.max` wraps around
  instead of trapping. The TypeScript's numbers lose precision there instead.

## Black-box tests against the fake gateway

`HermieIntegrationTests` runs the Swift client against `packages/fake-gateway`, the same stand-in
the Expo tests use (see [the fake gateway in CONTRIBUTING.md](../CONTRIBUTING.md#the-fake-gateway)),
over real sockets. The target is macOS only and runs only when `HERMIE_INTEGRATION=1`:

```sh
native/apple/scripts/test.sh --integration   # needs node and npm ci at the repository root
```

`test.sh` runs them by default when `CI` is set (and fails there if Node or the workspace is
missing); locally they are opt-in, and skipped with a message when `node` or `node_modules` is
missing. `--no-integration` leaves them out. The whole target takes a few seconds.

The helper is `FakeGateway` (`Tests/HermieIntegrationTests/Support`). It starts the CLI
(`node --import tsx packages/fake-gateway/src/cli.ts --port 0 …`) from the repository root, reads
the bound port from the listening line, and keeps everything the gateway prints for failure
messages. `FakeGateway.with(options) { gateway in … }` stops the gateway whatever the body does,
cancellation included: SIGTERM to its PID, then SIGKILL to the same PID after a grace period. A
watchdog loaded before the CLI exits when its stdin closes, so not even a crashed test run leaves a
gateway behind, and `test.sh` checks for leftovers after every run. A suite that only reads shares
one gateway (`@Suite(.fakeGateway(options))`); a test that signs in, rotates or injects starts its
own. The `/__fake/inject`, `/__fake/request` and `/__fake/push` control endpoints have typed helpers
on `FakeGateway`, sent outside the client under test.

What is covered: the probe of each authentication mode, address resolution (ADR-0014), REST with a
session token, native PKCE sign-in without a web view through rotation and revocation on sign-out,
ticket minting, redirect refusal between the gateway and a second local listener, and the plugin
routes. The WebSocket connection (streaming, server requests, reconnect and replay, close codes)
follows with the connection actor. UI smoke tests on the simulator will use a fake gateway started by
the test script on the host.

To try the fake gateway by hand:

```sh
npm run fake-gateway -- --auth token --token demo
```

## Strings and icons

**Icons** are generated, never drawn per size. `design/icon.svg` is the source; `npm run icons`
writes the `AppIcon` sets in `native/ios/App/Assets.xcassets` and `native/macos/App/Assets.xcassets`
along with every other icon in the repository, and `npm run icons:check`, which CI runs, fails when
one has drifted. Do not edit those PNGs or their `Contents.json` by hand.

**Strings** will come from one String Catalog generated by a script from the TypeScript catalogues
(see [docs/i18n.md](i18n.md)), so a sentence is translated once for both generations while the Expo
app is alive. Strings only the native app has will go in a second table. Neither exists yet: the
package declares English as its development language and the placeholder screen has no translated
copy. Until the generator lands, do not hand-write a String Catalog for the shared strings.

The app will follow the system's per-app language setting rather than offering a picker of its own.

## Accessibility

Accessibility is part of a screen being done, not a later pass: labels and custom actions on every
custom row, Dynamic Type up to the largest accessibility size, Reduce Motion respected, the whole
screen usable from a keyboard on iPad and the Mac, and the system accessibility audit passing in the
UI smoke test.

## Notifications

Push on the native apps is not decided here. A separate ADR will cover notifications.
