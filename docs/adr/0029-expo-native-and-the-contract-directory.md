# 0029. `expo/`, `native/` and a `contract/` both are tested against

- Status: Accepted
- Date: 2026-10-02
- Amends: [0001](0001-expo-sdk-54-rn-081.md)
- See also: [0030](0030-web-client-served-by-the-plugin.md), which fills `native/web` and replaces the server this record expects to serve its export

## Context

[ADR-0028](0028-native-apps-on-apple-platforms.md) decided to rebuild Hermie natively on Apple
platforms while the Expo app keeps shipping everywhere, Apple platforms included, until the native
apps replace it. For a long while the repository therefore holds two generations of the same client,
and two questions follow from that which are about the repository rather than about either app.

**Where does each generation live?** Before this change the npm workspace was `apps/*` and
`packages/*`. `apps/hermie` was the Expo app; `apps/desktop` the Tauri shell
([ADR-0027](0027-desktop-is-a-webview-over-hermie-web.md)); `packages/` held the vendored protocol
sources, the gateway client, the transcript engine, the fake gateway and Hermie Web. Those packages
are not Expo code. The engine and the gateway client are pure TypeScript with no React in them, the
fake gateway is a Node server, and Hermie Web is a Node server that serves whatever web bundle it is
given. All of them outlive Expo, and a future native web build will stand on several of them.

**How does a Swift port stay the same program?** The transcript engine is about 7,700 lines with
close to 500 test cases, and the gateway client has a state machine and a long tail of pure functions
— URL normalisation, host privacy, the front door, the PKCE helpers, the backoff ladder — each with
its own tests. TypeScript stays the reference while Android and the browser still run it. The port
must answer the same inputs with the same outputs, today and after every change on either side.

Options considered for the layout:

1. **Move only the Expo app: `apps/hermie` to `expo/hermie`.** Same depth and the same directory
   name, so every `../../` inside the app and every script that names `hermie/` keeps resolving.
2. **Move the whole npm workspace under `expo/`.** Rejected: it buries Hermie Web, the fake gateway
   and the two pure packages under a name they do not belong to, and the first native web build would
   force a second move to get them out again.
3. **Leave the layout alone and add the Swift code beside it.** Rejected: nothing in the tree would
   say which code is the Expo generation and which is the native one, and that is the question every
   contributor will be asking for as long as both exist.

Options considered for parity:

1. **Hand-port every test.** Slow, and it starts to rot the day the TypeScript side changes, because
   nothing notices that a Swift test is now testing old behaviour.
2. **Run the TypeScript engine inside JavaScriptCore.** No port to keep in step at all. Rejected: it
   puts a JavaScript runtime in the hot path of a rewrite whose point is to be native, and it gives a
   later Kotlin port nothing to stand on.
3. **Record what the TypeScript code does, and replay it.** Run the existing TypeScript suites with a
   recorder around the public functions, write every call and its result down as data, and make the
   port answer the same data.

And for where the shared data lives: under `native/` (TypeScript cannot own a fixture that lives in
another world's directory), or a copy per world (drift between the copies is exactly the failure this
is meant to prevent). Both were rejected.

## Decision

### Layout

```
expo/hermie/      the Expo app (was apps/hermie), unchanged inside
native/           the native apps: apple/ (HermieKit, config, XcodeGen base, scripts), ios/, macos/;
                  android/ and web/ reserved, with a README each and no code
contract/         generated, checked-in data both worlds test against
packages/         unchanged: hermes-shared, gateway-client, transcript, fake-gateway, hermie-web
apps/desktop/     unchanged: the Tauri shell
```

- **Only the Expo app moved**, with `git mv`, to `expo/hermie`. The npm workspace now lists
  `expo/*` beside `apps/*` and `packages/*`; nothing inside the app changed.
- **`packages/` stays where it is.** It is the reference implementation the native port is held to,
  and the base a native web build will reuse.
- **`apps/desktop` stays where it is.** It is not Expo, and it loads a remote Hermie Web URL, so it is
  indifferent to which web bundle that server hands out. When the native Mac app is public, the
  shell's macOS build is to be discontinued; its Windows and Linux builds remain. Moving it under
  `expo/`, or deleting it, were both rejected.
- **Hermie Web keeps serving the Expo web export** through `npm run web:build` until a native web
  build exists. Switching then is a change to that one export step, not to the server.
- **`native/android` and `native/web` are reserved** so the layout is settled before any code
  arrives. Neither is started, and neither is decided by this record beyond its location.
- **The Xcode projects are generated.** `native/ios/project.yml` and `native/macos/project.yml` are
  XcodeGen specs that include `native/apple/xcodegen/base.yml`; they are checked in, and the
  `.xcodeproj` they produce is ignored. Rejected: committing the projects (a `project.pbxproj` merge
  conflict for every two branches that add a file) and one multiplatform target (the Mac needs its own
  scenes, entitlements and sandbox, and two small specs say that more plainly than one target full of
  platform conditions).

### Parity

- **`contract/` is the one home for anything both worlds test against.** It is generated by
  TypeScript scripts, checked in, and its own [README](../../contract/README.md) is the specification
  a port reads: the layout, the canonical JSON rules and how each kind of file is replayed.
- **The transcript contract is a golden corpus recorded from the TypeScript test suites.** A recording
  test configuration wraps every public engine function and writes down each top-level call — the
  operation, its arguments including the state and `now`, and the result — per test. A call enters the
  corpus only if it survives a JSON round trip and still gives the same answer. Fixtures and recorded
  fake-gateway conversations go in beside it, and the gateway client's pure functions get input and
  output vectors the same way. The Swift port replays each call and compares canonical JSON.
- **Stateful code that runs on a clock is ported by hand.** The connection state machine and the token
  coordinator are tested in Swift with a test clock and a fake transport, against the TypeScript tests
  as a reading list rather than as recorded data.
- **CI holds parity in both directions.** `npm run golden:check` fails the TypeScript CI when the
  engine, the gateway client's pure functions or the fake gateway change without the corpus being
  regenerated. The native CI runs whenever `contract/` changes, and fails when the corpus moves and the
  Swift port does not follow. TypeScript is the reference until Android and the browser leave Expo.
- **Integration tests are black-box against `packages/fake-gateway`.** A macOS-only Swift test helper
  starts the fake gateway through its CLI, and the UI smoke tests on the simulator use one the test
  script starts on the host. The real WebSocket, the real HTTP client and the real sign-in round trip
  are exercised against the same server the Expo tests use.

### Release

- **The first native version is 0.2.0, and the build number stays the commit count**, so every native
  build is numbered above every Expo build already uploaded to the same record.
  [docs/release.md](../release.md#native-apps) has the rule while both version lines exist.
- **Build logic lives in the repository.** `native/apple/scripts/archive.sh` generates, archives and
  exports either app and takes the signing team from the environment. Release tooling outside the
  repository only calls it, so nothing about building the apps depends on a machine nobody else can
  see.

## Consequences

- **The tree says which generation a file belongs to.** `expo/` will shrink and eventually disappear
  platform by platform; `native/` grows; `packages/` and `contract/` are shared and stay.
- **Moving the app was cheap because the depth did not change**, but every path in documentation,
  CI and scripts that said `apps/hermie` had to be rewritten once, and anything outside the repository
  that still says it is now wrong.
- **A change to the engine is now a three-part change.** The TypeScript code and its tests, the
  regenerated corpus (`npm run golden`), and — once the engine port exists — the Swift code that makes
  the native job green again. A pull request that does only the first part fails CI by design.
  [docs/native.md](../native.md) says what to do when either job fails.
- **The corpus is large and not meant to be read.** About 13 MB, most of it full engine states. It is
  reviewed through its diff and its summary counts, not line by line, and its README records how it
  would be trimmed if it outgrows its budget.
- **What cannot be recorded is not covered by the corpus.** Calls that take a callback or a
  non-finite number are skipped and counted; a port needs its own tests for them, and the counts in
  `contract/README.md` say which they are.
- **Contributors need XcodeGen** to open the native apps, and have to regenerate after changing a spec
  or pulling one. In exchange no pull request ever conflicts on a project file.
- **At the time of writing only the recording side exists.** The corpus is generated and checked in
  CI; the Swift replay arrives with the engine port, and the fake-gateway helper with the first
  integration test. The native workflow already runs when `contract/` changes, and its fake-gateway
  steps are in place but skipped until that test target exists.
