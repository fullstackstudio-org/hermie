# hermie-intents

Hermie in Shortcuts, in Siri and in Spotlight.

## The shape of it

```
 Shortcuts / Siri                     Hermie
 ────────────────                     ──────
 HermieAskIntent ──┐                  ┌──────────────────────┐
 (app target)      │  writes request  │  intents/pending/    │ ── read ──▶ IntentRunner
                   ├─────────────────▶│                      │              (JavaScript)
                   │                  │  intents/results/    │◀── write ───┘
                   └── polls result ──┘                      │
                                      └──────────────────────┘
```

Four actions, and the interesting decision is which of them need the app:

| Action                 | Opens the app | Waits         |
| ---------------------- | ------------- | ------------- |
| **Ask a bot**          | yes           | for the reply |
| **Send to a bot**      | yes           | no            |
| **Open a chat**        | yes           | no            |
| **Bots needing input** | **no**        | no            |

The last one reads the widgets' snapshot and returns, so it works from an
automation while the phone is locked. The other three need the gateway session,
which lives in JavaScript inside the app behind a socket — so `openAppWhenRun`
brings the app forward and `perform()` continues in the app's own process.

## Why the Swift is in two places

| Path                            | Compiled into      | Why                                                                                                                      |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `ios/HermieIntentsModule.swift` | the pod            | It is an ordinary Expo module; JavaScript calls it.                                                                      |
| `intents/*.swift`               | **the app target** | `AppShortcutsProvider` must live there, and App Intents metadata is extracted per target from that target's own sources. |

`plugin/with-hermie-intents.js` copies the second group into the app's group and
Sources phase. The podspec's `source_files` deliberately stops at its own
directory so the same file is never compiled twice — that would be a
duplicate-symbol link error.

## The budget

`HermieIntentQueue.budget` (45s) and `INTENT_BUDGET_MS` in
`src/features/intents/queue.ts` are the same number, and they have to be: a
requester that gives up before the answerer leaves a result nobody reads, and
the reverse leaves Shortcuts spinning over an app that has already finished.

Plenty of real prompts take longer than 45 seconds. One that does returns a
sentence saying so and pointing at **Send to a bot**, which does not wait at
all. Raising the number would trade a clear message for a spinner.

The two sides do not start spending the budget at the same moment: the Swift side
begins polling the instant it writes the request, and the JavaScript side only
reaches the send after a launch, a dial and a hydration. So `IntentRunner` hands
the reply watch what is LEFT of the 45 seconds rather than the whole of it, and
the app therefore gives up a moment before Shortcuts does — which is the right
way round, because the alternative writes an answer into a file nobody is reading
any more.

## Things that fail silently, and what guards them

- **A phrase with no `.applicationName` in it.** Siri matches a phrase only when
  it contains the app's name. Without the token the phrase is never matched, and
  nothing reports it. `__tests__/ios-intents-plugin.test.ts` pins that every
  phrase carries one.
- **Sources copied into a directory nothing compiles.** The app builds, it
  launches, and there are simply no Shortcuts. `assertCompiled` fails the
  prebuild instead.
- **A budget that drifted.** Same test pins the two numbers against each other.
- **A Spotlight tap that opens the app and goes nowhere.** A tap arrives as a
  user activity React Native does not answer. `modules/hermie-scene` turns it
  back into the `hermie://chat/<bot>` link the item was indexed under.

## What needs a device

All of it. What has tests is the JavaScript half — the queue format, the runner,
the reply watch — and the plugin's pure parts. What has not been seen is a
phrase spoken to Siri, an action in the Shortcuts gallery, or a bot in Spotlight.
`docs/platform-notes.md` says so in the same words.
