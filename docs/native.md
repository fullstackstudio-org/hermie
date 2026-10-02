# Working on the native apps

Hermie's Apple apps are being rebuilt natively in SwiftUI, next to the Expo app that still ships.
This page is for contributors to that rebuild: how the code is split, the rules it is written to, how
to build and test it, and how it is kept in step with the TypeScript reference.

The decisions behind it are [ADR-0028](adr/0028-native-apps-on-apple-platforms.md) (the apps and how
they are built) and [ADR-0029](adr/0029-expo-native-and-the-contract-directory.md) (the repository
layout and the parity rule). [native/README.md](../native/README.md) has the directory map and the
milestones.

**Where things stand.** The transcript engine, the gateway client (connection, sign-in, REST), the
stores and the session runtime (`GatewaySession`, `TranscriptStore`, `BotRoster`) are written and
tested; the app shell, the settings and the chat screens are being built.
Anything below that says "will" describes a rule for code that has not been written yet.

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

### The session runtime

`HermieCore` turns one gateway into chats a view can observe. `GatewaySession` (`@MainActor`) owns
the connection, the roster and the `TranscriptStore` actor, and forwards their frames to the
`@Observable` models (`ChatListModel`, `ChatModel`). The store keeps the rules above with one queue
per chat: events in the order the connection dispatched them, server requests and RPC results
placed among them by wire index. A call whose result must follow the chat's frames (resume, replay,
submit) holds that chat's later frames until it answers; a snapshot read (`subagent.list`,
`approval.pending`) holds nothing and is dropped if newer frames were applied first. Before a result
is placed, the store waits until it has taken in up to the connection's `seq` watermarks, so an event
that preceded the answer cannot arrive after it. Snapshots reach the main actor at most once per
frame. `Tests/HermieCoreTests/Runtime` replays the `contract/transcript/streams` scenarios through it.

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

## Transcript list

The chat transcript scrolls in `TranscriptList` (`HermieUI/TranscriptList`). It draws one row per
`TranscriptRow`, and the rows come from `TranscriptItemView` (`HermieUI/Items`). The list is a
boundary (D14 in the native plan). Its public surface is the rows, a `TranscriptListState` (at the
bottom or not, scroll to the bottom or to a row, a callback near the top) and an overlay slot for the
jump pill. None of that says how the list is drawn, so the implementation can be replaced without
touching the item views or the chat screen.

**Decision: the SwiftUI list stays (implementation A).** It is a `ScrollView` over a `LazyVStack`,
bottom-anchored with the iOS 18 scroll APIs. The collection-view representable (implementation B) was
not built: A keeps the anchored row in place on a history prepend and re-renders only the streaming
row on a delta. The one Apple hitch metric it could be measured with passed. One risk is still open,
under [What is still open](#what-is-still-open).

### How it meets the bar

- **Opens at the bottom and follows a growing reply** while the reader is at the bottom, with
  `defaultScrollAnchor(.bottom)`, and with `.bottom` for `.sizeChanges` while `isAtBottom`. Once the
  reader has scrolled away, the size-change anchor is `nil`, so a reply growing below them moves
  nothing.
- **Prepends without a jump.** A `ScrollPosition` bound with `anchor: .top` over a
  `scrollTargetLayout` keeps the row at the top of the viewport where it is when rows are inserted
  above it.
- **A delta re-renders one row.** `TranscriptListRow` is `Equatable` on its item, and
  `TranscriptRow` compares in O(1) on a stamp taken when it is built: the id, the item's `version`, the
  presentation, and whether the selectors took the thought away. This relies on the engine's rule
  that every mutation of an item bumps its `version`.
- **Nothing walks the rows on the main actor.** SwiftUI compares every stored `Equatable` property
  of a view it updates, field by field into structs, and the setter of an `@Observable` property
  compares old and new with `==`. A `[TranscriptRow]` held in either place is walked in full on every
  delta. `TranscriptListItems` puts the array behind one class reference, so both compare a pointer.
  **Hold rows as `TranscriptListItems` in models and views, never as an array.**
- **Rows and their Markdown are built off the main actor.** `TranscriptRowBuilder` runs where
  snapshots are made. It turns `visibleItems` into rows, rolls up runs of more than three bot-to-bot
  rows as `dm-rollup.ts` does, and keeps one `MarkdownDocument` per item. A changed item's document is
  updated incrementally, so a streaming reply re-parses its tail (at most two slices a delta) and
  nothing else. The main actor only assigns the snapshot.
- **Commands go through the same `ScrollPosition`.** After a programmatic `scroll(to:)`, the list
  does not call `onNearTop` until the reader has scrolled; why is under
  [What is still open](#what-is-still-open).

The spike tripped over three things that the code now avoids:

- **Equality.** A deep `VisibleItem ==` in the row's equality, reached through SwiftUI's array
  comparison, cost 5.7 s of a 7.4 s main-thread profile while streaming.
- **A plain array.** With O(1) row equality, an array of rows still cost 0.8 s of 2.4 s through the
  view and `@Observable` comparisons.
- **The lab's own layout.** A report line in the lab wrapped differently after a prepend, changed
  the inset above the list and moved every row by 13 pt. That looked like a SwiftUI bug until it was
  found.

### Numbers

Measured on 2 October 2026 on an M5 Max (18 cores) with Xcode 27.0. The iPhone figures come from an
iPhone 17 simulator (iOS 27.0, 60 Hz), the Mac figures from the Mac's own 120 Hz display. The machine
was running other heavy jobs throughout: the load average was between 2 and 98 over the session, and
each figure below gives the load average it was taken at. The transcript is 2,000 synthetic items
(1,935 rows after the selectors), and a reply streams at 30 deltas per second.

| Measure                                                                   | iPhone 17 simulator                                                  | Mac                                                                                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Row bodies re-evaluated during 600 deltas, other than the streaming row's | 0 of the 24 rows on screen (streaming row: 599)                      | not run on the Mac (same views)                                                                                |
| History prepend of 200 rows after the reader scrolled: Δy of every row    | 0.0 pt (UI test, asserted ≤ 1 pt)                                    | not run on the Mac                                                                                             |
| `XCTHitchMetric` while streaming and scrolling (UI test, 3 iterations)    | no data: the metric records nothing on the simulator                 | 0.000 ms/s, 0 hitches (XCUITest scroll-wheel events; load 10–33)                                               |
| Display-link meter, hands-off bench, 15 s per phase                       | idle 0.00, stream 0.00, pan 2.50, stream + pan 0.00 ms/s (load 4–8)  | idle 1.97, stream 5.00, pan 142, stream + pan 91 ms/s (`-O` build, load 6–10)                                  |
| Display-link meter during the UI test's swipes                            | 75–79 ms/s over two runs (XCUITest snapshots running; load 5–30)     | none                                                                                                           |
| Memory footprint                                                          | 36.5 MB after loading (+19.4 MB for the rows), 60 MB after the bench | 37 MB after loading (+17 MB); 250–275 MB while a long streamed reply is on screen; 60 MB after it scrolls away |

How much to trust them:

- **Simulator numbers.** The simulator renders on the Mac's CPU and GPU at 60 Hz and never reports
  `XCTHitchMetric`. Under load its display-link figures inflate badly: the same build measured
  337 ms/s at a load average of 90, before the fixes, and 0 at a load of 4. Treat them as a smoke
  test only.
- **The display-link meter** (`HitchMeter` in `HermieUI/Debug`) counts frames the main thread
  delivered late. It does not see a frame the render server dropped. The idle phase is its control
  for the machine's own load.
- **The pan** moves the list by setting its `ScrollPosition` every 8 ms, so each step is a full
  SwiftUI transaction. A finger or trackpad moves the scroll view directly and does far less work, so
  the pan is a pessimistic driver. On the Mac at 120 Hz, the main thread misses about one frame in six
  by one refresh (the longest frame is 29 ms). The profile puts that time in SwiftUI's own
  `LazyVStack` placement and display-list update, not in the rows.
- **The Mac's `XCTHitchMetric` run** used XCUITest's discrete 600 pt scroll-wheel steps, which
  animate little, so it is the optimistic bound.

### What is still open

- **Smooth scrolling at 120 Hz is not proven.** Measure on a ProMotion iPhone and on the Mac with
  Instruments, scrolling by hand while a reply streams, before the chat screen ships on this list.
  If it misses 5 ms/s, build the collection-view representable behind the same boundary. Nothing
  outside `TranscriptList` would change.
- **A prepend straight after a programmatic jump.** A `ScrollPosition` that was told
  `scrollTo(id:)` keeps that target and resolves it again on the next content change. A prepend
  forced in that state moved the rows off the screen in the spike. The list avoids the state: it
  holds `onNearTop` back after a command until the reader scrolls. Code that prepends on its own
  initiative must do the same.
- **A long reply streaming on screen holds about 200 MB of GPU memory on the Mac** ("owned unmapped
  (graphics)" in `vmmap`, not the malloc heap). The memory goes with the row once it scrolls away,
  and it does not change when the reply is drawn as plain `Text` instead of Markdown. It comes from
  how SwiftUI renders a tall view that changes 30 times a second. Splitting a long reply into several
  rows would bound it.

### The lab

`TranscriptLabView` (`HermieUI/Debug`, debug builds only) is the spike as a screen. It shows the
synthetic transcript, with buttons to stream, prepend, jump to the middle, run the meter, pan, and
run the render-count test, and a report line under them. `TranscriptItemGallery` shows every item
kind in every presentation, with switches for the colour scheme, AX5 and the width of an iPhone, an
iPad or a Mac window. `DebugScreens.registerTranscriptScreens()` lists both under Settings →
Advanced when the app calls it at launch, and `TranscriptDebugMenu` links both on its own.

The UI tests run against `HermieLab`, a debug-only host app in `native/apple/Lab` with its own
bundle id (`dev.hermie.lab`). It never meets the real app, its keychain group or a gateway.

The accessibility audit runs over the whole gallery, a screenful at a time, at the default size and
at AX5. It fails on any issue except three, which it records instead:

- **Contrast on an element that the scroll view's edge cuts off.** The audit measures it against
  the clip, so the same row failed on one page and passed on the next. A screenful is 0.8 of a page,
  so every element is audited whole on one page or another.

- **The Dynamic Type check.** On Xcode 27 it reports "partially unsupported" for every text,
  including a system `Toggle`'s own label. `TranscriptItemViewTests` covers AX5 instead: it renders
  every sample in every presentation at AX5.
- **"Contrast nearly passed".** This is the system `.secondary` label colour (above 3:1, under 4.5:1),
  which the timestamps and other metadata use. "Contrast failed" still fails the test.

```sh
native/apple/scripts/test.sh --ui        # HermieLabUITests on a throwaway iPhone simulator
native/apple/scripts/test.sh --ui-mac    # the same on this Mac; it drives the pointer while it runs
# the hands-off bench, printed to stderr; the app quits at the end
HermieLab.app/Contents/MacOS/HermieLab -HermieLabScreen lab -HermieLabBench YES \
  -HermieLabBenchSeconds 15 -HermieLabBenchQuit YES
```

The lab reads these launch arguments:

- `-HermieLabItems <n>` sets the transcript size.
- `-HermieLabStream YES` starts streaming at launch.
- `-HermieLabAutoScroll YES` starts panning at launch.
- `-HermieLabAutoPrepend YES` prepends history when the list asks for it.
- `-HermieGallerySample <title>` shows only the gallery samples whose title starts with this.

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
routes, the WebSocket connection, and the session runtime (`SessionRuntimeIntegrationTests`: a cold
start from the cache, a streamed turn, an approval, a socket dropped mid-turn, history paging). UI
smoke tests on the simulator will use a fake gateway started by
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
