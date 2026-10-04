# Contributing to Hermie

Thanks for taking the time. This document covers the toolchain, the checks that have to pass, and
the conventions that are easy to get wrong.

## What you need installed

| Tool        | Version                                 | Needed for         |
| ----------- | --------------------------------------- | ------------------ |
| Node        | 22 or newer (`.nvmrc` pins the minimum) | everything         |
| npm         | 10 or newer                             | workspaces         |
| Xcode       | 16.1 or newer                           | iOS and Mac builds |
| CocoaPods   | 1.15 or newer                           | the iOS pods       |
| JDK         | 17                                      | Android builds     |
| Android SDK | platform 36, build-tools 36, NDK 27.1   | Android builds     |

The native Apple apps under `native/` need **Xcode 26** or newer and
[XcodeGen](https://github.com/yonaskolb/XcodeGen) instead; see [The native Apple apps](#the-native-apple-apps).

A Mac build needs one more thing: an **Apple Developer team**. It is the iOS app
built for the "Designed for iPad" destination, and that configuration runs App
Store validation, so it cannot be built unsigned. Set `HERMIE_APPLE_TEAM_ID` to
your ten-character team identifier.

Set `ANDROID_HOME` to your SDK location (usually `~/Library/Android/sdk` on macOS) before building
for Android. Those versions are not a guess: `cd expo/hermie/android && ./gradlew -q app:properties`
prints what `expo-root-project` resolved, and that is what has to be installed.

Any JDK 17 works — React Native 0.81 / AGP 8 want 17, not 21 and not 11. On macOS,
`brew install --cask temurin@17` needs `sudo` for its installer; `brew install openjdk@17` does not,
but it is keg-only, so `/usr/libexec/java_home -v 17` cannot see it and `JAVA_HOME` has to name the
keg directly:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
```

## Getting set up

```sh
nvm use
npm ci
```

`npm ci` installs the husky hooks through the `prepare` script. If you cloned without a git
repository the hook install is skipped, which is fine.

## The checks

Everything below runs in CI on every pull request, and you can run it locally in the same order:

```sh
npm run typecheck              # tsc -b across all workspace projects
npm run lint                   # eslint
npm run format                 # prettier --check
npm test                       # vitest: the workspace packages
npm run test:app               # jest-expo: the app
npm run sync:hermes-shared:check   # drift check on the vendored protocol sources
npm run golden:check           # contract/ still matches the TypeScript reference
npm run contrast:check         # every ink clears AA on every composited surface
```

`npm run contrast` prints the whole table instead of only the failures. It reads
`expo/hermie/src/ui/tokens.ts`, so a colour changed there is measured there — see
`scripts/check-contrast.ts` for what "composited" means and why a token measured
against a token proves nothing.

`npm run format:write` and `npm run lint:fix` apply the automatic fixes.

## Running the app

```sh
npm run ios
npm run android
npm run mac                       # needs HERMIE_APPLE_TEAM_ID
npm run mac -- --no-open          # build only
npm run mac -- --debug            # against Metro
```

The Metro bundler is shared: `npm run start --workspace @hermie/app` starts it once and serves all
three, because the Mac IS the iOS bundle — see
[docs/adr/0011-mac-via-the-ipad-build.md](docs/adr/0011-mac-via-the-ipad-build.md).

`npm run mac` generates `ios/` if it is missing, installs pods when `Podfile.lock` has moved on,
builds Release for `platform=macOS,variant=Designed for iPad`, and then wraps the product: a bare iOS
`.app` fails to open with "incorrect executable format", so it goes inside
`Hermie.app/Wrapper/Hermie.app` with a relative `WrappedBundle` symlink beside it.

### The web client

The browser client lives in `native/web` (see its [README](native/web/README.md)) and is served by the
`hermie` gateway plugin, not by a process of this repository —
[ADR-0030](docs/adr/0030-web-client-served-by-the-plugin.md) is the decision. The standalone Hermie Web
server that used to serve the Expo web export is gone. The client has its own commands and its own CI
jobs:

```sh
npm run fake-gateway -- --auth cookie   # a stand-in gateway on 127.0.0.1:9119
npm run client:dev                  # Vite, at http://localhost:5173/dashboard-plugins/hermie/app/index.html
npm run client:build                # dist/ with build.json; source maps go to dist-maps/
npm run client:test                 # vitest + jsdom
npm run client:check-bundle         # extension, size, ASCII and build.json gates on dist/
npm run client:check-reproducible   # the same commit must build to the same bytes
```

`client:check-reproducible -- --fresh-checkout` additionally builds `git archive HEAD` in another directory
with its own `npm ci`, and needs everything committed. If you add a dependency or a Vite plugin and the check
goes red, the output names the files that differ.

## The fake gateway

`packages/fake-gateway` stands in for `hermes serve`. It speaks the public status endpoints, both
authentication flows, the native PKCE round trip, single-use WebSocket tickets and the JSON-RPC
surface the app calls, with two scripted bots.

```sh
npm run fake-gateway                       # port 9119, no authentication
npm run fake-gateway -- --auth token       # session-token gateway; prints the token
npm run fake-gateway -- --auth native      # gated: PKCE sign-in and WebSocket tickets
npm run fake-gateway -- --port 9200 --close-code 4403 --scenario ./replies.json
```

```sh
curl localhost:9119/api/status
```

In `--auth native` the authorize page renders an "Approve as tester" button; adding `?auto=1` to the
authorize URL redirects straight to the loopback callback, which is what the tests use. A scenario
file is `{ "replies": [{ "match": "...", "deltas": ["..."], "tool": { "name": "...", "result": "..." } }] }`.

The same server is importable, so tests drive it in-process:

```ts
import { startFakeGateway } from '@hermie/fake-gateway'

const gateway = await startFakeGateway({ auth: 'token' })
gateway.closeSockets(4403) // or dropSockets() for an abrupt 1006
```

`--passkey` (with `--auth cookie` or `native`) makes it play a gateway that verifies a `confirm` with a
passkey; [packages/fake-gateway/README.md](packages/fake-gateway/README.md) has the routes, the control
calls and the software authenticator the tests use. `--mcp` (same auth modes) makes it serve the page of
Settings that lists and revokes MCP clients; the shapes are `contract/gateway/mcp.md`.

From the app, Settings → **Connection test** is a developer screen that probes an address and opens
a real connection to it in session-token mode. On an Android emulator the host machine is
`http://10.0.2.2:9119`, never `localhost`.

To work against a real gateway, [docs/test-gateway.md](docs/test-gateway.md) sets one up from
scratch.

## Opening the app on one screen (development only)

Most of the interface is behind a tap, and `xcrun simctl` has no tap, swipe or
rotate verb — there is no `Simulator.app` on this machine, and `idb`, `fbsimctl`,
`maestro` and `appium` are all absent (see
[docs/platform-notes.md](docs/platform-notes.md)). Some tooling can drive a
simulator by other means, but none of it can rotate one, and a tool that works
from screenshot coordinates will miss a screen that re-renders under it.

Launch arguments need none of that. They are deterministic, they cost no
coordinate arithmetic, and they are the only thing that still works when two
changes are in flight against one Metro instance — so a Debug build reads them:

```sh
xcrun simctl launch <udid> dev.hermie.app \
  --initialUrl http://localhost:8081 \
  --hermieOpen gallery:sheet-options-model-page \
  --hermieTheme dark --hermiePreset graphite
```

| Argument                       | Opens                                                        |
| ------------------------------ | ------------------------------------------------------------ |
| `--hermieOpen gallery:<id>`    | one gallery section, alone, filling the screen               |
| `--hermieOpen gallery:chat`    | the gallery's whole chat screen                              |
| `--hermieOpen sheet:<name>`    | shorthand for that sheet's section                           |
| `--hermieOpen chat:<handle>`   | the real chat screen for that bot                            |
| `--hermieOpen overlay:<s>[/p]` | `activity`, `crons`, `settings`, and a settings page¹        |
| `--hermieTheme light\|dark`    | pin the scheme (a simulator's appearance cannot be set here) |
| `--hermiePreset <name>`        | pin the theme: `blue`, `graphite` or `lime`                  |
| `--hermieGateway <url>`        | seed that gateway's configuration and skip onboarding        |
| `--hermieToken <token>`        | the session token to seed beside it                          |

¹ The settings pages are `connection`, `gallery`, `licences`, `logs`, `memory` and `themes` —
`--hermieOpen overlay:settings/logs`. Every one of them is behind a tap, and a simulator this
machine can only launch cannot tap; a page nobody can open is a page nobody photographs.

**`--hermieGateway` is how you reach a connected app without typing.** `chat:`
and `overlay:` need a configured gateway, and configuring one meant completing
the five-step wizard on the simulator by hand — finding a field in a screenshot,
typing an address, waiting for a probe, typing a token, tapping through a
connection test. That is what kept `docs/screenshots/` stale through three design
passes. With the fake gateway running in session-token mode:

```sh
npm run fake-gateway -- --auth token --token demo

xcrun simctl launch <udid> dev.hermie.app \
  --initialUrl http://localhost:8081 \
  --hermieGateway http://localhost:9119 --hermieToken demo \
  --hermieTheme light --hermiePreset blue --hermieOpen chat:researcher
```

It writes the same two stores the wizard's Done step writes, in the same shape,
through the same `saveGatewaySetup` and `configFromDraft` — so what you photograph
afterwards is the app a reader gets, not a code path that only exists for
screenshots. It does NOT probe, so Settings shows "Unknown" for the gateway
version and the user until a real wizard run fills those in. An address with no
scheme is read as `http://`, unlike the wizard's resolver, because there is no
probe here to discover which one answers and the only gateways this names are a
loopback port or a LAN address. `--hermieToken` on its own does nothing: a
credential with no gateway beside it is a secret in the keychain that no stored
configuration explains. Only the session-token flow can be seeded — a native PKCE
credential is minted by a round trip through an identity provider and there is
nothing to copy from a command line.

**On Android the same grammar arrives as Intent extras**, because `adb` cannot set
a process argument vector. `modules/hermie-dev-launch` reads
`getIntent().getExtras()` and flattens each string extra into the `--flag value`
pair the parser already takes, so a key is spelled without the dashes:

```sh
adb shell am force-stop dev.hermie.app
adb shell am start -a android.intent.action.VIEW \
  -n dev.hermie.app/.MainActivity \
  -d 'exp+hermie://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081' \
  --es hermieGateway http://10.0.2.2:9119 --es hermieToken demo \
  --es hermieTheme light --es hermiePreset blue \
  --es hermieOpen chat:researcher
```

Two things that are only true here. `MainActivity` is `launchMode="singleTask"`,
so `getIntent()` keeps answering the intent the activity was **created** with — a
second `am start` against a live process lands in `onNewIntent` and changes
nothing, which is why the force-stop above is not optional. And the `-d` URL is
`expo-dev-client`'s, not ours: without it a Debug build stops on its launcher
instead of loading Metro's bundle. The emulator reaches the host at `10.0.2.2`,
never `localhost`.

`--hermieOpen=<value>` works too. Section ids come from `GALLERY_SECTION_IDS` in
`expo/hermie/src/features/settings/GalleryScreen.tsx`, which is the registry the
gallery renders from — adding a component to the kit means adding a row there, and
that is what keeps "one launch, one screenshot" true for the next component as
well. `sheet:` shorthands are pinned against that list by
`__tests__/dev-launch-intent.test.ts`.

A gallery section needs no gateway and no onboarding: it is decided before the
connection phase is, so a clean simulator is enough. `chat:` and `overlay:` do
need a configured gateway — which is what `--hermieGateway` above is for.

**None of this reaches a release build.** On Apple platforms that is three
independent gates: the native constant it reads is inside `#if DEBUG` in
`modules/hermie-mac/ios/HermieMacModule.swift`, the JavaScript is behind
`__DEV__`, and nothing is registered with the system — no URL scheme, no
`CFBundleURLTypes`, no entitlement. Launch arguments are visible only to the
process itself.

Android has the `__DEV__` gate and a different first one, and the difference is
worth stating rather than glossing. A library's `BuildConfig.DEBUG` is not a
trustworthy stand-in for `#if DEBUG`, so `HermieDevLaunchModule` checks the
application's own `FLAG_DEBUGGABLE` instead — set by the debug manifest merge and
by nothing else, so a release APK reads no extras. That is a **runtime** gate: the
code is present in a release APK, it just never sees an extra. The third gate does
not hold at all — `MainActivity` is `exported`, because a launcher activity has to
be, so any app on the device can start it with extras. `FLAG_DEBUGGABLE` is what
makes that harmless in anything shipped.

What the `__DEV__` gate removes was measured on 2026-09-20 rather than assumed
(`npx expo export:embed --platform ios --dev false`): in the production bundle the
native property `devLaunchArguments` appears zero times, `DEV_LAUNCH_INTENT`
compiles to the literal `null`, and `seedDevGateway` compiles to a function whose
whole body is `return false` — the `saveGatewaySetup` call is not in the bundle.
`parseDevLaunchArguments` IS still there with the flag names as string literals,
because Metro does not drop a module export, so `strings` on a release bundle will
find `--hermieGateway`. Nothing calls it and nothing can, since the intent it
would feed is folded to `null`. The argument is inert in Release; its parser is
not absent.

## Native projects

- `expo/hermie/ios` and `expo/hermie/android` are **generated**. They are not committed. Change
  `expo/hermie/app.config.ts` or a config plugin under `expo/hermie/plugins/`, never the generated
  files — `npx expo prebuild --clean` will throw your edits away. There is no third native project:
  the Mac is the iOS one.
- `expo/hermie/modules` holds local Expo modules, and is **committed**. There are two. `hermie-mac`
  exposes what React Native has no equivalent for: `ProcessInfo.processInfo.isiOSAppOnMac`, two
  keyboard answers, an allow-list of desktop shortcuts, a `UIContextMenuInteraction` host view
  (`HermieContextMenuView` — there is no secondary-click event in React Native at all) and Hermie's
  own menu in the Mac's menu bar. Adding a Swift file to that module needs no project change — the
  podspec globs `**/*.swift` — but it DOES need `pod install` before the next build, or the new file
  is simply not compiled and the symbol is missing with no error anywhere. `hermie-scene` has no JavaScript side at all: it ships the
  `UIWindowSceneDelegate` that `plugins/with-ios-scene-lifecycle.js` names in `Info.plist`, without
  which **iOS 27 refuses to launch the app** — see the 2026-09-20 section of
  [docs/platform-notes.md](docs/platform-notes.md). Expo autolinks anything under `modules/` with no
  configuration, so a module needs `package.json`, `expo-module.config.json` and its native sources
  and nothing else. Note that a module's `ios/` directory is **not** the generated project: ignore
  rules that say `ios/` without anchoring will swallow it, which `npx expo-doctor` catches.
- **Test an iOS change on the iOS 27 runtime, not only on 26.5.** The scene-life-cycle crash above
  was invisible on every other surface: 26.5 simulators only warn, and the Mac build never checks.
  And a `simctl launch` that prints a pid proves nothing — that crash printed one too. Follow it with
  `xcrun simctl spawn <udid> launchctl list | grep hermie` a few seconds later.

## The native Apple apps

The iPhone, iPad and Mac apps are being rebuilt natively in SwiftUI under `native/`, next to the Expo
app, which keeps shipping until they replace it. Android and the browser still build from
`expo/hermie` and are not part of the rebuild.

[docs/native.md](docs/native.md) is the guide: the package targets and what may import what, the
concurrency rules, the `native/apple/scripts/` that generate, build and test, and how the port is kept
in step with the TypeScript packages through `contract/`. Two things to know before touching either
side:

- **A change to `packages/transcript`, to the gateway client's pure functions or to
  `packages/fake-gateway` can change `contract/`.** Run `npm run golden` and commit what it rewrites in
  the same pull request; `npm run golden:check` fails CI otherwise.
- **The Xcode projects are generated.** Change `native/ios/project.yml`, `native/macos/project.yml`
  or `native/apple/xcodegen/base.yml`, never a `.xcodeproj`.

## Vendored protocol sources

`packages/hermes-shared` holds files copied from NousResearch/hermes-agent at a pinned commit. Do
not edit them directly — ESLint and Prettier skip the directory, and
`npm run sync:hermes-shared:check` fails on any difference.

The pin and the file list live in `packages/hermes-shared/upstream.json`; the rewrites live in
`scripts/sync-hermes-shared.mjs`. To take a newer upstream commit: bump `commit`, run
`npm run sync:hermes-shared`, read the diff, run `npm test`. Both sync modes fetch from
`raw.githubusercontent.com`, so they need network access.

A rewrite marked required that stops matching fails the sync loudly rather than producing a file
that silently no longer works. When that happens, read the upstream file before touching the
pattern. [packages/hermes-shared/README.md](packages/hermes-shared/README.md) documents each
rewrite and why it exists.

## Screenshots

`docs/screenshots/` is what the README shows, so treat it as published material.

- **Fixture data only.** The bots in those images are the fake gateway's Researcher and Writer, with
  its scripted commands and transcripts. No real gateway address, no real bot, no real conversation,
  and nothing that names a person.
- **Strip the metadata.** A screenshot carries EXIF and XMP that nobody looks at and everybody
  publishes. Remove it before committing — and check that you did: `sips -s format png` does NOT
  strip it, it WRITES it, adding an `eXIf` chunk and an Adobe XMP packet to a file that had
  neither. Drop the `eXIf`, `iTXt`, `tEXt`, `zTXt` and `tIME` chunks and keep `IHDR`, `gAMA`,
  `cHRM`, `IDAT` and `IEND`; `xxd file.png | grep -ic exif` should answer 0.
- **Say what is in the picture.** Every image in the README has alt text that describes the screen,
  not the file.

## Releasing

[docs/release.md](docs/release.md) is the process: the version numbers and the script that sets all
three of them, what a `v*` tag sets off, and the TestFlight and Play steps that are still done by
hand. A Mac release is the iOS one — there is no separate artefact to sign.

`npm run android:release` builds the signed app bundle and APK. The upload key it signs with is four
`HERMIE_UPLOAD_*` properties in your own `~/.gradle/gradle.properties` — never in this repository,
and never quoted, because a properties file keeps the quote characters.

The icons are generated, not drawn per size. `design/icon.svg` is the source; `npm run icons`
rewrites every PNG from it and `npm run icons:check` — which CI runs — fails if one of them has
drifted. Never edit a PNG in `expo/hermie/assets` directly.

The same two commands also rewrite the Play listing's feature graphic and 512 px icon from
`design/store/feature-graphic.svg` and `design/icon.svg`; [docs/release.md](docs/release.md)
describes both.

## Commits

Conventional commits, in the imperative, in English:

```
feat(chats): resume the canonical session on connect
fix(gateway-client): mint a fresh ticket for every dial
docs(adr): record why the Mac is the iPad build
chore(deps): move to Expo SDK 54.0.37
```

Common types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`.
`commitlint` enforces the format in a `commit-msg` hook.

Two rules beyond the format, enforced by `scripts/check-commit-message.mjs` in the same hook and
over the whole branch in CI:

- **No trailers.** `Co-Authored-By:` and `Signed-off-by:` are rejected. Authorship is the commit
  author field; if a change genuinely has two authors, say so in the body in prose.
- **No tooling boilerplate.** Phrases like "generated with" or "generated by" are rejected. A commit
  message explains the change, not how it was typed.

To check a branch before opening a pull request:

```sh
node scripts/check-no-trailers.mjs origin/main..HEAD
```

## Pull requests

Keep them scoped to one thing. Fill in the template: what changed, why, and how you verified it.
State plainly which platforms you actually built and ran — "not verified on Android" is useful
information and nobody will hold it against you. A Mac build and a Mac RUN are different claims: the
build is scripted, and the run needs a window nobody else's copy is already holding.
