# Releasing Hermie

Two halves. The half a machine can do on its own — build the Android artefacts and
publish them against a tag with the right CHANGELOG section — is
`.github/workflows/release.yml`. The half that needs an account someone owns —
TestFlight and Play internal testing — is written out below, because it is done by
hand until somebody decides otherwise.

**The Mac is not a third release.** Since
[ADR-0011](adr/0011-mac-via-the-ipad-build.md) it is the iOS build, and Apple
offers an iPhone/iPad app on Apple Silicon Macs from the same App Store listing
unless it is opted out under **App Store Connect → the app → Pricing and
Availability**. A TestFlight tester on a Mac installs the same build the same way.
So there is nothing Mac-specific to build, sign, notarise or upload; `npm run mac`
exists for developing, not for releasing.

## Version numbers

One number, written down in seven places, plus the matching entries in
`package-lock.json`:

- the root `package.json`;
- the app's `package.json`;
- `version` in `expo/hermie/app.config.ts`;
- Hermie Web's `package.json`, which `/hermie/update` and the container image report;
- the desktop shell's `package.json`, `tauri.conf.json` and `Cargo.toml`.

Setting them by hand is how some of them end up stale; a test in `packages/hermie-web`
fails when they disagree. So:

```sh
npm run set-version -- 0.2.0            # the marketing version
npm run set-version -- 0.2.0 --check    # report, change nothing
```

The script fails if a pattern stops matching rather than skipping the file. Read
the diff before committing it.

There used to be a fourth place and a `--build` flag for it: the hand-maintained
macOS `Info.plist` carried both the marketing version and `CFBundleVersion`,
because nothing generated them. Both are gone.

### The build number comes from git, and so does the commit in Settings

`app.config.ts` reads two things from git when the config is evaluated:

| `extra.commit`      | `git rev-parse --short HEAD` | `dev` when there is no git |
| ------------------- | ---------------------------- | -------------------------- |
| `extra.buildNumber` | `git rev-list --count HEAD`  | `1` when there is no git   |

`ios.buildNumber` and `android.versionCode` are both derived from
`extra.buildNumber`, so the three can never disagree, and the commit count is the
only monotonic number a git history hands out for free — which is exactly what
App Store Connect and Play want, since both refuse a second upload with a number
they have already seen. Settings shows all three as one line,
`Hermie 0.1.0 (68) · 79ad86d`, so a screenshot names the tree it came from.

Two consequences worth knowing. **A shallow clone lies**: `rev-list --count` on
`fetch-depth: 1` answers `1`, so any CI job that produces an uploadable build
needs the full history (`fetch-depth: 0`). And **neither call may fail the
build** — both are wrapped, and a checkout with no git simply gets the defaults.

EAS still has `autoIncrement` on the `production` profile; where it applies it
wins over the value above, and the two agree on direction either way.

`eas.json` sets `cli.appVersionSource` to **`local`**: the version EAS builds is
the one in `app.config.ts`, in the commit being built. The alternative,
`remote`, keeps it on EAS's servers, which is convenient for a team that
releases from a dashboard and wrong for a repository where the tag is the record:
with `remote`, the number EAS builds and the number in the commit drift apart with
nothing to catch it. Local keeps the tag, the CHANGELOG and every platform on the
same number.

## Cutting a release

1. `main` is green: `npm run typecheck && npm run lint && npm run format && npm test && npm run test:app`,
   and `npm run web:build` exports.
2. Turn `## [Unreleased]` in `CHANGELOG.md` into `## [0.2.0] - YYYY-MM-DD`, and open a
   fresh empty `Unreleased` above it. Add the link definition at the foot of the
   file. Check what the release notes will say:
   ```sh
   node scripts/changelog-section.mjs 0.2.0
   ```
3. `npm run set-version -- 0.2.0`.
4. Commit (`chore(release): 0.2.0`), tag, push:
   ```sh
   git tag v0.2.0
   git push origin main v0.2.0
   ```
5. The tag triggers two workflows. `ci.yml` runs the checks and both native
   builds; `release.yml` builds the Android artefacts and publishes a GitHub
   release with them attached and the CHANGELOG section as its notes.
6. Then the store halves, below.

A release can also be rehearsed without a tag: run **Release** from the Actions
tab. It builds and uploads the artefact and skips the publish step.

## What the automated release produces

| Artefact                     | What it is                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- |
| `Hermie-android-debug.apk`   | A debug-signed APK, installable on any device with unknown sources allowed. |
| `Hermie-android-release.apk` | Signed with the upload key — only when the signing secrets below are set.   |
| `Hermie-android-release.aab` | The app bundle Play takes — only when the signing secrets below are set.    |
| `hermie-web.zip`             | Hermie Web: the compiled server, the exported browser bundle and its bin.   |
| `SHA256SUMS`                 | Digests of everything above, generated from what actually reached the job.  |

The debug APK is built unconditionally, and it is a **debug** build on purpose:
an unsigned APK cannot be installed at all, so a fork with no key still gets
something a person can put on a phone. The two release artefacts appear only when
the four secrets are there; without them the job builds the debug APK and nothing
fails.

`hermie-web.zip` is the whole web variant and needs no signing: it is a Node
package with no runtime dependencies, which is why the zip carries no
`node_modules` and the install instructions' `npm ci --omit=dev` is a no-op
today. `SHA256SUMS` is not decoration — a running Hermie Web refuses to install a
self-update the file does not list, and refuses bytes whose digest does not match
(ADR-0015). It is generated from the artefact directory rather than written by
hand, so an artefact that failed to build cannot quietly pass unverified.

There is no iOS or Mac artefact here, and there cannot be a useful one: an iOS app
that anybody can install has to be signed by a real Apple Developer team, which is
what TestFlight and the App Store are for.

## Secrets

All of these are repository secrets in GitHub → Settings → Secrets and variables
→ Actions. Every one of them is optional: with none set, the release workflow
still produces a working debug-signed APK, which is what a fork gets.

| Secret                          | Used for                                                  |
| ------------------------------- | --------------------------------------------------------- |
| `EXPO_TOKEN`                    | An EAS access token, if EAS builds are ever moved into CI |
| `HERMIE_UPLOAD_KEYSTORE_BASE64` | The upload keystore itself, `base64 -i hermie-upload.jks` |
| `HERMIE_UPLOAD_STORE_PASSWORD`  | Its store password                                        |
| `HERMIE_UPLOAD_KEY_ALIAS`       | `hermie-upload`                                           |
| `HERMIE_UPLOAD_KEY_PASSWORD`    | The key's own password                                    |

The four Android ones are read as a group: `release.yml` checks whether the
keystore secret is empty and skips the signed build when it is, the way the macOS
Developer ID signing used to be guarded. The job decodes the keystore into
`$RUNNER_TEMP` — never the workspace, where an `upload-artifact` glob could reach
it — passes the other three as `ORG_GRADLE_PROJECT_HERMIE_UPLOAD_*` environment
variables, which is how Gradle takes a project property from the environment, and
deletes the file in an `if: always()` step.

**Do not quote the secret values.** They arrive as Gradle properties, and a
properties file does not strip quotes, so `"secret"` is a password with two quote
characters in it. That failure surfaces as a `BadPaddingException` from deep inside
AGP; the config plugin checks the keystore up front and says so instead.

The Developer ID certificate, its password, the notary service Apple ID and its
app-specific password were all for the macOS `.app`, and that artefact no longer
exists — a Mac user installs from TestFlight or the App Store, where EAS holds the
credentials.

## The application identifier

`dev.hermie.app` — `ios.bundleIdentifier` and `android.package` in
`expo/hermie/app.config.ts`, and the keychain access group that follows from it. It
used to be `nl.fullstackstudio.hermie`, an App ID stuck in a personal Apple team that
cannot be moved to the paid one; nothing had ever been uploaded under it, so renaming
it cost nothing but a prebuild. A build made before the change keeps its own data: the
identifier is the container, so an installed copy is a different app to the system and
has to be signed in again once.

## The accounts, and what is still owed on each

Both halves of the store release used to be blocked on an account with a payment
behind it. Neither is any more. What is left is one irreversible step and one thing
this repository cannot answer. Written down here so the next reader does not spend
an afternoon rediscovering it.

- **The paid Apple Developer team exists**: team id `FDGV4X8F27`, which is what
  `HERMIE_APPLE_TEAM_ID` should name. It buys more than the listing. A free Apple ID
  signs an app with a **7-day** provisioning profile, so a build installed on a device
  or on a Mac stops launching a week later and has to be rebuilt; a paid team's
  profiles last a **year**. `npm run mac` works either way — it takes whatever
  `HERMIE_APPLE_TEAM_ID` names — which is why a Mac build made against a free team
  still "breaks" after a week for no other reason.
  A Mac that has never built this app also has to be added to the team's device
  list first, and `-allowProvisioningUpdates` alone will not do it: it renews
  profiles for devices the team already knows, and for a new one automatic
  signing fails with "doesn't include the currently selected device".
  `npm run mac` therefore passes `-allowProvisioningDeviceRegistration` as well,
  so a fresh machine registers itself on its first build instead of sending
  somebody to the developer portal.
- **The Android upload keystore exists.** A signed APK and app bundle build today —
  done on 2026-09-21; see the Android section below and the end of
  `docs/platform-notes.md`.
- **Play App Signing is reported on for the app.** It is a Play Console setting, so
  nothing in this repository can show it and this line records what the owner said
  rather than something checked here. Follow what it implies, though: App Signing is
  configured per app inside a Play Console account, so if it is on, that account and
  an app entry already exist. The repository says nothing either way — `eas.json` has
  an empty `submit.production` and no Play service-account key is referenced anywhere
  — so the state of the Console account is **unverified here**. Confirm it with the
  owner instead of inferring it from this bullet or the one below.
- **Registering the upload key with Play has not happened**, as far as anything here
  records. It happens once per app and **cannot be undone**: the key registered first
  is the key every later upload has to be signed with, for the life of the listing.
  It is the one step in this document worth stopping to check before doing — and the
  check is with the owner, in the Console, not in this repository.
- **An Expo project exists** and `extra.eas.projectId` in `app.config.ts` names it. It
  is there for push: a device needs it to obtain a push token and the push credentials
  live on it ([ADR-0017](adr/0017-push-through-hermie-web.md)). Nothing is built or
  served through it.

Neither the keystore nor the Apple team belongs in this repository. The keystore is
a secret and the Apple team is an account, so both live with the owner; nothing here
should ever hold either.

## iOS: TestFlight

**Not EAS.** The route is Xcode's own two steps — `xcodebuild archive` and
`xcodebuild -exportArchive` — run against a checkout that has been prebuilt.
EAS was the obvious alternative and is not used: it ties the repository to one
Expo account, keeps the signing certificates on Expo's servers, and puts a
second build number source next to the one `app.config.ts` derives from git.
`extra.eas.projectId` stays where it is — it is for push and nothing else
([ADR-0017](adr/0017-push-through-hermie-web.md)).

Nothing here runs in CI. It needs a signed-in Xcode and an account someone owns,
which is the same reason the Play half is written out rather than automated.

### What has to exist first

- The paid Apple team, `FDGV4X8F27`, and an Xcode signed in to it. See
  **The App Group and the three App IDs** below for exactly what the developer
  portal ends up holding and how much of it appears by itself.
- **An app record in App Store Connect**, with bundle id `dev.hermie.app`. The
  archive and the export do not need it — they only talk to the developer
  portal — but the upload does, and it fails with a bundle-id error that does
  not say "create the app first". Make it under **Apps → +** with name `Hermie`,
  primary language English (U.S.), SKU `hermie`.
- **An App Store Connect API key** for the upload, created under **Users and
  Access → Integrations → App Store Connect API → Team keys**, role **App
  Manager**. The `.p8` downloads exactly once. `altool` looks for it at
  `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`.

- **The account's own paperwork.** The **Free Apps Agreement** has to be Active
  under **Business → Agreements** — it is the one a free app and TestFlight need;
  the Paid Apps Agreement is only for charging money and can stay unsigned. The
  EU **trader status** under the same section is separate and is not optional:
  the Digital Services Act makes Apple verify and display trader contact details
  for anyone distributing in the EU, and an account that has not answered it
  cannot distribute there — external TestFlight included. It is a legal
  declaration about the company, so it is the owner's to fill in and nothing
  here can do it.

The key, its Key ID and the Issuer ID are credentials and live with the owner,
outside every checkout, the same way the Android keystore does.

### The App Group and the three App IDs

The iOS app ships as **three signed binaries in one bundle**, and they talk to
each other through one shared container. That is the whole reason this section
exists: a widget cannot dial a gateway and a share extension is killed the
moment its sheet closes, so both of them read and write a file in the App Group
container instead.

| Binary               | App ID                   | Needs the App Group                                |
| -------------------- | ------------------------ | -------------------------------------------------- |
| the app              | `dev.hermie.app`         | yes — it writes the snapshot and drains the outbox |
| the widget extension | `dev.hermie.app.widgets` | yes — it reads the snapshot                        |
| the share extension  | `dev.hermie.app.share`   | yes — it writes into the outbox                    |

The group is `group.dev.hermie.app`, and all three entitlements files name it.
**None of it is written by hand in `app.config.ts`.** Two config plugins own it —
`modules/hermie-widgets/plugin` and `modules/hermie-share/plugin` — and each
adds it to the app's entitlements additively, so whichever runs second is a
no-op. Each also **refuses to prebuild** when its extension's entitlements file
names a different string, because that particular mistake reports itself
nowhere: nothing fails to build, nothing fails to launch, and the only symptom
is a widget that is permanently empty or a share that silently does nothing.
`__tests__/app-group.test.ts` compares all three with each other.

#### What `-allowProvisioningUpdates` creates by itself

On a machine whose Apple ID holds **Account Holder, Admin or App Manager** on
the team, the first archive creates all of this without anyone visiting the
portal:

- the three **App IDs** above, from the bundle identifiers in the project;
- the **App Group** `group.dev.hermie.app`, and the group's membership on each
  of the three App IDs;
- the **capabilities** each App ID needs — App Groups on all three, Push
  Notifications and Keychain Sharing on the app;
- an **Apple Distribution** certificate. A machine that has only ever built for
  development holds only an Apple Development certificate, and this is where the
  distribution one comes from;
- the matching **provisioning profiles**, one per binary.

#### What it does not create, and what to check when it fails

- **An App Store Connect app record.** It is a different service; see the bullet
  above about the bundle-id error that does not say so.
- **Anything at all, on an Apple ID with only the Developer role.** Provisioning
  updates are an account-level write. The failure names the entitlement it could
  not add rather than the permission it lacked, so this is worth ruling out
  first.
- **A group on an App ID that already existed without one.** If `dev.hermie.app`
  was created by hand before the extensions existed, the archive can fail on the
  extension rather than on the app. Adding App Groups to the existing App ID
  under **Certificates, Identifiers & Profiles → Identifiers** is enough;
  the profiles regenerate on the next archive.

#### The team id is not in this repository

There is no `ios.appleTeamId` in `app.config.ts`, no `DEVELOPMENT_TEAM` in any
checked-in build setting, and nothing in `eas.json`. A team id is not a secret
in the cryptographic sense and is exactly one in the sense that matters for a
public repository: it names the account a fork would otherwise be building
against.

So a **fork signs by supplying its own**, and neither route needs a file in the
repository to change:

```sh
# Locally: pass it to the archive.
xcodebuild -workspace Hermie.xcworkspace -scheme Hermie \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your team id> …

# Or in Xcode: select each of the three targets → Signing & Capabilities →
# Team. It has to be set on all three; they are separately signed binaries.
```

EAS resolves the team from the credentials on its own account and needs nothing
here either. `__tests__/app-group.test.ts` asserts that no team id has crept
back into any of these files.

### Building and uploading

```sh
cd expo/hermie
npm ci                                              # from the repository root
npx expo prebuild --platform ios --clean
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install && cd ..
```

`prebuild --clean` matters for the same reason it does on Android: `ios/` is a
gitignored prebuild output, and `ios.buildNumber` is the commit count, so a tree
that prebuilt at 193 and archived at 196 produces an archive carrying 193 —
which App Store Connect refuses if it has seen it, and which silently misreports
the commit in Settings if it has not.

```sh
cd expo/hermie/ios
xcodebuild -workspace Hermie.xcworkspace -scheme Hermie -configuration Release \
  -destination 'generic/platform=iOS' archive \
  -archivePath "$BUILD/Hermie.xcarchive" \
  DEVELOPMENT_TEAM=FDGV4X8F27 \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
```

Then export, with an `ExportOptions.plist` beside it:

```xml
<plist version="1.0"><dict>
  <key>method</key>            <string>app-store-connect</string>
  <key>destination</key>       <string>export</string>
  <key>signingStyle</key>      <string>automatic</string>
  <key>teamID</key>            <string>FDGV4X8F27</string>
  <key>uploadSymbols</key>     <true/>
  <key>manageAppVersionAndBuildNumber</key> <false/>
</dict></plist>
```

`method` is `app-store-connect` on Xcode 15 and later; it was `app-store`
before, and an old value on a new Xcode is a hard error rather than a warning.
`manageAppVersionAndBuildNumber` is **false** on purpose: left at its default,
the export helpfully renumbers the build, which throws away the commit count
and breaks the promise that the number in Settings names the tree it came from.

```sh
xcodebuild -exportArchive \
  -archivePath "$BUILD/Hermie.xcarchive" \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath "$BUILD/export" \
  -allowProvisioningUpdates
```

Check the two things that are wrong more often than the build is, before
uploading anything:

```sh
codesign -d --entitlements :- "$BUILD/export/Hermie.ipa"   # after unzipping, on the .app
```

- **`aps-environment` must read `production`.** The entitlements file in the
  tree says `development`, because that is what a development build needs;
  the App Store profile carries `production` and the export is what swaps it.
  A build that ships `development` registers against the APNs sandbox and every
  push to a TestFlight tester is silently dropped.
- **Both bundles are signed** — `Hermie.app` and the `HermieWidgetsExtension`
  inside it — and both carry `group.dev.hermie.app`. Two sandboxes that
  disagree about the group share nothing, and the failure is a widget that is
  permanently empty rather than an error anybody sees.

Upload with `altool`, validating first because a validation failure costs
seconds and a rejected upload costs a build number:

```sh
xcrun altool --validate-app -f "$BUILD/export/Hermie.ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
xcrun altool --upload-app   -f "$BUILD/export/Hermie.ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
```

Processing takes a few minutes to half an hour. It is done when the build
appears under TestFlight with a state of `VALID`.

### Export compliance

`ITSAppUsesNonExemptEncryption` is already `false` in `app.config.ts`, so the
upload carries the answer and App Store Connect does not ask again per build.
Nothing to click.

### The first external tester

Internal testers are anyone on the team and need no review. The first **external**
build triggers **Beta App Review**, which is a real review with a real wait, and
it needs three things filled in before it will accept the submission:

- **What to test** — one paragraph, per build.
- **Beta App Review Information** — a contact, and sign-in details if the app
  cannot be used without an account. Hermie cannot: it talks to a gateway the
  user runs. So the review gets a reachable gateway and a token, the same way
  the App Transport Security note below explains the architecture.
- **The ATS note**, below. It is the one thing a reviewer actively asks about.

**This is also the Mac release.** Check App Store Connect → Pricing and
Availability and leave "Make this app available on Mac" on; a TestFlight tester on
an Apple Silicon Mac then installs the same build. Nothing else is needed, and
nothing here is Mac-specific.

## Android: the upload key

There are two keys in an Android release and conflating them is the usual
confusion. **Play App Signing** means Google holds the key that signs what users
download; it is generated by Play and nobody here ever sees it. The **upload key**
is ours, and it only proves to Play that an upload came from us. Play will not
accept an upload signed by a key it has not seen registered, and that registration
happens once per app and cannot be undone — so this key has to be kept, and losing
it means asking Play support to reset it.

The keystore lives **with the owner, outside every checkout**, and nothing in this
repository ever holds it, names it or logs it. Its location and its passwords are
four Gradle properties in `~/.gradle/gradle.properties`, which is outside the build
tree and is not read by anything here except Gradle:

```properties
HERMIE_UPLOAD_STORE_FILE=/absolute/path/to/hermie-upload.jks
HERMIE_UPLOAD_STORE_PASSWORD=…
HERMIE_UPLOAD_KEY_ALIAS=hermie-upload
HERMIE_UPLOAD_KEY_PASSWORD=…
```

**Do not put quotes round the values.** A Gradle properties file does not strip
them, so `"secret"` is a password with two quote characters in it, and the failure
arrives as `UnrecoverableKeyException: BadPaddingException` from inside AGP with
nothing pointing at the cause. The path may contain spaces and needs no quoting or
escaping either: it reaches `file()` as one string. `expo/hermie/plugins/with-android-release-signing.js`
opens the keystore before the build starts and says both of these in its error.

The same four can come from the environment instead, which is what CI uses — see
Secrets above.

### Building them

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
npm run android:release                 # prebuild if needed, then .aab and .apk
npm run android:release -- --clean      # regenerate android/ first
npm run android:release -- --aab        # the bundle only
```

**"If needed" now includes "if it has gone stale".** `android/` is a prebuild
output and gitignored, so the first build of a checkout generates it and
everything agrees. Nothing regenerated it afterwards — and `android.versionCode`
is the commit count, which moves with every commit on the branch. A tree that
prebuilt at 133 and released at 192 built a bundle carrying 133, which installs
perfectly and which Play refuses because it has already seen it; the same trap
was open the day `applicationId` changed from `nl.fullstackstudio.hermie`.

So before every build the three values prebuild writes — `versionCode`,
`versionName`, `applicationId` — are read back out of `android/app/build.gradle`
and compared with what `expo config` resolves from `app.config.ts` now. A
mismatch regenerates and says which value moved:

```
Regenerating the native project: versionCode is 133 in android/app/build.gradle; app.config.ts says 192.
```

`--clean` is unchanged and still the bigger hammer: it regenerates whatever the
comparison says. If `expo config` cannot be run at all the check is skipped with
a line saying so, because a release must not be blocked by a check that could not
run.

It prints where the artefacts landed and how big they are. They are
`expo/hermie/android/app/build/outputs/bundle/release/app-release.aab` and
`.../apk/release/app-release.apk`.

**Which key signed a build is in the log**, on the one line beginning `hermie:` —
either the upload key with its alias, or a note that release kept the template's
debug signing because the four values are not all there. That fallback is
deliberate: a fork, and CI without secrets, still build a release. It also means a
missing property produces a **debug-signed release APK**, which installs perfectly
and is refused by Play, so check the line rather than assuming.

To confirm an artefact before uploading, compare its certificate with the
keystore's. The fingerprint is public; the key never leaves the keystore:

```sh
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs app-release.apk
keytool -printcert -jarfile app-release.aab
keytool -list -v -keystore /path/to/hermie-upload.jks -alias hermie-upload
```

All three print the same SHA-256 when the upload key signed it. A build that fell
back to debug signing says `CN=Android Debug` instead, which is the tell.

## Android: Play internal testing

Same shape as iOS:

```sh
cd expo/hermie
eas build --platform android --profile production      # an .aab
eas submit --platform android --latest --track internal
```

`eas submit` needs a Google Play service-account key the first time. The
`production` profile builds an app bundle because that is what Play takes;
`preview` builds an APK, which is what a person can sideload.

**EAS is the alternative to the keystore above, not a companion to it.** `eas build`
manages credentials itself: it will generate an upload keystore and keep it on
Expo's servers, or take yours with `eas credentials`. Either way the key is then in
two places, and which one signed a given upload is worth knowing before Play
rejects one. Pick one — the local properties for builds from this machine and from
CI, EAS if releases move to EAS entirely — and if both are in use, make sure both
hold the _same_ upload key.
The listing's images are in the repository, both halves of it.

**Play.** [design/store/screenshots/](../design/store/screenshots/) holds a phone
set at 1080×1920 and 10" and 7" tablet sets at 2560×1600 and 1920×1200, which is
the three sections Play asks for.
[design/store/README.md](../design/store/README.md) says what each one shows and
how to make them again — including the trap that a 1080×2400 phone capture is
2.22:1 and Play refuses anything wider than 2:1.

**App Store.**
[design/store/screenshots/ios/](../design/store/screenshots/ios/) holds the two
sizes App Store Connect actually requires, captured from simulators whose native
size IS the accepted one, so nothing is resized on the way to the upload:

| Section         | Device                | Files | Size      |
| --------------- | --------------------- | ----- | --------- |
| 6.9-inch iPhone | iPhone 17 Pro Max     | 7     | 1320×2868 |
| 13-inch iPad    | iPad Pro 13-inch (M5) | 8     | 2064×2752 |

Both sets are plain device screenshots, no marketing frame, which the store
accepts. Six scenes per device and then some: the chat list, a conversation
carrying a Mermaid diagram and typeset mathematics, the chat options, the memory
graph, the crons, Settings → Appearance, the Conversations page, and — on the
iPad only — a Kanban board with its columns side by side. Dark leads and light is
represented; [the set's own README](../design/store/screenshots/ios/README.md)
lists scene → file → measured size and how to make them again, and
`npm run screenshots:ios` walks the whole list.

**Two things that set does not have.** There is no 6.5-inch iPhone set
(1284×2778 / 1242×2688): Apple has not required it since the 6.9-inch set began
standing in for every iPhone size, and producing it needs an iOS 16-era runtime
this machine does not have. And there is no voice-overlay scene, because voice
mode is drawn only where a real speech recognizer and synthesiser exist — **that
one needs a device**, not a simulator.

## Before the first store submission

Things that are fine for a source build and not for a store listing. None of
them block a tagged GitHub release.

- **`expo-dev-client` is in the plugin list**, which puts
  `SYSTEM_ALERT_WINDOW` in the Android manifest. Play asks about that
  permission. Move the plugin behind a condition on the EAS profile, or accept
  the question and answer it.
- **The Mac build has been exercised in a real window**, so this is no longer the
  blocker it was. The three things named here before — the keychain, Return-to-send
  and the empty strip under the title bar — were all used by hand on 2026-09-19 and
  are answered in `docs/platform-notes.md`. Two smaller Mac questions are still open
  in that file's summary table: what `AppState` a Mac window reports, and whether a
  mouse drag still scrolls a list now the fix is in. Read the table before the
  listing claims anything specific about the Mac.
- **The accounts above.** The paid Apple team and the Android upload keystore both
  exist, so neither blocks a submission any more. What is left out of that section is
  registering the upload key with Play — once per app, irreversible — and confirming
  a Play Console account, which nothing in this repository can show.
- **Privacy answers.** App Store Connect and the Play data-safety form both ask
  what leaves the device. Hermie sends what the user types to the gateway the
  user configured, and to nothing else; there is no analytics SDK and no
  third-party network call in the app.
- **`ITSAppUsesNonExemptEncryption` is already `false`** in `app.config.ts`, so
  the export-compliance question does not come back on every upload.
- **The App Transport Security exception needs a review note.** See below; it is
  the one thing in this list that a reviewer will actively ask about.

## The App Transport Security note for App Review

`app.config.ts` sets `NSAllowsArbitraryLoads`, and only that key — see ADR-0014 for why adding a
second one switches the first off. Apple asks for a justification whenever a
submission lowers ATS, and the answer has to be in **App Store Connect → the
version → App Review Information → Notes**. Paste this, or something that says
the same thing:

> Hermie is a client for Hermes Agent, a server the user runs themselves. The
> server's address is typed by the user during setup and is not known at build
> time, so a per-domain `NSExceptionDomains` entry cannot be written for it. The
> common deployment is a private VPN — Tailscale or a self-hosted Headscale —
> where the gateway is served over plain HTTP on a tailnet name such as
> `host.tailnet.ts.net`, because WireGuard has already encrypted the path.
> `NSAllowsLocalNetworking` does not cover that case: a MagicDNS name is fully
> qualified, so ATS treats it as an ordinary internet host. The app talks to that
> one user-configured server and to the identity provider it redirects the
> sign-in page to, and to nothing else; it contains no analytics or advertising
> SDK. The app defaults to `https://` when the user types no scheme, only tries
> `http://` when `https://` does not answer at all, never downgrades an address
> the user typed `https://` on, and tells the user when the connection is in the
> clear — with a warning when the address is not on a private network.

[ADR-0014](adr/0014-plain-http-on-private-networks.md) records what was measured
and which narrower options were ruled out, which is the material to draw on if a
reviewer comes back with a follow-up.

Android needs no note. `usesCleartextTraffic` is set through
`expo-build-properties` and Play does not ask about it.

## The icons

`design/icon.svg` is the source. Everything the app ships — the iOS and Android
icons, the adaptive foreground, the splash image and the favicon — is rasterised
from it:

```sh
npm run icons          # rewrite them
npm run icons:check    # fail if any of them is stale (CI runs this)
```

Changing the artwork means editing the SVG and running `npm run icons`, never
editing a PNG. The renderer is deterministic, which is what makes the check
meaningful.

## The Play listing's images

A listing asks for two images the app itself never ships. They live in
`design/store/`, and the same two commands produce and check them — `npm run
icons` runs `scripts/generate-store-assets.mjs` after the app's icons, and
`npm run icons:check` is what CI runs against both.

| File                               | Size       | Where it goes                                 |
| ---------------------------------- | ---------- | --------------------------------------------- |
| `design/store/feature-graphic.png` | 1024 x 500 | The banner across the top of the Play listing |
| `design/store/play-icon-512.png`   | 512 x 512  | The listing's app icon                        |

Both are written with **no alpha channel** — PNG colour type 2, three bytes per
pixel — and with no metadata chunk of any kind. Play refuses a feature graphic
that carries transparency, and the pair come to about 16 kB and 9 kB against a
limit of 1 MB, so neither is anywhere near being too large.

The 512 icon is `design/icon.svg` again, at the one size Play takes, with the
**corners left square**: Play rounds and masks the icon itself, exactly as iOS
and Android do, so a radius baked in here would show as a second one inside the
store's.

The feature graphic's source is `design/store/feature-graphic.svg`, hand-drawn
at 1024 x 500 and rasterised 1:1. It is the mark from `design/icon.svg` at half
scale beside the wordmark, on the icon's own gradient. Two things about that file
are worth knowing before editing it, and its own header comment says both at
length: the renderer **has no font engine**, so "Hermie" is drawn as geometry —
circles, stems and two radial cuts on one set of metrics — rather than set in a
typeface; and a counter is a shape filled with the _same_ gradient painted over
the letter, which lands on exactly the colour underneath because gradients are
evaluated in user space.

It carries the lockup and nothing else. A tagline is the obvious addition and is
deliberately absent: Play crops this image at several aspect ratios, and a line
of copy in it would have to be re-drawn by hand — there is no font engine — for
every language the listing is ever offered in.

The listing also wants screenshots. Those are not generated: `docs/screenshots/`
is what exists, and CONTRIBUTING's "Screenshots" section is the rule for them.
