# Working on the native apps

Hermie's Apple apps are being rebuilt natively in SwiftUI, next to the Expo app that still ships.
This page is for contributors to that rebuild: how the code is split, the rules it is written to, how
to build and test it, and how it is kept in step with the TypeScript reference.

The decisions behind it are [ADR-0028](adr/0028-native-apps-on-apple-platforms.md) (the apps and how
they are built) and [ADR-0029](adr/0029-expo-native-and-the-contract-directory.md) (the repository
layout and the parity rule). [native/README.md](../native/README.md) has the directory map and the
milestones.

**Where things stand.** The transcript engine, the gateway client (connection, sign-in, REST), the
stores, the session runtime (`GatewaySession`, `TranscriptStore`, `BotRoster`), the sync engine,
setup and sign-in, the app shell, the chat list, the chat screen with its composer and the answers
to what a bot asks are written and tested.
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
| `HermieShareKit`   | Shared         | the share extension's outbox writer and direct send           | Foundation                             |
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
  else** (the share extension also links `HermieShareKit`, its own logic kept in the package so it is
  unit-tested). No extension signs in, refreshes a token or resolves anything on its own
  ([ADR-0023](adr/0023-the-shared-container-is-the-seam.md),
  [ADR-0026](adr/0026-the-share-sheet-may-deliver.md)). See [Extensions](#extensions).
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
- **What an Apple framework calls back into is `nonisolated` or `@Sendable`.** Completion handlers,
  delegate methods and presentation providers may be called on any queue, whatever the protocol's
  annotation says. A closure written inside a `@MainActor` type and passed straight to an
  Objective-C API is inferred to be the main actor's, and Swift 6 checks that at run time: called
  from another queue, it traps (`_dispatch_assert_queue_fail` in `swift_task_isCurrentExecutor`).
  That took the Mac app down in TestFlight 0.2.1, when `ASWebAuthenticationSession` ended a session
  over XPC after "Open in browser". Read what the callback was given into `Sendable` values where
  it arrives and hand the rest to the main actor (`MainActorHop.run`, or a `Task { @MainActor … }`);
  build such a closure in a `nonisolated` function or give its type `@Sendable`, so the compiler
  keeps it that way. A presentation anchor is found on the main thread before the system needs it
  (`WebAuthenticationPresenter`, `ControllerPasskeyDriver`).

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
- **A Debug build is another app.** Every identifier comes from `HERMIE_BUNDLE_ID` in
  `Shared.xcconfig`: `dev.hermie.app` in Release (the archive, TestFlight, the App Store, and the
  Expo build's App IDs, App Group and keychain group), `dev.hermie.app.dev` in Debug (every run from
  Xcode, `test.sh --apps`, the UI tests). The app, `.widgets` and `.share` bundle ids, the App Group
  `group.<root>` and the keychain groups `<team>.<root>` and `<team>.<root>.share` all follow it, in
  `base.yml`, the entitlements and the Info.plists (`HermieAppGroup`, `HermieKeychainGroup`,
  `HermieShareKeychainGroup`), and the code reads the groups from the Info.plist
  (`SharedContainer.appGroup`, `AppGroupContainer.identifier`, `ShareDeliveryPublisher.live`). So a
  dev or test run has its own preferences, sandbox container, data directory, App Group, keychain
  and iCloud Keychain items, and cannot touch an installed Hermie's. `archive.sh` archives Release
  and refuses an archive whose app is not `dev.hermie.app`; `BundleIdentityTests` holds the specs,
  the entitlements and the Info.plists to the rule. The `hermie://` link scheme stays shared
  (whichever build the system picks opens it). A signed Debug build on a device needs its own App
  IDs, which automatic signing registers. It never registers with the push relay
  (`HERMIE_PUSH = NO`, Info.plist `HermiePush`), which serves only the release topic, so it writes
  no push row into the person's section. And passkeys do not work in it: its entitlements still
  name `webcredentials:confirm.hermie.dev`, but that host's association file lists only
  `<team>.dev.hermie.app`, not `.dev`.

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
- **Row identity is ported as its own files.** `Identity.swift` (reading the row, call and turn
  identities off a frame or a row) and `Reducer+Identity.swift` (settling a live item onto its row,
  finding a card by call key) mirror `identity.ts` and the identity branches of `reducer.ts`. The
  fields are optional on every type, and a frame without them takes the paths that existed before.
  The one exception is `message.complete`, which falls back to the receipt's
  `persisted_turn.final_assistant_row_id` (older fork gateways already send it) and so takes the
  identity branch with none of the new fields on the wire (D5).
  `contract/transcript/golden/row-identity.json` and the `interim-reopen*` and `reused-call-ids*` streams record the
  TypeScript behaviour, including a cache saved after every frame of a turn, so a change to the
  identity rules is a golden diff the Swift side has to follow, and `ParityGates.corpusCalls` and
  `streamCount` move with it.

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

A reconnect replay is trusted only when it can vouch for itself. When the connection's own replay
answers `truncated: true` or comes from another gateway process, `GatewayConnection.replayGaps`
reports the session, and when the store's replay in a recovery answers `truncated`, another epoch,
or a cold watermark against a session with numbered events (or the chat came back on another
runtime session), the store reads the chat again: resume and history through the hydration path
(`load`), on the chat's lane with its generation checks, the in-flight turn and open requests
re-applied, the history reconciled onto what is there. The queue and the draft are untouched. A
replay right after a history read needs nothing more. The gateway's ring holds 512 events and 4 MiB
per session (64 MiB and 64 sessions per process).

Beside the transcript the store hands the session a stream of signals the reducer does not read:
`notification.show`/`.clear` go to `GatewayNoticesModel` (keyed, expiring on the session's clock,
bounded, plain text), `connection.request`/`.update` and a resume's `pending_connection` go to
`ConnectionRequestsModel` (one card per chat with its deadline, `https` links only, answered with
`connection.respond`), `session.resume_progress` to `ChatModel.resumeProgress`, and
`background.complete` to `GatewaySession.onBackgroundTaskFinished`. After every connect the session
reads `gateway.capabilities` and asks `/api/auth/me` who it is (`identityState`): a session-token
gateway is anonymous without asking, a signed-in one names `<provider>:<user_id>`, which becomes the
store's own author. `ownAuthorID` is that id only when the gateway advertises `per_message_author`.
Debug builds count the event types this build cannot read (`unknownEventCounts()`).

### The composer and answering requests

`ComposerModel` and `RequestsModel` (`HermieCore`) sit on a chat's `ChatModel` and add nothing to
the session layer's rules. The composer keeps the draft per gateway and bot in the key-value store
(`hermie.chat.draft.<bot>@<gateway id>`, written 400 ms after typing stops and when the screen goes),
sends through `TranscriptStore.send` (a send during a turn is parked in the store's queue, which the
strip shows), stops with `stopTurn`, and routes `/new`, `/reset` and `/clear` to
`startNewConversation`. Every other line, `/` included, goes to the bot as written until slash
commands land. A send refused before anything was painted keeps the draft; one that failed after
the paint leaves the bubble, marked interrupted. The requests model answers approvals with a choice
the request offered and nothing else, asks `approval.pending` first (an approval the gateway no
longer lists is closed with a notice instead of answered), answers through `ChatModel` (whose
`cardNotices` records an answer that did not go out), and keeps an in-flight and a failed state per
request, with Retry. No request in today's contract carries a deadline; `setDeadline` is the seam
for one, and a card with a deadline counts down and closes as a timeout.

The chat screen mounts them with `ComposerView(model:)` in its composer slot and
`.answeringRequests(with:)` on the transcript, which sets the rows' `transcriptItemActions`, the
cards' status (`transcriptRequests`) and the sheet for a pending request.

The one-string prompts (`secret`, `sudo`, `vault.unlock_prompt`, `vault.code`, `vault.save_login`)
never enter the transcript: what a person types for them must not reach the engine, the chat cache
or a draft. `SecureInputCenter` (one per `GatewaySession`, `session.secureInput`) subscribes to the
server requests itself (off the main actor, where the request's texts are cleaned and bounded by
scalars), routes each prompt to the chat whose runtime session it names (waiting at most 15 s for a
resume to bind one; a prompt follows its session to another chat), and answers on the request's own
reply: the value, or `''` for Skip. A prompt whose session no chat holds any more is answered `''`
with a "withdrawn" notice; every prompt still open at shutdown is answered `''`, and the shutdown
waits up to 1 s for those frames to reach the socket. One the gateway stops waiting for (its
deadline: 120 s for `sudo` and `vault.unlock_prompt`, 180 s for `vault.code` and
`vault.save_login`, 300 s for `secret`, counted from the arrival; or its `request.cancel`) is
closed with a notice and never answered. The center hears the live socket only, so what the gateway said while
the socket was down reaches it through the store's recovery (`SessionSignal`): a `request.cancel`
in the `session.events.since` replay closes its prompt as a live one would, and a prompt its
session's `open_requests` (from the resume or the replay) no longer lists closes with a notice that
it ended while the connection was down, nothing sent. One first seen at or after the moment just
before that call went out (on the session's monotonic clock) is kept, since it may be newer than
the list, and an answer without the list changes nothing. The gateway leaves an empty list out of a resume,
so after a reconnect it is usually the replay's list that decides. A known gateway gap: with turn
isolation, its `_open_requests` can leave out a request that is still open (a second child
request), and the app then says the prompt ended while the bot waits out its deadline. An answer is "sent" once its frame is queued, so a socket
that dies before the gateway read it loses it; the gateway's re-delivery of a request already
closed here (for any reason but its `request.cancel`) is the proof, and the prompt opens again
saying the earlier answer did not arrive. The typed value lives in the sheet's state as a
`SecretValue`, whose description and mirror are redacted, and goes out as a `ValueResult`. The
sheet never takes the keyboard by itself: a field is focused by the person, after a 400 ms guard.
Every other server request (but `confirm` where a passkey model listens, below) is refused `-32601`
("not supported by this client") by the connection,
which still hands it to the center so the chat can say the bot asked for something the app cannot
show. The chat screen mounts it with `.secureInput(SecureInputModel(session:bot:))`; the chat list
reads `session.secureInput.needsInput(bot)` for its marker.

`LiveGateway` (`HermieCore/LiveGateway.swift`) is the app's one live session (ADR-0024). The app
shell builds it next to `GatewayAccounts`; it follows the registry's active gateway once
`AppLaunch.start()` has finished (`AppLaunch.ready`), shuts the old session down before it builds
the next, and never writes the registry or a credential. It loads credentials only through
`GatewayAccounts.access(for:)` (the sync engine's `storedCredentials(of:)`) and takes a native
gateway's token coordinator from `GatewayAccounts.coordinator(for:)`, the one per gateway. A
gateway with nothing to sign in with, or whose credentials still belong to an origin it moved away
from, is `signedOut`. It rebuilds the session when the gateway's `credentialsRevision` moves (a
sign-in, a sign-out, a removal) and sets `GatewayAccounts.endSession`, so a sign-out or a removal
ends the socket first.

### Attachments

The composer's "+" (a menu on iPhone and iPad: Photo Library, Camera where there is one, Files; the
file picker on the Mac) also takes files dropped on the composer and files or pictures pasted into
the field. The rules are the web client's (`native/web/src/core/chats/attachments.ts`):

- **Two roads.** An image the gateway reads by its extension (`png jpg jpeg gif webp bmp tiff tif`)
  goes as base64 over the socket (`image.attach_bytes`, 25 MiB) before `prompt.submit`, and is
  never named in the prompt. Anything else (an SVG, a HEIC, a PDF, a movie) is uploaded over HTTP
  when it is staged (`POST /api/files/upload-stream`, 100 MiB) to
  `<cwd>/uploads/hermie/<date>/<token>-<name>`, and named in the prompt by its `@file:` reference.
  With no working directory (`info.cwd` of the resume, or `/`) the upload is refused on its chip
  rather than aimed at the root of the gateway's machine.
- **Staging.** What is picked, dropped or pasted gets a chip at once (`AttachmentTray.prepare`),
  marked preparing, so `canSubmit` is false from the first moment; the copy into
  `<tmp>/hermie-attachments/<uuid>/` (`AttachmentStaging`) runs off the main actor and reads the
  source's size first, so a file over its road's cap becomes a failed chip with no copy made. The
  copy then goes to `AttachmentTray.provide`, which starts it on its road, or deletes it when the
  chip is gone by then (removed, or the chat was left: `ChatFeed.stop` clears the tray). Copies
  older than a day are swept at launch.
- **Sending.** The send waits until every chip is ready. The attachments are taken out of the tray
  in the same synchronous step that clears the draft (`take()`), so a second Return or tap finds
  nothing and cannot send them twice (HERM-126); a send refused before it was painted gives them
  back. A message parked behind a running turn keeps them (`TranscriptStore.queuedOutgoing`) and is
  not steerable, since an image cannot ride into a running turn.
- **The camera is a sheet.** A full-screen cover fires the chat's `onDisappear`; when that still
  stopped the feed, it emptied the tray and closed the session under the photo about to land in it.
  The photo is re-encoded from its pixels (`UIImage.jpegData`), which leaves no metadata.

#### Location in library photos

A photo from the library names the place it was taken (EXIF GPS) and often the place's name (IPTC
and XMP city, region, country, sub-location). The agent never needs it and the gateway may be
someone else's machine, so a library photo leaves without it (`AttachmentPrivacy`):

- A format the gateway takes as an image is **copied** with ImageIO
  (`CGImageDestinationCopyImageSource`, `kCGImageMetadataShouldExcludeGPS`, and the XMP place tags
  merged in as removed). That is not a re-encode: the pixels are the original's and a JPEG is not
  compressed a second time. What was copied is read back, and a copy that still names a place is
  discarded.
- A PNG, TIFF or BMP whose copy would keep its location (ImageIO does not apply the edit to them) is
  written again as the same lossless format, carrying the orientation and nothing else.
- A HEIC, or anything the gateway would not take as an image, becomes a JPEG (quality 0.9) with the
  orientation only. The Photos picker is asked for what the library holds (`.current`), not for the
  system's own transcode, so a movie is not re-encoded to be picked.
- A **movie is sent as it is**: its metadata, including a location track, is not touched.
- A picture picked in Files, dragged in or pasted is sent as the reader chose it, unchanged.

Tests: `AttachmentPrivacyTests` (a fixture with GPS, IPTC and XMP places, before and after),
`AttachmentTrayTests`, `AttachmentSendTests`, `HTTPClientUploadTests` and the fake-gateway
`AttachmentIntegrationTests`.

### Confirm at level passkey

A `confirm` request at level `passkey` is one the gateway verifies itself: the app answers with a
WebAuthn assertion over a challenge that commits to the gateway's base URL and id, the session, the
request, a fresh nonce and the exact text shown. The construction, the wire objects and the order
of the gateway's checks are `contract/confirm-passkey/README.md`. What the app does, by layer:

- `HermieProtocol` (`Methods/ConfirmTypes.swift`, `REST/PasskeyRESTTypes.swift`): the `confirm`
  params and result (`ConfirmResult.confirmed(_:)` and `ConfirmResult.declined`, the only two answers
  at this level; there is no way to set `verified`), the `confirm_passkey` capability block and the
  second call's advertisement, `RequestCancelReason` with `too_many_attempts` and
  `verification_failed`, `passkey.changed`, and the six `/api/auth/passkeys` bodies. Anything that
  carries a code or an assertion has a redacted description.
- `HermieGateway`: `PasskeyChallenge.swift` (base64url, the base URL of contract §3 from the stored
  gateway address through `GatewayAddress.passkeyBaseURL(of:)`, the text digest, the challenge,
  enrolment-code canonicalisation). The challenge is computed from a `ConfirmDisplay`, the value the
  confirm sheet renders and nothing else: a signature over text T exists only if the app showed T.
  `PasskeyClient` calls the routes through the gateway's `HTTPClient` (a bearer sends no `Origin`)
  and reads a refusal's `error` and `reason`; a 429 is `rateLimited` with the seconds of its
  `Retry-After`, a 403 `origin_not_listed` is `originNotListed` (the gateway does not list the
  address the app dialed, or a cookie caller's `Origin`). `ConfirmCapabilities.swift` is the
  two-step `client.capabilities`: with `GatewayConnection.Options.confirm` set, the connection sends
  the second call only when the first result allows it, advertises `passkey` only when the level is
  enabled, the build's RP is listed for its kind and a credential for that RP is known here,
  and runs both calls again on `refreshCapabilities()`. Every call replaces the advertisement at the
  gateway, so a refresh's first call repeats what the socket advertised and its second call
  withdraws it when there is nothing left to offer. The gateway hides a gated request from a
  connection that has not advertised its level, and the reconnect replay asks before the second
  call has: once a socket gains `passkey`, the connection reads the open requests of every session
  it resumed or replayed again (`session.events.since`, its events not dispatched). Without a
  source it makes the one call it always made and answers every `confirm` `-32601`.
- `HermieCore/Passkey`: `PasskeyAuthenticator` is the seam the system passkey sheet fills (one
  ceremony at a time, `allowCredentialIDs` never empty, a dismissed sheet is `cancelled` and sends
  nothing). `SoftPasskeyAuthenticator` is the test double (CryptoKit, ES256, attestation `none`, a
  counter for a device-bound passkey, knobs to tamper with); it lives in the `HermiePasskeyTesting`
  target under `Tests/`, which no product lists and only test targets depend on, so no app links
  it. `PasskeyModel` (`session.passkeys`, built when `GatewaySession.Options.passkey` is set) reads
  the frames, enrols with a one-time code, mints an invite and revokes with a step-up, keeps the
  credential list and the advertising policy current, and pins the gateway's `gateway_id` per
  stored gateway on the first successful enrolment, with the credential ids it has seen
  (`KeyValuePasskeyPins`, one key per stored gateway, `hermie.passkey.pins@<id>`, purged with the
  gateway's namespace). A record that cannot be read is reported (`pinUnreadable`), never written
  over, and keeps passkeys off for that gateway.

The model's rules: every answer goes through `request.answer`, so a refusal comes back (4033, 4034
with `data.reason`, which leaves the request open for another try until the fifth refusal). `ok` is
"received and valid" (`PasskeyConfirmPhase.received`), never "confirmed": the gateway commits it next
and says `request.cancel {reason: "verification_failed"}` when that fails, which is the one reason
that overrides a received answer. A decline is exactly `{decision: "declined", method: "tap"}`. When
the ceremony cannot run here (no credential on this device, no RP in this build, the platform
refuses), the frame gets error 4040 with `data.reason`. A frame without a credential for the
build's RP, with an unknown `v`, or whose `gateway_id` differs from the pinned one is refused with
4040 and leaves a `PasskeyNotice`; so does a capability that breaks the pin, and a `passkey.changed`
or a list read that shows a credential this device did not add. The allow list must share an id with
the credentials this device has seen on the gateway, and ids pinned for another stored gateway are
never offered (`no_credential` otherwise). The other gateways' pins are read again before every
check, since another session may have pinned meanwhile. Nothing from a frame, an assertion or a code
is logged.

A `gateway_id` pinned for another STORED gateway is usually one gateway stored twice (a LAN address
and a public one, both in `confirm.passkey.base_urls`), not an impersonation: the frame is refused
until the person answers the notice `sameGatewayAs(storedGatewayID:name:)`, whose action "same
gateway as <name>" is `PasskeyModel.linkPins(with:)` (this gateway takes that `gateway_id` and its
credential ids, and records the link so neither side reads the other as a conflict again). A
`gateway_id` pinned for no gateway in the list stays a refusal (`gatewayIDConflict`).

A withdrawal during the ceremony ends the confirmation before the authenticator is cancelled, so a
ceremony returning in that window sends nothing. A confirmation past its `expires_at` ends locally as
timed out (`PasskeyConfirmation.isActionable(at:)` for the sheet's buttons). A `plain` request is
declined `-32601` until the app has a sheet for it, whatever `PasskeyConfiguration.plain` says.

The detail is shown as the gateway sent it, monospaced with every space and line break kept; the
sheet renders `ConfirmDisplay` and nothing else. Its host includes the path prefix of a gateway
served under one, and so does the name of a new passkey. Black-box coverage is
`ConfirmPasskeyIntegrationTests` against the fake gateway's `--auth native --passkey`.

For CP-10 (the sheet and settings): render the title, the summary and the detail with
`Text(verbatim:)`, never through a `LocalizedStringKey`, which would read Markdown in text the
gateway sent and show something else than the text the signature commits to.
The sheet also owns the states the model now types for it: `sameGatewayAs` (its link action),
`pinUnreadable`, `PasskeyRouteError.Kind.rateLimited` (with `retryAfter`) and `.originNotListed`.

#### The system passkey sheet (CP-9)

`SystemPasskeyAuthenticator` (`HermieCore/Passkey/System/`) is the app's `PasskeyAuthenticator`:
`ASAuthorizationController` with `ASAuthorizationPlatformPublicKeyCredentialProvider`, a fresh
controller per ceremony, shown over the key window of the scene in front
(`HermieUI/App/PasskeyPresentation.swift`). A registration asks for user verification
(`.required`), attestation `none`, the name the model built (`<display name> — <gateway host>`, plan
P3, which the system sheet shows), the gateway's user handle, and excludes the credentials the
gateway already holds for the user. An assertion asks for user verification and always sets
`allowedCredentials` from the request; an empty list is refused before any sheet. The controller
sits behind `PasskeyAuthorizationDriver`, so the rules are tested without the system
(`SystemPasskeyAuthenticatorTests`). Only the platform error's domain and code are read; the text
the platform wrote is never passed on.

| What happens                                                                             | The model gets                                                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| a second ceremony while one runs (any gateway, register or assert)                       | `busy`, no second sheet                                                                               |
| `cancel()` (a `request.cancel` withdrew the request)                                     | the sheet is dismissed and the ceremony ends `cancelled` at once; the system's late answer is dropped |
| the person dismisses the sheet (`ASAuthorizationError.canceled`)                         | `cancelled`: nothing is sent, the app's sheet stays                                                   |
| an empty allow list                                                                      | `noCredential` (4040 `no_credential`), no sheet                                                       |
| an empty RP                                                                              | `unavailable(rp_not_configured)`, no sheet                                                            |
| `.notInteractive`                                                                        | `unavailable(not_interactive)`                                                                        |
| `.deviceNotConfiguredForPasskeyCreation`                                                 | `unavailable(device_not_configured)`                                                                  |
| `.matchedExcludedCredential`                                                             | `failed`: this provider already holds a passkey for the account                                       |
| `.unknown`, `.invalidResponse`, `.notHandled`, `.failed`, another domain                 | `failed("… (<domain> <code>)")`, retryable                                                            |
| a signature by a credential the request did not allow, or no window to show the sheet in | `failed`, retryable                                                                                   |

The platform has no error of its own for "none of these passkeys is here": with
`allowedCredentials` set the sheet offers a nearby device instead (**unverified** on a device; no
security-key request is made, plan P14), and the person dismissing it is `cancelled`. `noCredential` therefore comes from the model (the allow list does not
meet what this device has seen) and from an empty list.

**The RP is a build setting.** `HERMIE_PASSKEY_RP_ID` in `native/apple/Config/Shared.xcconfig`
(default `confirm.hermie.dev`, which serves the association file for `<team>.dev.hermie.app`)
becomes both apps' `com.apple.developer.associated-domains` entry `webcredentials:<RP>` and the
Info.plist key `HermiePasskeyRPID`, which `PasskeyConfiguration.live()` reads at launch (a value
that is not a host name reads as no RP). A build that sets it empty signs with
`App/Hermie-NoPasskey.entitlements` instead (the same file without the associated domain; the
project picks it through `HERMIE_ENTITLEMENTS_SUFFIX`), gets `PasskeyConfiguration(rpID: nil)` and
never advertises `passkey`. No extension declares an associated domain.
`PasskeyBuildSettingsTests` parses the xcconfig, both apps' entitlements and Info.plist, both
project specs and every extension's entitlements to keep it so. The unsigned CI build
(`CODE_SIGNING_ALLOWED=NO`) does not process entitlements, as with push.

**The lock.** The authenticator is wrapped in `LockGuardedPasskeyAuthenticator`, which calls
`AppLock.ceremonyBegan()` before and `ceremonyEnded()` after every ceremony. While one runs,
`AppLock` reads the lifecycle as it does under its own prompt (plan P10): a resign is the sheet's
and does not re-lock, a real departure (the background on iOS, a hidden app on the Mac) still
counts, a return from one is judged once the sheet is gone, and no automatic unlock prompt is
raised under the sheet. The guard sits on the authenticator rather than on
`PasskeyConfirmPhase.signing` because enrolment, invites and revokes run a ceremony without a
confirmation, and a withdrawn confirmation leaves `.signing` before the sheet has closed.

**The wiring.** `LiveWiring.app` (the shell's) sets `AppLaunch.passkey` once to
`PasskeySetup.live(configuration: .live(), authenticator: SystemPasskeyAuthenticator(...), lock:,
keyValues:)`: one authenticator for every gateway, the lock guard around it, and the pins in the
launch's database (`KeyValuePasskeyPins`). `LiveGateway.accountsConnector` hands it to every session
it builds (`GatewaySession.Options.passkey`). Unit tests and previews leave it `nil` (no `confirm`
level); the app's UI-test launches go through the shell and get the system sheet too, so a UI test
that drives a ceremony needs a launch hook of its own first.

**On a real device** (nothing above can be shown in the simulator or in CI; record the results with
the CP-1 vectors):

1. The association resolves through Apple's association CDN for a TestFlight build on iOS and on
   macOS (the CDN's copy for `confirm.hermie.dev` lists the app id).
2. Enrol with a one-time code: iCloud Keychain creates the passkey, the system sheet names it
   `Hermie — <gateway host>`; repeat with Bitwarden as the provider on iOS and on macOS.
3. Confirm a `passkey` request: the gateway accepts the assertion. Note the value of
   `clientDataJSON.origin` for an app-initiated ceremony (expected `https://confirm.hermie.dev`,
   **unverified**), the flags (UV, BE, BS) and the signCount per provider.
4. Decline from the app's sheet: no system sheet, `declined` at the gateway.
5. Cancel from the system sheet: nothing is sent, the app's sheet stays and Confirm works again.
6. `request.cancel` while the system sheet is up (let it time out, or answer on another device): the
   system sheet closes.
7. App lock at "immediately": the system sheet does not re-lock the app; sending the app to the
   background during the ceremony does.
8. Assert from a nearby device (hybrid), and with a passkey that is not on this device (what the
   sheet offers; dismissing it is `cancelled`).
9. A second Apple device on the same iCloud account confirms with the synced passkey without
   enrolling.
10. Enrol again on a device that already holds the gateway's passkey: the excluded credential
    (`.matchedExcludedCredential`) or a second passkey, whichever the platform does for an app.

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

There are two implementations behind it, and `TranscriptListImplementation` picks one at run time:

- **A, `swiftUI`**: a `ScrollView` over a `LazyVStack`, bottom-anchored with the iOS 18 scroll APIs
  (`SwiftUITranscriptList.swift`).
- **B, `collection`**: a `UICollectionView` on iPhone and iPad, an `NSCollectionView` on the Mac, with
  the same SwiftUI rows in its cells (`CollectionTranscriptList+UIKit.swift`, `+AppKit.swift`, and the
  shared `TranscriptListLayoutModel`).

**Decision: B on iPhone and iPad, on every iOS version the app supports; A on the Mac for now.**

- **iOS 26.x breaks A.** A history prepend moved the anchored row on every run on the iOS 26.5
  simulator, and a bar under the list that grows by 160 pt (the composer gaining lines) moved every
  row of a reader who had scrolled up by 91 pt. SwiftUI keeps the anchor in a `ScrollPosition`, and
  there is no way to correct it from outside. B moves nothing in either case, on iOS 26.5 and 27,
  iPhone and iPad (the table below).
- **B on 27 as well.** A keeps the place on a prepend and under a growing bar on iOS 27, but
  portrait to landscape and back moved every row of a scrolled-up reader by 208 pt on an iPhone
  with iOS 27. B moves nothing there on any of the four. One implementation per platform is also
  one set of bugs.
- **The Mac keeps A** until B is measured there as thoroughly as on iOS. B passes the hands-off
  bench and its prepend check on the Mac, and scrolls with far fewer late frames. But it is slower
  while a reply streams at the bottom, it keeps the memory of a long streamed reply after it scrolls
  away, and the Mac UI tests (which drive the real pointer) and text selection inside rows have not
  been run against it. See [What is still open](#what-is-still-open).
- **A is not deleted:** the Mac uses it, and the lab compares the two.

The chat screen's transcript (`ChatTranscript`, under [The chat screens](#the-chat-screens)) is a
`TranscriptList` too, so it gets B on iPhone and iPad without a change of its own.

In debug builds `-HermieListImplementation swiftUI|collection` forces one implementation, the lab
has a switch for it, and `TEST_RUNNER_HERMIE_LIST_IMPLEMENTATION` runs the UI tests against one.

### How B works

- **One layout model on both platforms.** `TranscriptListLayoutModel` holds every row's height
  together with the width it was measured at, the rows' tops as running sums, and the anchor rule.
  The anchor is the first row whose bottom is below the top of the viewport, and that row's distance
  from it. A height change above the anchor moves the content offset by the same amount, so nothing on
  screen moves. While the reader is at the bottom, the bottom stays instead.
- **Rows are measured before they are shown.** UIKit's self-sizing is not used: it asks a cell for its
  size on every invalidation, and its answers vary by a point or a line between passes, which moved
  rows on screen for no reason. Instead, an off-screen `UIHostingController` (`NSHostingController`)
  measures a row at the list's width, synchronously, before the row comes within 400 pt of the
  viewport. This happens in the layout's bounds-change invalidation (which carries the offset
  correction), and in the coordinator's own flows: loading, a structural change, a resize.
- **Rows take their ideal height.** A row is `fixedSize(vertical)`, so its height depends only on the
  width. A row whose content changes reports its new height through `onGeometryChange`. The report
  is applied on the next turn of the main queue, because inside a layout pass an invalidation is not
  acted on. The anchor is taken before the change and put back after it.
- **Structural changes are batch updates.** Rows added or removed above or below are a
  `difference(from:)` applied with `performBatchUpdates`. Rows on screen keep their cells, so they are
  neither measured nor rendered again. More than 600 changes reload instead. A delta to the same
  rows reconfigures only the changed cells on screen.
- **Only the rows on screen are drawn.** Prefetching is off: a prefetched cell renders its row
  whether it is shown or not. In the chat screen's UI test, a row the stream had not changed was
  rendered in a prefetched cell and then again in the cell that showed it (the stack traces showed
  both). A reply that streams below the reader is drawn when it comes into view; A keeps drawing it
  frame after frame.
- **Resizes keep the reader's row.** When its frame changes, a collection view moves its own offset
  (by 166 pt when an iPad turns) and may measure rows at the new width, both before it lays out. So
  the list reads the reader's place as the frame is about to change, from the offset and heights the
  reader saw. At a new width every row is measured again, starting with the ones around that row.
- **Keeping the bottom measures on the way.** Rows that come into view when the list scrolls itself
  to the bottom are measured, and the bottom is kept again, until nothing changes. The layout gives
  no offset correction to an offset the coordinator sets itself; without this, a growing bar left
  the newest row 123 pt under it on an iPad.
- **The composer is a content inset.** The host measures the safe area the list is given (the bars,
  the keyboard, the composer) and hands it to the collection view as content insets. Rows scroll
  under the bars, and a growing composer either keeps the bottom or moves nothing. The collection
  view ignores every region of the safe area, the keyboard's included: with the keyboard also
  shortening its frame, the keyboard was counted twice and a keyboard's height of empty list stood
  between the newest row and the composer.
- **Cells have no safe area.** A cell passing under the header or the composer lies in the window's
  safe area, and the row hosted in it honoured that: it was laid out inset by the part of the bar it
  was under, pushed down over the next row under the header, pushed up under the composer, while the
  layout had placed the cells correctly. `TranscriptHostingCell` reports a zero safe area. This was
  the rows drawn over each other in the owner's screenshots, and the reader's row moving 154 pt in
  `testRotatingKeepsTheReadersPlace` (landscape has another top inset).
- **The header blurs what passes under it.** The collection view is not a view controller's own
  scroll view, so the navigation bar's scroll-edge effect ignored it and the transcript was drawn
  through the status bar and the header pills. The view names itself the hosting controller's top
  content scroll view (`setContentScrollView(_:for: .top)`) and sets a soft top edge. The effect
  does not read the offset again when the bar takes the scroll view up, and a chat opens scrolled to
  its end within those moments, so the edge is hidden and shown again a moment after the view joins
  its window (`refreshTopEdgeEffect`); without that the effect stayed at zero until the first drag.
  The SwiftUI list gets the same soft edge from `scrollEdgeEffectStyle`. To see it by hand:
  `-HermieUITest YES -HermieSeedICloudGateway 'Name|url|token' -HermieOpenURLWhenReady
'hermie://chat/<bot>'` (the link waits for the synced gateway; `-HermieOpenURL` runs at launch,
  before it exists).
- **Pinned means following** (`ListPinning`). A `.bottom` command (the reader's send, the jump pill)
  pins the list. Every offset change outside the list's own updates is the reader's and decides:
  their finger, and the scrolls the system runs for them (keyboard paging, VoiceOver's three-finger
  scroll, scrolling to a focused element, a tap on the status bar). Only the list's own animated
  scroll is told apart: its end puts the bottom back exactly instead of reading `isAtBottom` (which
  a bubble arriving during the animation had made false, so the reply streamed below the composer).
  `isAtBottom` is "pinned, or within the threshold", so the pill does not flash between a row growing
  and the offset following it.
- **Heights go stale, and are measured again.** A row that changes while off screen keeps its height
  as an estimate and is measured again before it is shown (`invalidate`), in both the delta and the
  structural path: a row's height depends on its neighbours (a bubble's tail and time, the date line,
  a tool group taking in a call). A text size change forgets every height. A cell's row carries
  `.id(item.id)` (`TranscriptRowReporting`), so a reused cell reports its new row's height even when
  it equals the previous occupant's.
- **An anchor whose row is gone** (a prepend that renames a tool group) is replaced by the nearest
  row still there, kept within the content (`TranscriptFollow.survivor`, shared with the SwiftUI
  list, which checks the row it is anchored to on every snapshot).
- **Each cell keeps its own accessibility and display scale.** The rows get the list's environment,
  except `accessibilityEnabled` and `displayScale`, which come from the cell
  (`RowEnvironmentBridge`). With the list's stale values, the rows were missing from the
  accessibility tree until the reader scrolled.

### How A meets the bar

- **Opens at the bottom and follows a growing reply** while the reader is at the bottom, with
  `defaultScrollAnchor(.bottom)`, and with `.bottom` for `.sizeChanges` while `isAtBottom`. Once the
  reader has scrolled away, the size-change anchor is `nil`, so a reply growing below them moves
  nothing.
- **Following is decided from what moved the content** (`TranscriptFollow`), not from one geometry
  update. A bubble taller than the threshold grows the content before the anchor moves the offset,
  and deciding from that update switched the anchor off: the bubble and the reply stayed below the
  composer. Now only an offset change nothing else explains (a drag, a fling, the wheel, the
  keyboard, the scroller) changes it; the list's own animated scroll and the rows growing do not.
  When rows are removed or replaced while following (a reconcile that moved rows), the list goes
  back to the bottom: the lazy stack otherwise kept the id of a row that was gone and drew an empty
  viewport.
- **Prepends without a jump, on iOS 27 and the Mac.** A `ScrollPosition` bound with `anchor: .top`
  over a `scrollTargetLayout` keeps the row at the top of the viewport where it is when rows are
  inserted above it. On iOS 26.x it does not (above).

The next three hold for B as well; its cells host the same `TranscriptListRow`.

- **A delta re-renders one row.** `TranscriptListRow` is `Equatable` on its item, and
  `TranscriptRow` compares in O(1) on a stamp taken when it is built: the id, the item's `version`, the
  presentation, and whether the selectors took the thought away. This relies on the engine's rule
  that every mutation of an item bumps its `version`, which `VersionContractTests` holds the port
  to: it replays every recorded engine call and every stream scenario and fails when a visible item
  changes between two states without a new version. `seq` alone may change (a tail reconcile
  renumbers it); no row draws it.
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

Measured on an M5 Max (18 cores) with Xcode 27.0: A on 2 October 2026, B (and A again, beside it) on
3 October. The simulators run at 60 Hz: an iPhone 17 and an iPad (A16) on iOS 26.5 and on iOS 27.0.
The Mac figures come from the Mac's own 120 Hz display. The machine was running other heavy jobs
throughout, so every figure gives the load average it was taken at. The transcript is 2,000 synthetic
items (1,935 rows after the selectors), and a reply streams at 30 deltas per second.

| Measure                                                                   | A, iPhone 17 simulator (iOS 27)                                                                                                       | B, simulators (iOS 26.5 and 27, iPhone and iPad)                                                                                                                                  | A, Mac                                                                                                                                                                                          | B, Mac                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Row bodies re-evaluated during 600 deltas, other than the streaming row's | 0 of the 24 rows on screen (streaming row: 599)                                                                                       | 0 of 25–30 (iPhone) and of 39 (iPad) rows on screen, streaming row 600 (load 5–34); on the iPad with 26.5 the first row of the transcript, off screen, was drawn 12 times (below) | not run on the Mac (same views)                                                                                                                                                                 | not run                                                                                                                       |
| History prepend of 200 rows after the reader scrolled: Δy of every row    | 0.0 pt (UI test, asserted ≤ 1 pt); on iOS 26.5 it fails every run                                                                     | 0.0 pt on all four, after a scroll and straight after a scroll command (UI test; load 8–63)                                                                                       | not run on the Mac                                                                                                                                                                              | 0.00 and 0.47 pt (bench; load 8–30)                                                                                           |
| A 160 pt bar under the list grows (UI test)                               | iOS 26.5: every row of a scrolled-up reader moved 91 pt; iOS 27: 0 pt (load 23)                                                       | scrolled up: 0 pt on all four; at the bottom the newest row ends on the bar (load 8–63)                                                                                           | not run                                                                                                                                                                                         | not run                                                                                                                       |
| Portrait, landscape, portrait while scrolled up (UI test)                 | iOS 27: every row moved 208 pt (load 23)                                                                                              | 0.0 pt on all four (load 5–90)                                                                                                                                                    | not applicable                                                                                                                                                                                  | not applicable                                                                                                                |
| `XCTHitchMetric` while streaming and scrolling (UI test, 3 iterations)    | no data: the metric records nothing on the simulator                                                                                  | no data (same reason)                                                                                                                                                             | 0.000 ms/s, 0 hitches (XCUITest scroll-wheel events; load 10–33)                                                                                                                                | not run: the Mac UI tests drive the real pointer                                                                              |
| Display-link meter, hands-off bench, 15 s per phase                       | idle 0.00, stream 0.00, pan 2.50, stream + pan 0.00 ms/s (load 4–8); again on 3 October: 0.00, 0.00, 4.48 and 5.93, 0.00 (load 17–52) | iPhone 27, three runs: idle 0.00, stream 0.00, pan 0.00, stream + pan 0.00 ms/s (load 4–52)                                                                                       | 2 Oct: idle 1.97, stream 5.00, pan 142, stream + pan 91 ms/s (load 6–10). 3 Oct, two runs: idle 1.06 / 0.91, stream 51 / 47, pan 286 / 270, stream + pan 492 / 559 (load 8–31). All `-O` builds | two runs: idle 0.89 / 1.09, stream 95 / 93, pan 38 / 47, stream + pan 34 / 339 ms/s (`-O` build; load 8–31)                   |
| Display-link meter during the UI test's swipes                            | 75–79 ms/s over two runs (XCUITest snapshots running; load 5–30)                                                                      | iPhone 154–171 (26.5) and 163–200 (27); iPad 39–64 (26.5) and 89–128 (27) ms/s over two to three runs each (load 5–34)                                                            | none                                                                                                                                                                                            | none                                                                                                                          |
| Memory footprint                                                          | 36.5 MB after loading (+19.4 MB for the rows), 60 MB after the bench                                                                  | 32–33 MB after loading (+14 MB), 49–51 MB after the bench (iPhone 27); 150–233 MB at the end of the UI test's swipes while a reply streams                                        | 37 MB after loading (+17 MB); 250–275 MB while a long streamed reply is on screen; 65–75 MB after it scrolls away                                                                               | 39 MB after loading (+18 MB); 265–275 MB while a long streamed reply is on screen, and still 270–280 MB after it scrolls away |

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
- **B's meter during the UI test's swipes** is two to three times A's, while B's hands-off bench is
  at zero. The difference is XCUITest: every snapshot it takes walks the collection view's
  accessibility tree, which makes and lays out cells (a cell for the first row of the transcript too),
  and the meter counts that time. The bench drives the same list with nothing reading it. On a
  device, measure with Instruments.
- **The bench's pan** reaches B through `updateUIView` (`updateNSView`), which sets the collection
  view's content offset; for A each step re-resolves the `ScrollPosition` and the lazy stack (above).
  Neither is a finger, and A's driver costs more, so the pan columns favour B; streaming compares
  like for like.
- **The Mac's numbers on 3 October** are far worse for A than on 2 October at a similar load, so the
  two days do not compare. Compare A and B within a day.

### What is still open

- **Smooth scrolling at 120 Hz is not proven** for either implementation. Measure on a ProMotion
  iPhone and on the Mac with Instruments, scrolling by hand while a reply streams, before the chat
  screen ships on this list.
- **B on the Mac** before it becomes the Mac's default:
  - It is about twice as slow as A while a reply streams at the bottom (93–95 against 47–51 ms/s).
    Not profiled yet. The likely cost: the streaming row reports a new height on most deltas, and
    each report invalidates the layout and keeps the bottom.
  - The memory of a long streamed reply stays after the reply scrolls away (270–280 MB against A's
    65–75 MB). What holds it was not found; the item the collection view keeps for reuse, with its
    hosting controller, is the first suspect.
  - The Mac UI tests and text selection inside a row have not been run against it: the Mac UI tests
    drive the real pointer and were not run unattended.
  - The bench's prepend logged a layout query for an item index past the end while the batch update
    ran (AppKit ignored it).
- **The first row is drawn for accessibility.** With an accessibility client attached (XCUITest, and
  presumably VoiceOver), UIKit asks the collection view for its first element, and the collection
  view makes and renders a cell for the first row of the transcript, far off screen. On the iPad
  with iOS 26.5 that happened 12 times during the render test's 600 deltas; the lab reports it apart
  from the rows on screen. The test does not query the app while the deltas run, so the queries
  come from the accessibility runtime itself, perhaps prompted by the growing content; that was not
  established. No other configuration showed it.
- **A prepend straight after a programmatic jump** (A only). A `ScrollPosition` that was told
  `scrollTo(id:)` keeps that target and resolves it again on the next content change. A prepend
  forced in that state moved the rows off the screen in the spike. The list avoids the state: it
  holds `onNearTop` back after a command until the reader scrolls. Code that prepends on its own
  initiative must do the same.
- **A long reply streaming on screen holds about 200 MB of GPU memory on the Mac** with either
  implementation ("owned unmapped (graphics)" in `vmmap`, not the malloc heap). With A the memory goes
  with the row once it scrolls away,
  and it does not change when the reply is drawn as plain `Text` instead of Markdown. It comes from
  how SwiftUI renders a tall view that changes 30 times a second. Splitting a long reply into several
  rows would bound it.

### The chat screens

`ChatListScreen` (`HermieUI/ChatList`) and `ChatScreen` (`HermieUI/Chat`) fill the shell's `chatList`
and `chat` seams. Both read the session from `LiveGateway` in the environment.

- **The list's arrangement.** Pin, mute, archive and the order are `GatewaySession.arrangement`
  (`ChatArrangementModel`, `HermieCore/UIMeta/UIMetaChatList.swift`), read from and written through
  the session's ui_meta sync, all of it in the person's own `hermie-app:<user id>`, so two people
  on one gateway never see or overwrite each other's: `archivedBots` (bot names, sorted, no
  duplicates), `pinned` (names), `mutes` (name to the unix second it lapses, `0` for ever) and the
  order (`entries` and `folders`, the web client's arrangement). The archive is seeded once, as a
  chore, from the bots whose shared `hermie` section says `archived: true` (what the Expo app and
  earlier builds wrote) while the person's section has no `archivedBots`; after that the list is
  the only source. The shared flag is never written or cleared, since the frozen Expo app may
  still read it. Pinned chats come first, each group in the
  arrangement's order; a bot the arrangement does not place yet comes at the end of the loose
  top-level run, before the first folder, which is where a move or the fold writes it. This build
  draws no folders: a folder's chats stand in its place, and Move up, Move down and a drag stay
  within the chat's pinned group and its container. A move never drops a name (at launch the
  rows come from the cached roster, which can lack a bot made elsewhere and filed in a folder).
  Dropping gone bots and placing new ones is the fold (the web client's `reconcileBots`), run as
  a chore when the gateway has answered the roster and redone on top of every copy taken in.
- **Where the actions are.** iOS: the trailing swipe archives (full swipe) and mutes (a duration
  sheet), the leading swipe marks read and pins, the context menu has all of them, Edit reorders
  on a phone and a long press drags on an iPad; VoiceOver reads the swipe actions and Move up /
  Move down. Mac: the context menu, the Chat menu (Pin, Mute, Archive with ⌃⌘A for the selected
  chat), drag in the sidebar, and the same VoiceOver actions. The archive is a row at the bottom
  that opens a sheet on iPhone and iPad, and a header with a disclosure arrow in the Mac's sidebar; while
  searching, archived matches are a section of their own.
- **A new message in an archived chat** leaves it archived, as the Expo app does: archiving is how
  a chat stops asking for attention. The archive's entry carries no unread mark; inside the
  archive a row shows its own unread state.
- **Mute** shows a bell on the row and a "Muted until …" line in the menu. The gateway's notifier
  reads `mutes` and holds a muted chat's notifications back; in front, `PushController.isMuted`
  hides one that was already on its way. A mute silences everything informational (a message, a
  finished or failed turn, a cron result, and any type this build does not know) and never what
  needs an answer: an approval, a clarify, a secure prompt or a passkey confirmation (`request`)
  and a `security` notice are always shown. The rule is an explicit always-shown list
  (`PushContract.alwaysShownTypes`, used by `PushController` and `PushFilter`), so a new
  needs-answer type is added there on purpose. Only the live gateway's mutes are known on the
  device.
- **Avatars** come from `profiles.get_asset` as a data URL (`AvatarData` reads it), are kept on disk
  per gateway in the key-value store and painted from there on launch, and are asked for again
  once per launch and per `ui_meta` revision; a bot that no longer has one loses the stored copy.

- **Per delta, the main actor assigns two references.** The session publishes one `ChatSnapshot`
  per frame into `ChatModel`, whose `snapshot` is observed by hand so the `@Observable` setter does
  not compare two transcripts. `ChatFeed` watches the snapshot's `revision`, builds rows in a
  `ChatRowPipeline` actor (`TranscriptRowBuilder`, Markdown included) and assigns them as one
  `TranscriptListItems`. Only `ChatTranscript` reads the rows; the title, the banners and the
  composer do not change with a delta.
- **Opening.** `GatewaySession.open` hydrates in full, so the feed calls it only when the chat is
  cold, cached or failed and the socket is ready; a failed open is tried again once per return of
  the connection and by "Try again". The banner over both screens comes from the session's status,
  never from a chat's `stale`, and waits a moment before it shows.
- **A screen's feed lives as long as the screen's identity** (`ChatFeedOwner`), not from
  `onAppear` to `onDisappear`. Opening a chat from the list in a collapsed split view (an iPhone)
  lands the selection and the column change in one update, and SwiftUI then sends the new screen
  `onAppear` and `onDisappear`, sometimes with no `onAppear` after it, while the screen stays on
  screen: in the simulator a third of the opens did. A screen that dropped its feed there drew
  nothing, neither transcript nor composer, until it was closed: the black chat after a switch
  (0.2.4). The first appearance makes the feed; the feed stops when SwiftUI releases the owner (the
  chat closed, another chat selected, the session replaced). Each feed holds a `ChatLease` of its own
  on the bot's `ChatModel` and gives back only that one, so an old screen's late teardown cannot
  take the model from the screen that holds it now.
- **Diagnostics.** A press of 1.5 s on the chat's title (and the title's accessibility action)
  copies what the screen knows about itself (`ChatDiagnostics`): the screen's appearances, its feed
  and the chat's state in the store, the lease holders, the read marks, the list's bounds and content
  size, and the last lifecycle events of every chat screen (`ChatLifecycleLog`, also in the unified
  log as `dev.hermie.app`, category `chat`); "Copied" stands in the subtitle's place for a moment,
  with a haptic and a VoiceOver announcement. It works on a screen that draws nothing. It names
  bots, counts and states, and a failure only by its kind and status code
  (`ChatResolver.category`, `lastErrorKind`, `openErrorKind`, `failureKind`): no draft, message,
  error text or address, since an error's words can carry the gateway's URL. On iOS the title and
  subtitle are a view of our own in the bar's principal place, drawn as the bar draws them, so the
  press can reach them; it keeps the large content viewer at the accessibility text sizes.
  `-HermieSwitchDrill` (debug builds, `Debug/SwitchDrill.swift`) switches between chats as a hand
  does and logs each step, to reproduce a switch without a UI test.
- **History** loads through `TranscriptListState.onNearTop` and `ChatModel.loadOlder`, one page at a
  time, until the answer is not `grew`.
- **Read marks** move while the newest row is on screen, the window is in front and nothing of the
  router's covers the chat (a page pushed on it, a sheet: `AppRouter.covers`), and once more when
  the screen goes away. The feed keeps running under a cover; when the cover goes, a reader at the
  bottom gets the newest row marked read.
- **The composer and the answers.** One `ComposerModel`, `RequestsModel` and `SecureInputModel` per
  open chat screen (`ChatFeed`). `ChatScreen(chat:)` places `StandardComposer` (`ComposerView` with
  the request and secure-prompt notices above it) with `safeAreaInset`; `ChatScreen(chat:actions:
composer:)` takes another, handed a `ChatComposerContext`. The transcript answers through
  `.answeringRequests(with:actions:)` and `.secureInput(_:)`; a bot-to-bot row opens the other
  bot's chat through the router. `ComposerPlaceholder`, a disabled field, stands in only while
  there is no session.
- **Messages, as Messages draws them.** The owner's turns are flat blue bubbles (the app's accent,
  `#1772D3`, fixed; white text on it is 4.66:1) on the trailing side, the bot's words grey bubbles
  on the leading side with the Markdown inside; no gradients. A bubble is at most three quarters of
  the column and 560 pt (a reply with a table or code: 94 % and 820 pt), and as narrow as its words
  (`markdownFillsWidth`). `TranscriptRowBuilder` groups consecutive bubbles from one sender (any
  visible row between them, or an hour's pause, ends a group): only the last has the tail and the
  time on a line of its own, and a date-and-time line goes above the first message and after a
  pause. Rows are 2 pt apart and a group opens with 8 pt more.
- **Tool calls are one compact group per run** (`ToolGroupView`): every call between two other
  rows, hidden and silent ones too, so what a group holds never depends on presentation. "5 steps"
  and what they did, opening to the calls and each to its raw arguments, result and identifier.
  `ToolLabel` names a call for what it did: the dispatcher's summary ("Moneybird · list ledger
  accounts"), `mcp__server__call` as "Server · call", "Ran code", "Ran a command"; code never shows
  under a title. Status lines, cron reports and cards keep their own rows.
- **The reader's own send goes to the bottom** from wherever they were, and the list follows the
  bubble and the reply (`ComposerModel.onSubmit` → `TranscriptListState.followOwnSend`); a message
  from elsewhere leaves a scrolled-up reader where they are, and the pill counts it.
- **The composer floats as glass** over the transcript, which scrolls under it and stops above it.
  The send button is the accent blue with something to send, a plainly visible grey disc without,
  red to stop. The Mac field measures itself in a text system of its own: setting the live text
  container to SwiftUI's probe widths (0, infinity) left the typed text laid out in no space after
  the window became active.
- **The session's facts.** The user bubbles know the reader by `GatewaySession.ownAuthorID`. The
  gateway's notices are dismissible lines (the account's over the list, a chat's own over it),
  a connector authorisation is a card with Open, Skip and Cancel, and the list says when this
  client is anonymous on the gateway.

`ChatScreenUITests` (in `HermieShellUITests`) runs the first build's path against a fake gateway
that `test.sh --ui` starts on the Mac (`HERMIE_CHAT_GATEWAY`): set the gateway up in the wizard
with its token, see the bots, open a chat, send, watch the reply stream (failing if any row that was
on screen before was drawn again), stop it, and answer an approval raised through
`/__fake/request`. It reads the render counts through `ChatTestProbe`, which exists only in a debug
build launched by a UI test. Two more of its tests hold the geometry: no two rows on screen overlap
and the newest row ends above the composer (opened, after a send with the keyboard up, in landscape
and back), and a reply arriving below a scrolled-up reader moves nothing while their own send goes to
the bottom. The second runs a first turn to its end before it measures: the fake gateway's extra
history has negative row ids, and the engine's `inRowOrder` (whose "newest row above" starts at -1)
moves that history's tool rows, which carry no row id, to just after it at the first turn's end.
That move is the fake's; a real gateway's row ids are positive.

**The typing row.** While the bot works and nothing is writing words, the transcript's last row is
Messages' typing bubble: the assistant's own bubble (fill, radius, tail, padding, the height of a
one-line reply) with three dots that swell and brighten in turn, 1.2 s a wave. It is a row of the
list (`TranscriptRow.Content.typingIndicator`, id `typing-indicator`), not an item of the
transcript: `ChatFeed` asks `TypingIndicator.wanted` (working, thinking, a tool, a delegation; not
typing, waiting or idle, and only on a live chat) and passes the answer through
`TypingIndicatorGate` to `ChatRowPipeline`, which appends the row. Appearing is debounced by 150 ms
so a thought, a tool and the first words following each other within frames never flash it;
going is immediate, with the snapshot that puts the reply (or the end of the turn) on screen. As a
row it is inserted and removed by the list's ordinary structural update, so a pinned reader stays
pinned and a reader who scrolled up is not moved. The dots are a `TimelineView`, so only they are
redrawn. Reduce Motion: no scaling, a slower, shallower fade along the dots. One accessibility
element, "Typing…", the header's own string. An empty reply that is still being written is no
bubble any more (`bubbleSender` wants words). To see it by hand against `npm run fake-gateway --
--auth token --token demo --stream-delay 900`: launch with `-HermieUITest YES
-HermieSeedICloudGateway 'Fake|http://127.0.0.1:<port>|demo' -HermieOpenURLWhenReady
'hermie://chat/writer'` and run a turn from another client (`?token=demo` on the socket).

### The lab

`TranscriptLabView` (`HermieUI/Debug`, debug builds only) is the spike as a screen. It shows the
synthetic transcript, with buttons to stream, prepend, jump to the middle, run the meter, pan, and
run the render-count test, and a report line under them. "List" cycles the implementation (auto, A,
B), and "Bar" puts a 160 pt bar under the list, as a composer that grew would. The hands-off bench
ends by scrolling up, prepending 200 rows and logging how far the rows on screen moved (B only; A
logs "no rows"). `TranscriptItemGallery` shows every item
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
- `-HermieLabScreen composer -HermieLabGateway http://127.0.0.1:<port>` shows the composer lab: the
  researcher's chat on that gateway with the real composer, cards and request sheet
  (`-HermieLabBot`, `-HermieLabToken` and `-HermieLabHideTranscript YES` are optional). Nothing is
  written to disk. `scripts/test.sh --ui` starts a fake gateway on the host for its UI tests
  (`ComposerUITests`) and hands them its address as `TEST_RUNNER_HERMIE_LAB_GATEWAY`; each test
  starts by withdrawing every open request (`POST /__fake/withdraw-requests`).
- In the composer lab, `-HermieLabDraft <text>` puts text in the field, and with
  `-HermieLabSendAfter <seconds>` sends it (`-HermieLabSends <n>` times, each after the reply to the
  one before); `-HermieLabScrollUp <points>` scrolls up that far before each send. For looking at
  the field and at the list's scrolling on a send without driving the keyboard.

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
the whole native round trip through an identity provider with a password and a one-time-code step
(`NativeOIDCRoundTripTests`, the fake's `--idp staged`: the gateway's PKCE cookie, the provider's
own cookies, its redirect to `/auth/callback` and the gateway's to the attempt's loopback port,
including a wrong code that sends the person back to the password form inside one attempt),
ticket minting, redirect refusal between the gateway and a second local listener, and the plugin
routes, the WebSocket connection, and the session runtime (`SessionRuntimeIntegrationTests`: a cold
start from the cache, a streamed turn, an approval, a socket dropped mid-turn, history paging), and
the live wiring (`PushWiringIntegrationTests`: a registration landing as this installation's row on
the live gateway and leaving it on a sign-out, with the relay registration retired; a notification
action answering an approval only while it is listed and only for the bot and request id it names). UI
smoke tests on the simulator use a fake gateway that `test.sh --ui` starts on the host
(`ChatScreenUITests`), and the primary native sign-in runs there for real (`BrowserSignInUITests`:
the system browser sheet, the staged identity provider's password and code forms, the redirect to
the app's loopback listener, the sheet closing). That test is what found the listener refusing the
browser on iOS: with `NWParameters.acceptLocalOnly` set, Network closed the browser's connection as
"non-local" the moment it was accepted, so the browser showed a lost connection and the sign-in
never finished.

To try the fake gateway by hand:

```sh
npm run fake-gateway -- --auth token --token demo
```

## Web client

The browser client in `native/web` ([its README](../native/web/README.md) has the detail) is tested at four
levels, each with its own command and its own place in CI.

| Level                         | Command                                                                         | Where it runs in CI                  |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| unit and component (jsdom)    | `npm run client:test`                                                           | `web-client`                         |
| the build and what leaves it  | `npm run client:check-bundle`, `client:check-reproducible`, `client:guard-scan` | `web-client`                         |
| a browser, end to end         | `npm run client:e2e`                                                            | `web-client-e2e`, one job per engine |
| the transcript list's budgets | `npm run client:e2e:perf`                                                       | `web-client`, Chromium only          |

**The browser suite** runs the real production build in Chromium, WebKit and Firefox against
`packages/fake-gateway` in cookie mode, serving the build through its copy of the dashboard's static route. A
gateway of its own per test on a free port means no test inherits another's open request, draft or cookie. The
specs are black box: roles and accessible names for the page, the gateway's `/__fake/*` control endpoints for the
gateway, and no sleeps (auto-waiting locators, `expect.poll` on the gateway's state, `settled` for "has stopped
moving"). Every test fails on a console error, an uncaught page error or a `securitypolicyviolation`. What is
covered: sign-in and a lost session (the redirect to the gateway's `/login`, "Sign in again", the route restored
after it, a frame refusing to render), the chat (list, open, stream, send, stop, queue, drafts, a dropped socket
without a duplicate, a long history), the request layer (approval, clarify, withdrawn, restored), and axe on every
screen and sheet in both colour schemes (no serious or critical violation). To add a spec, import `test` and
`expect` from `native/web/e2e/fixtures.ts`, not from `@playwright/test`.

```sh
npx playwright install chromium webkit firefox       # once
npm run client:e2e                                   # all engines, from the repository root
npm run e2e --workspace @hermie/web-client -- --project=webkit e2e/requests.spec.ts
npx playwright show-trace native/web/test-results/<test>/trace.zip   # after a failure
```

**Required checks.** CI's `web-client-e2e` is a matrix, so branch protection needs the three check names
(`Web client end to end (chromium)`, `(webkit)` and `(firefox)`) rather than one. The workflow has no path filter:
a required check that a path filter keeps from starting leaves a pull request that touches none of the paths
unmergeable.

**The plugin scanner** (`npm run client:guard-scan`) runs the Hermes plugin scanner, fork and upstream at the commits
pinned in `scripts/web/scanner-pins.json`, over `native/web/dist` laid into a synthetic plugin tree. The fork, which
is what the gateways run at install and update, is the blocking gate and fails on anything but `safe`; upstream is
informational: its verdict and findings are printed and summarised, and only `dangerous` from it fails (plan W3,
amended for HERM-192; the details are in `native/web/README.md`). It is the same scan the plugin repository runs
before an import, run here first. It needs Python 3.10 or newer (`GUARD_SCAN_PYTHON`) and the network. When the
plugin repository moves a scanner pin, move this one in the same change.

## Extensions

The widgets, the share extension and the App Intents (compiled into the apps) read what the app
writes into the App Group and hand work back through it; the sources are in `native/apple/Extensions`
and the app's side is `HermieCore/AppGroup`. The rules they keep:

- **The share credential has a keychain group of its own.** The delivery record
  (`hermie.share.delivery`) lives in `<team>.dev.hermie.app.share`, which the apps declare second and
  the share extension declares alone, so the extension cannot read any other secret.
  `ShareDeliveryPublisher` writes it there by name and deletes the copy earlier builds left in the
  app's group. Keychain access groups are entitlements only: nothing to enable on the developer
  portal.
- **No background session for a credentialed request.** The share extension's direct send runs on
  one ephemeral session whose delegate refuses every redirect, the WebSocket included, so a front
  door's redirect to its identity provider never carries the token or the front-door headers
  anywhere. Whatever does not finish within `ShareLease.attemptDeadline` is left for the app.
- **A lease, then a claim.** The extension takes `lease.json` in the entry before it touches the
  network and removes it when done; the app does not deliver an entry with a fresh lease. The app
  takes the same lease before it sends an entry itself and gives it back when it keeps the entry.
  Both take it with `ShareLease.take`, which creates the file exclusively (a stale one is
  replaced, a fresh one never), so only one side ever holds an entry; and the app leaves an entry
  with no lease alone for `AppGroupShareOutbox.leaseGrace` after it was written, the moment in
  which the extension leases it. Just before `prompt.submit` the extension writes `claim.json`, but
  only while the entry is still there: an entry the app has taken is not sent twice. The app never
  sends a claimed entry without asking.
- **The app lock comes first.** `ShareOutboxDrainer` and `IntentQueueDrainer` do nothing while
  `SystemSurfaceLock` says locked, every App Intent requires an unlocked device, and "Bots needing
  input" names nobody while it is locked. It is locked until `LiveWiring` installs its state (see
  [the live wiring](#the-live-wiring)), and then open only while the launch is ready, the app lock
  is open and the live gateway has a signed-in session.
  The widget snapshot and Spotlight take a `hidePreviews` input, and previews are privacy-sensitive.
- **Every queued item names its gateway.** Shares and Shortcut requests carry the `gatewayKey` of
  the roster their bot was picked from. A drain delivers only the active gateway's, leaves another
  configured gateway's waiting, and purges one whose gateway is gone; signing out or removing a
  gateway calls `purge(gatewayKey:)` on the drainers and the snapshot, Spotlight and targets
  writers. An item from before keys were recorded goes only when exactly one gateway exists.
- **Nothing is skipped for ever, nothing is followed through a link.** A manifest the app cannot
  read is reported and removed; long shared text is stored as a file in the entry, so the manifest
  stays under the one limit both sides share (`ShareManifest.maxBytes`); only regular files are
  copied, listed or uploaded.

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

The model layer of push is `HermieCore/Push`. What a notification is, for every sender and both app
generations, is `contract/push/contract.json`; Swift holds itself to that file in
`PushContractTests` (every data key, enum, request method, channel and the examples in
`examples.list` are read from the file, so a contract change that this build does not know fails a
test).

**Reading a payload.** `PushPayload` reads the data bag defensively and exposes the keys the
contract lists: `type` (the seven switches, the unfiltered `security` and the legacy `dm`),
`requestMethod`, `requestId`, `sessionId`, `sessionKey`, `sessionKind`, `level`, `clear` (as
`isClear`), `reason`, `replaces`, `event`, `change`, `eventId` and `gatewayKey`. `readKeys` and
`carriedKeys` together are every key of the contract.

- **Request methods.** `PushRequestMethod` names `approval`, `clarify`, `secret`, `sudo`,
  `vault.unlock_prompt`, `vault.code`, `vault.save_login` and `confirm`. Only an approval is posted
  under `hermie.request` (`PushPayload.wantsActions`); every other method never gets Allow or Deny,
  and a tap that says Allow or Deny on one is a plain open. An approval is posted with the category
  only when it carries a request id (the id is `whenKnown` for an approval). A request with no `method` is not an
  approval for the category, but a tap still reads it as one (the senders before the contract only
  posted approvals with the actions).
- **`sessionId` of a request is the runtime id.** The approval a tap answers is matched by request
  id and bot, and by that runtime id when the payload names one (it is absent when the sender could
  not know it). The conversation a request opens is named by `sessionKey`, the stored id the session
  list shows; the runtime id never opens a conversation.
- **Requests that are not approvals open in the app.** A tap on a clarify, a secure input or a
  confirmation yields `PushRoute.request(link, PushOpenRequest)`: the method, request id, runtime
  and stored session ids, the confirmation `level` and where the conversation behind it opens. At
  level `passkey` the confirmation can only be done in the app (`needsDeviceAuthentication`). Showing
  the request is a later task: `PushLifecycle` opens the bot's chat meanwhile. Nothing in the route is
  acted on unverified; the shell re-reads the open request from the gateway by `requestId`.
- **`security`.** An unfiltered type: it bypasses the per-type switches, the per-chat overrides, a
  mute and the open-chat suppression (`PushPayload.bypassesFilters`, `PushFilter`). It is no switch:
  no registration row key, no settings entry, and `PushRows` keeps writing the seven types.
- **`background.complete`.** Sent as `turn_done` with `event`; the `turn_done` switch decides it
  (`PushPayload.switchType`).

**Clearing.** The registration row carries `clears: true` (`PushRows.clearsKey`, written by
`PushRowWriter`, not by the reference port `PushRows.rowFor`, which the contract vectors replay
unchanged), which tells a sender this build can handle a clearing push, and `requestMethods: true`
(`PushRows.requestMethodsKey`): this build never shows Allow or Deny for a request that is not an
approval, which is what lets a sender post a confirmation or a secure input to the row. A clearing push is a
`type: request` bag with `clear: true`; it is silent (`PushPresentation.hidden`), never carries a
category and is never a tap. It removes the delivered notification of the same bot with the same
request id, or whose `eventId` is `replaces`, through `PushDeliveredNotifications`, a protocol over
the system's delivered notifications that keeps `UNUserNotificationCenter` out of the model.
`PushClearing.apply(_:to:)` is the call for a notification service extension, which has no
controller; `PushController.handleDelivery` and `PushInbox.handleDelivery` are the calls for the
app and its delegate. The relay cannot carry a clearing push yet (every relayed message is an
alert), so on a relay row the app removes what it can itself.

**In the app shells.** `SystemDeliveredNotifications` is the `UNUserNotificationCenter`
implementation of `PushDeliveredNotifications`; `willPresent` hands a clearing push to
`handleDelivery` (and shows nothing), and both app delegates do the same for a silent data message.
There is no notification service extension target yet; when one lands it calls
`PushClearing.apply`. Where a tap lands (`PushLifecycle`): a message, an approval and every other
request open the bot's chat (an approval's card is in its transcript; the confirmation, secure
input and passkey sheets that `PushRoute.request` is the seam for come with their own task), and a
`security` notice opens Settings → Account for the gateway it names (`PushRoute.security`, made
the live gateway first when it is not).

**Still held.** Showing a request opened from `PushRoute.request` in its own sheet; a named
conversation (`PushRoute.conversation`) opens the bot's chat until the conversation viewer lands;
the row of a gateway that is not the live one is written the next time it is (only the live
gateway has a socket to write `ui_meta` through); the actions still bring the app to the front
(`PushContract.actionsForegroundOverride`).

### The live wiring

`LiveWiring` (`HermieCore/Wiring`) is what runs against the live session besides the screens. The
app shell builds it beside `LiveGateway` (`LiveWiring.app(launch:accounts:live:)`, which also puts
`SystemDeliveredNotifications` and `PushInbox` in place) and hands it to the windows through the
environment. It only follows: which gateway is live is `LiveGateway`'s, who is signed in where is
`GatewayAccounts`'s.

- **Push's session seams.** `pendingApprovals` waits for the live session's socket (a tap from a
  cold start), opens the bot's chat when it is not attached, and reads `approval.pending` for the
  runtime session the chat is attached under, never for one a payload named; `respond` answers
  through the chat's open card for that queue id when it shows one (so the transcript marks it)
  and by queue id otherwise. Both answer only for the live gateway, and only while the app lock is
  open: `pendingApprovals` also waits (within the same wait) for the person to unlock, and a tap
  that finds the app still locked only opens the chat, where the card waits behind the plate. The
  chat opens first and the answer follows. `canonicalSessionIds` reads the live chat list.
- **The ui_meta bridge.** One `GatewayMetaBridge` per live session: a `UIMetaSync` over the
  session's own link, its copy kept per gateway under `hermie.ui_meta`, with this installation's
  `PushRowWriter` as contributor. It reconciles once the session has read who this is
  (`GatewaySession.uiMetaUser`: `owner` on a session-token gateway, the user id or email
  `/api/auth/me` named otherwise, nobody after a read that failed), on every `ready` edge, after
  every `sessions.changed` sweep and when the app comes to the front (while any of its windows is
  in front: a second window minimised on the Mac does not stop the heartbeat). The window in front
  names the open chat for the `seen` heartbeat. The session's `ChatArrangementModel` reads and writes
  the chat list's pins, mutes, order and archive through the same sync. What the gateway's copy
  carries that this build does not draw (other devices' rows, folders, the plugin advert) goes back
  as it came; nothing taken in is treated as this person's own choice. A change made only of chores
  (the roster folded into the order, a lapsed mute swept, a push row) never wins over a section the
  gateway holds (HERM-191): it is dropped, not sent, and redone on top of what was taken. The settings bridge (`UIMetaSettingsBridge`) is
  not registered yet: there is no native settings model to bridge to.
- **Sign-out and removal.** `GatewayAccounts.endSession` is wrapped: before the session ends, the
  surfaces stop publishing for that gateway and, when it is the live gateway, the bridge withdraws
  this installation's row from it (while the credentials still work, waiting at most three
  seconds). Only the live gateway's row is withdrawn: a gateway that is not the live one has no
  socket to write through, so its row stays on that gateway (the relay registration it names is
  retired all the same, so nothing reaches this device through it). The surfaces purge what they
  hold for the gateway once the sign-out went through, and for a removal only once the removal
  did (`GatewayAccounts.purgeSurfaces`). `GatewayAccounts` then retires the relay registration as
  before (`pushStillRegistered` when it cannot).
- **The system surfaces.** `SystemSurfaces` writes the widget snapshot, the share sheet's targets
  and the Spotlight rows from the live chat list (previews left out while the app lock is
  configured), and drains the share outbox and the Shortcuts queue on every opening of the lock,
  every `ready` edge, every `hermie://share` or `hermie://intent` link and every return to the
  front. A drain goes through the live session for that session's own gateway only: while a
  switch settles, the directory can already name the next gateway, and what is queued for it waits
  for its own session (the drainers route by the session's key, and `deliver` and `answer` refuse
  anything else). The app sends a share itself only when it names a bot, carries no claim and holds
  only text and links; a share with files waits for the share extension's direct send (the app has
  no upload path yet), and one with no bot or a claim waits for the sheet that asks the person.
  Before it sends one, the app takes the entry's lease (`ShareLease.take`, created exclusively,
  the rule the extension follows too), so the two never send the same share; a share written less
  than two seconds ago with no lease yet is left to the extension, and the drain looks again once
  that grace is over. A Shortcut request is taken (`<id>.taken`) before it runs, so it runs at
  most once, and its expiry is judged when its turn comes, not when the drain started. "Send to"
  answers once the gateway took the prompt; one parked behind a turn that was already running
  waits (at most ten seconds) for that turn to end and its prompt to go out, and otherwise answers
  that it is queued in the app. "Ask" waits for the finished reply to its own prompt (never to the
  turn that was running when it was asked) within the request's budget, outside the drain so the
  next request is not held up, and otherwise answers that the bot is still working.

Moving from the Expo app to a native build: the native app registers under a new installation id
and does not retire the Expo app's row for the same device, because removing it automatically could
cut off a device that still runs the Expo app. Remove those Expo rows by hand from each gateway's
push section as part of the cut-over.

## Gateways in iCloud Keychain

The native apps keep the gateway list, and the credentials that are the same on every device, in the
person's iCloud Keychain ([ADR-0032](adr/0032-icloud-gateway-sync.md)). The pieces:

- `HermieStore`: `ICloudKeychainStore` (synchronizable items, service `hermie.sync.v1`) and, for tests
  and the UI tests, `FakeCloud` with one `InMemorySyncedItemStore` replica per device.
- `HermieCore/Sync`: the record, the merge (`GatewaySync.reconcile`, a pure function) and
  `GatewaySyncEngine`, the only code that reads the synced set and the only path that adds, moves,
  removes or signs out of a gateway, whether sync is on or not. Its doc comments list the merge's
  rules and its known limits; the ADR says them in prose.
- `HermieCore/AppLaunch/ICloudSyncModel`: what the views read (status line, per-gateway state,
  badges, notices, the gateways iCloud offers) and the actions they call. The views hold no logic.
- `HermieUI`: the one-time disclosure (`App/ICloudSyncDisclosure.swift`), Settings → Gateways →
  iCloud Sync (`Settings/ICloudSyncSettingsPage.swift`) and the hooks on the Gateways page
  (`Settings/ICloudSyncGatewayHooks.swift`).

Sync is on by default and asks once per device before it first writes to iCloud Keychain. Nothing
reads iCloud before that answer except the onboarding, through `ICloudSyncModel.lookInICloud()`.
The wizard's first step lists what it found ("Available from iCloud"), and one tap adopts them. A
gateway taken from iCloud whose sign-in cannot travel shows "Sign in needed" and opens the same
sign-in sheet as Settings ("Sign in", through the `onNeedsSignIn` environment value);
`GatewayAccounts.signedIn(_:)`, where every finished sign-in lands, tells the model. Removing a
gateway, from this device or from all, goes through `GatewayAccounts.remove(_:scope:)`, which hands
the grant back first.

Tests never touch the real keychain on a Mac: there it is the developer's own iCloud Keychain.
`swift test` uses the in-memory stores and the multi-device fakes (`Tests/HermieCoreTests/Sync/`), and
the UI tests launch with `-HermieUITest YES`, which swaps both keychain sets for memory.
`-HermieSync on|ask|off|unavailable` and `-HermieSeedICloudGateway` set up the fake iCloud for a
launch (`LaunchTestHooks`).

## Bot settings

A bot's settings page, `BotSettingsScreen` (`HermieUI/BotSettings`), is the `DetailRoute.botProfile`
page pushed over the bot's chat. It opens from the chat header (the info button) and from the chat
list's context menu (and its VoiceOver actions on the Mac): `AppRouter.showBotSettings` selects the
chat and pushes the page once. The model behind it is `BotSettingsModel`
(`HermieCore/BotSettings`), which `GatewaySession.botSettings(for:)` builds over the session's link.

### What exists, and where

The Expo app has the settings in three places (the profile sheet, the capabilities sheet and the chat
options), the web client has only the chat options panel (verbosity, thinking, bot-to-bot) plus the
`ui_meta` bridge that carries the chat list's choices, and the gateway backs each with the method or
route in the last column. "Native" is what this build has.

| Setting                                                       | Expo                                  | Web                      | Native                                                                | Gateway                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------- | ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Picture                                                       | profile sheet                         | no                       | yes: PhotosPicker, square JPEG at 512 px, metadata dropped            | `profiles.set_asset` (`data` or `clear`), `profiles.get_asset`                                           |
| Display name (the person's own)                               | profile sheet                         | read from `ui_meta` only | yes                                                                   | `ui_meta` app section `labels` (per person)                                                              |
| Display name on the gateway                                   | profile sheet, via the plugin         | no                       | not yet                                                               | `PATCH /api/plugins/hermie/profiles/{name}` (REST, advertised as `profiles.display_name`)                |
| Handle (profile name)                                         | read-only row                         | no                       | read-only row                                                         | `profiles.list` `name`                                                                                   |
| Rename the profile                                            | profile sheet, disclosure             | no                       | not yet                                                               | `PATCH /api/profiles/{name}` (REST)                                                                      |
| Colour                                                        | profile sheet, row menu, chat options | read from `ui_meta` only | yes (shared with everyone on the gateway; tints the avatar's initial) | `ui_meta` bot section `hermie.colour`                                                                    |
| Description                                                   | profile sheet                         | no                       | yes                                                                   | `profiles.configure` `description`                                                                       |
| Personality (`SOUL.md`)                                       | no                                    | no                       | yes: editor, plain text                                               | `profiles.describe` `soul`, `profiles.configure` `soul`                                                  |
| Model and provider (the bot's pin)                            | only when a bot is created            | no                       | yes: picker, with the expensive-model confirmation                    | `model.options`, `profiles.configure` `model` + `provider` (+ `confirm_expensive_model`)                 |
| Model for one conversation, reasoning effort, fast mode, YOLO | chat options sheet                    | no                       | not yet: they belong to the chat, not the bot                         | `config.set` / `config.get` with `session_id`                                                            |
| Toolsets                                                      | capabilities sheet                    | no                       | yes                                                                   | `profiles.describe` `toolsets`, `profiles.configure` `enabled_toolsets`                                  |
| Skills (on or off)                                            | capabilities sheet                    | no                       | yes                                                                   | `profiles.describe` `skills`, `profiles.configure` `disabled_skills`                                     |
| Skills catalogue (browse, install)                            | Skills page                           | no                       | not yet                                                               | `skills.manage` (`list`, `search`, `browse`, `install`)                                                  |
| MCP servers (on or off) and the reload                        | capabilities sheet                    | no                       | yes                                                                   | `profiles.describe` `mcp_servers`, `profiles.configure` `enabled_mcp_servers`, `reload.mcp`              |
| MCP servers page (probe, OAuth)                               | MCP page                              | no                       | not yet                                                               | `mcp.servers.list`, `.status`, `.test`, `.oauth.*`                                                       |
| Memory                                                        | memory browser, graph                 | no                       | not yet                                                               | plugin REST `/api/plugins/hermie/memory/{list,search,raw,…}`                                             |
| Conversations (branches)                                      | conversations page                    | conversations page       | not yet (`DetailRoute.sessions` is a placeholder)                     | `session.list`, `session.branch`                                                                         |
| What the chat shows (verbosity, thinking, bot-to-bot)         | chat options                          | chat options panel       | yes, for the open chat                                                | client-side filter; the app-wide default is the `ui_meta` `defaults`                                     |
| Pin                                                           | row menu                              | list                     | yes                                                                   | `ui_meta` app section `pinned`                                                                           |
| Mute                                                          | row menu, chat options                | list                     | yes                                                                   | `ui_meta` app section `mutes`                                                                            |
| Archive                                                       | row menu                              | list                     | yes                                                                   | `ui_meta` app section `archivedBots`                                                                     |
| Folder, order                                                 | row menu, drag                        | list                     | not in settings (the list moves chats)                                | `ui_meta` app section `entries`, `folders`                                                               |
| Notifications for this chat                                   | chat options                          | no                       | not yet                                                               | `ui_meta` push rows (`push.perBot`)                                                                      |
| Voice (read aloud)                                            | chat options                          | no                       | not yet                                                               | none: on the device                                                                                      |
| Export the conversation                                       | chat options                          | no                       | not yet                                                               | none: from the transcript                                                                                |
| Delete the bot                                                | none                                  | none                     | none                                                                  | no `profiles.delete` method; `DELETE /api/profiles/{name}` exists on the gateway and no client offers it |

### Decisions

- **Writes go through the gateway's own methods.** The text fields are drafts with Save and Revert;
  everything else writes at once. Each capability list is replaced whole, written the way the
  gateway stores it (`BotSettingsParams`): skills as the DISABLED set, toolsets as a pin of the
  names that are on, MCP servers as the ENABLED list. An empty toolset list takes the pin away, so
  a switch never writes one (the last toolset stays on, and "Follow the gateway's defaults" is its
  own request that rereads what the defaults are). Toggles made while a write is in flight are
  coalesced: the running write sends the latest state when it returns, and a refusal puts the
  section back to what the gateway last confirmed.
- **The model pin is the bare id and the provider.** `profiles.configure` gets `model` exactly as
  `model.options` lists it and `provider` in its own field, as the gateway's desktop client sends
  them. The gateway's `normalize_model_for_provider` keeps a leading `provider/` for openrouter,
  nous, ollama, lmstudio and user providers, so a prefix added by the client would become part of
  the model's name.
- **One write at a time per profile.** Every `profiles.configure` (description, personality,
  model, toolsets, skills, MCP servers) goes through one serial queue, and builds its params when
  its turn comes: the gateway changes the profile's config without a lock, so two writes in flight
  can lose one. `profiles.describe` is not queued, so each section has a generation that moves when
  a write to it is confirmed; a snapshot is only believed for a section if that generation has not
  moved since the read was sent and no write to the section is under way. Putting the toolsets back
  to the defaults counts as a write to them, and locks their switches until it has been read back.
- **The MCP reload question is in the app's words.** The gateway's own warning is written for its
  command line (it tells the reader to reply `/reload-mcp now`), so the alert says what the two
  buttons do and leaves the gateway's text out.
- **`applied` is checked.** `profiles.configure` answers `ok` with a per-section `applied`; a
  section the request carried that is not `true` there is a failure the screen says, not a
  success. A guarded model answers `confirm_required` with nothing written, and is written only
  after the person confirms. `reload.mcp` can refuse by succeeding (`confirm_required`); the screen
  asks with the gateway's own words.
- **Permissions.** The gateway offers no profile-level permission answer: it refuses at the write.
  A refusal that reads as an access denial (codes 4030 to 4033, 4403, or explicit words such as
  "forbidden" or "access denied") puts the screen in read-only: the editors become selectable text, the switches are disabled, one
  line says so. No connection is read-only too. The name, colour, pin, mute and archive are the
  person's `ui_meta`, writable while the sync is attached.
- **Capability checks.** A gateway without `profiles.describe` (`-32601`) shows the sections Hermie
  keeps itself and one line that the rest is not offered. The model picker is drawn only where
  `model.options` lists models.
- **Untrusted text.** Everything the gateway sent (soul, description, toolset names and
  descriptions, skill and server names, model names, its error words) is drawn as plain text
  (`Text(verbatim:)`, a `TextEditor`), never Markdown.
- **The label and colour reach the rest of the app.** `ChatArrangementModel` reads and writes
  `labels` and the bot's `colour` like the chat list's choices; the list, its search and the chat's
  title use the label, and a chosen colour is the avatar's initial background. The bubbles keep the
  fixed blue.
- **The picture.** `AvatarEncoder` decodes the photo, applies its orientation, crops the middle
  square, scales to at most 512 px and writes a JPEG with no properties of its own, so a photo's
  location never reaches the gateway, where everybody can read the picture.

### Tests and what stands in for the gateway

`BotSettingsParamsTests`, `BotSettingsModelTests` and `UIMetaBotIdentityTests` (HermieCoreTests)
cover the mapping, the polarities, the coalescing, the refusals and the identity fields against a
scripted gateway that stores a profile the way the real one does; `BotSettingsViewTests`
(HermieUITests) the picture, the model search and the router's way in; `BotSettingsIntegrationTests`
read and write a profile on the fake gateway over a real socket. The fake gateway keeps the soul,
pins a model behind the expensive-model guard (`confirm_required`), and refuses a method on request
(`POST /__fake/deny`), matching the shapes in `tui_gateway/methods_profiles.py`
(`packages/fake-gateway/src/bot-settings.test.ts`).

A debug build launched with `-HermieUITest YES` also takes `-HermieOpenChat <bot>` and
`-HermieOpenBotSettings <bot>`, which open that chat or its settings page once the live gateway is
known.
