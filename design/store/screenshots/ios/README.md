# App Store screenshots

What an App Store Connect listing shows. Everything here was captured from iOS
simulators running the app against `packages/fake-gateway`, so no image contains
a real gateway, a real bot or a person's name — the same rule
[CONTRIBUTING.md](../../../../CONTRIBUTING.md) sets for `docs/screenshots/`, and
it matters more here because a store listing is the most-read surface the project
has. The Play set beside this one is
[../../README.md](../README.md), and the reasoning it records about PNG chunks,
fixtures that look like defects and times that are not 9:41 applies here too.

Plain device screenshots, no marketing frame and no overlaid text. Apple accepts
them, and a frame drawn around a picture of a phone is a second thing to keep in
step with the app.

## The two sizes, and the one that is missing

App Store Connect asks for **one iPhone size and one iPad size** and treats the
rest as optional. Since 2024 the required pair is the 6.9-inch iPhone and the
13-inch iPad, and each simulator below reports **exactly** one of the pixel sizes
that size accepts — so nothing between the capture and the upload resizes
anything. Every size in the table was measured from the file, not assumed.

| Device                | Points      | Scale | Captured  | App Store size  |
| --------------------- | ----------- | ----- | --------- | --------------- |
| iPhone 17 Pro Max     | 440 × 956   | 3×    | 1320×2868 | 6.9-inch iPhone |
| iPad Pro 13-inch (M5) | 1032 × 1376 | 2×    | 2064×2752 | 13-inch iPad    |

**There is no 6.5-inch set** (1284×2778 / 1242×2688). It has not been required
since Apple made the 6.9-inch set stand in for every iPhone size, and producing
it would need an iOS 16-era runtime for an iPhone 11 Pro Max or XS Max, which
this machine does not have installed. If a future submission does ask for it,
install that runtime and add a third entry to `DEVICES` in
[`scripts/screenshots-ios.mjs`](../../../../scripts/screenshots-ios.mjs); the
script refuses a capture whose size is not the one the entry declares, so a wrong
device cannot be published as a right one.

## 6.9-inch iPhone

| File                                  | Size      | What it shows                                                                                                                                               |
| ------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iphone69-01-chats-dark.png`          | 1320×2868 | The chat list: Boards, New bot and Edit inline in the header, the search field, and both bots with green presence beads and blue unread dots.               |
| `iphone69-02-conversation-dark.png`   | 1320×2868 | One conversation: a Mermaid flowchart of the token-refresh path, then a typeset geometric series and the figures that follow from it, each with its footer. |
| `iphone69-03-options-dark.png`        | 1320×2868 | The chat options, as a popover: the shared-or-own conversation switch, YOLO and Fast mode, reasoning effort, model and colour.                              |
| `iphone69-04-memory-dark.png`         | 1320×2868 | The memory graph: the researcher's entries as small nodes, the topics they mint as labelled ones, and the edges between them.                               |
| `iphone69-05-crons-dark.png`          | 1320×2868 | The crons: Active over Paused, each row with its schedule, its delivery target, its profile and its next run.                                               |
| `iphone69-06-appearance-light.png`    | 1320×2868 | Settings → Appearance in the light scheme: bot names, chat text size, and the Blue, Graphite and Lime theme presets.                                        |
| `iphone69-07-conversations-light.png` | 1320×2868 | A bot's Conversations page: the shared Bot Chat against your own, the current conversation, and what `/new` has put away.                                   |

## 13-inch iPad

| File                                | Size      | What it shows                                                                                                                             |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ipad13-01-chats-dark.png`          | 2064×2752 | The two-column shell: the chat list as a sidebar with a pinned chat above a Writing folder, and the conversation in the column beside it. |
| `ipad13-02-conversation-dark.png`   | 2064×2752 | The same conversation on the wide layout: the Mermaid flowchart and the formula, with the list still in place beside them.                |
| `ipad13-03-options-dark.png`        | 2064×2752 | The chat options as a popover over the wide column.                                                                                       |
| `ipad13-04-memory-dark.png`         | 2064×2752 | The memory graph, with room for every label.                                                                                              |
| `ipad13-05-crons-dark.png`          | 2064×2752 | The crons panel sliding over the conversation, the chat list undimmed beside it.                                                          |
| `ipad13-06-board-dark.png`          | 2064×2752 | A Kanban board **in the content column** — Triage, To do and Scheduled side by side, which is the layout R20 made reachable at all.       |
| `ipad13-07-appearance-light.png`    | 2064×2752 | Settings → Appearance in the light scheme, over the chat column.                                                                          |
| `ipad13-08-conversations-light.png` | 2064×2752 | The Conversations page in the content column, the list still beside it.                                                                   |

Six dark and two light on the iPad, five dark and two light on the phone. The
dark scheme leads because it is the one the design was drawn against (the
iPadOS 26 Messages reference in `docs/platform-notes.md`), and both schemes are
in the set because a listing that only ever shows one leaves the reader
wondering whether the other exists.

## Three things in these images that look like defects and are not

- **researcher's avatar is a plain crimson disc with no letter.** The fake
  gateway answers `has_avatar` for every profile but `writer`, and the asset it
  serves is a 1×1 half-opaque red PNG — deliberately flat, so a run against it
  shows at a glance that `profiles.get_asset` was fetched and rendered rather
  than quietly falling back to a generated initial.
- **`Weekly digest` is red in the crons images.** That job's fixture carries
  `last_status: "error"`, so the row shows the failure its last run reported.
- **The header floats over the transcript.** The bot's name is a glass pill over
  the conversation rather than a bar above it, so a row can be half under it.
  That is the design.

## What is not here, and why

- **The voice overlay.** It is drawn only while `useVoiceMode` reports
  `available`, which is `engine.available && speech.available` — a real speech
  recognizer and a real synthesiser. A simulator has neither, so the microphone
  is not merely disabled but absent from the composer, and the options sheet
  does not offer voice mode either. **That scene needs a device.**
- **A board on the phone.** The board is in the set once, on the iPad, because
  the side-by-side columns are the thing worth showing; a phone stacks them and
  the picture says less than the chat list does.

## Making them again

### The gateway, Metro and the build

A **Debug** build, because the launch arguments are gated off in Release
(`expo/hermie/src/dev/launch-intent.ts` gives the three gates). Pick free ports
rather than the defaults if anything else is listening:

```sh
npm run fake-gateway -- --auth token --token devtoken --port 9119 --host 127.0.0.1
npm run start --workspace @hermie/app -- --port 8081

cd expo/hermie && npx expo prebuild --platform ios
cd ios && LANG=en_US.UTF-8 pod install
xcodebuild -workspace Hermie.xcworkspace -scheme Hermie -configuration Debug \
  -sdk iphonesimulator -destination 'id=<udid>' -derivedDataPath /tmp/hermie-dd \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES
xcrun simctl install <udid> /tmp/hermie-dd/Build/Products/Debug-iphonesimulator/Hermie.app
```

**Do not build with `CODE_SIGNING_ALLOWED=NO`.** It produces a binary with no
entitlements, the keychain then refuses every write with `-34018`, and
`--hermieGateway` fails with _"the stored gateway could not be read; opening
setup instead"_ — which looks like a broken seed and is a missing signature.
Ad-hoc signing (`CODE_SIGN_IDENTITY="-"`) is enough and is what the line above
does. `LANG=en_US.UTF-8` is there because CocoaPods 1.17 on Ruby 4 throws
`Unicode Normalization not appropriate for ASCII-8BIT` without it.

### One launch, one screenshot

```sh
xcrun simctl terminate <udid> dev.hermie.app
xcrun simctl launch <udid> dev.hermie.app \
  --initialUrl http://localhost:8081 \
  --hermieGateway http://127.0.0.1:9119 --hermieToken devtoken \
  --hermieOpen chat:researcher --hermieTheme dark
```

`design/store/README.md` documents the same grammar for Android. On the **first**
launch after an install, `expo-dev-client` puts its own onboarding sheet over the
app — dismiss it once per device, or it will be in the picture.

### The two things that are state, not launch arguments

Both survive relaunches, so they are done once per gateway and then forgotten:

- **The pinned chat and the folder.** Long-press a row for **Pin**, long-press
  the other for **New folder**, and name it. Dragging a row into a folder by its
  handle is the other way and it does not survive `touch_path` from a script —
  three attempts were read as taps. The arrangement is stored per gateway, so a
  second simulator against the same gateway comes up already arranged.
- **The diagram and the formula.** The fixtures answer a prompt containing
  `mermaid` and one containing `math`; type them into the composer and send.
  The transcript is the shared Bot Chat, so once it is done on one device every
  device against that gateway shows it.

A hardware keyboard swallows the first few characters after a field is focused —
twice in this round only `Draw.` and `Do.` arrived — so read the composer before
sending, and delete with the on-screen ⌫ (a long press on it deletes a word).

### The script

```sh
npm run screenshots:ios                     # the whole set, pausing per scene
npm run screenshots:ios -- --device ipad13  # one device
npm run screenshots:ios -- --list           # the file names it would write

node scripts/screenshots-ios.mjs capture <udid> <out.png> 1320x2868
node scripts/screenshots-ios.mjs scale <in.png> <out.png> 1200x1600
```

It launches each scene, prints the taps a launch argument cannot do, captures on
Return, refuses any file whose size is not the device's declared one, and
re-encodes every image from its pixels so that only `IHDR`, `IDAT` and `IEND`
reach the repository. `HERMIE_SHOT_GATEWAY`, `HERMIE_SHOT_METRO`,
`HERMIE_SHOT_TOKEN`, `HERMIE_SHOT_IPHONE` and `HERMIE_SHOT_IPAD` override the
addresses and the two udids.

To check a file you did not make:

```sh
python3 - <<'PY'
d = open("ipad13-06-board-dark.png","rb").read(); i = 8
while i < len(d):
    n = int.from_bytes(d[i:i+4],"big"); print(d[i+4:i+8].decode()); i += 12+n
PY
```
