/**
 * The contracts the platform seams answer, with no platform in them.
 *
 * A `.web.ts` seam replaces its whole module, so a seam that imported its own
 * type from the module it replaces would import itself — on the web,
 * `./secret-store` resolves to `secret-store.web.ts`. Every type two seams
 * share therefore lives here, where neither owns it, and each seam re-exports
 * the ones its callers expect to find next to the implementation.
 *
 * The two imports below are the exception that proves the rule. Both name a
 * FILE FORMAT written by native code — a share extension, an App Intent — and
 * each is owned by the module that parses it. A second declaration of either
 * here would be two spellings of somebody else's bytes.
 */
import type { NetworkKind } from '@hermie/gateway-client'
import type { IntentQueueEntry } from '../features/intents/queue'
import type { ShareOutboxEntry } from '../features/share/outbox'

/** Re-exported so both `net-info` seams name the same four values. */
export type { NetworkKind } from '@hermie/gateway-client'

/**
 * Storage for values that must never land in a plain-text preference file:
 * access and refresh tokens, the ungated session token, and any extra request
 * headers the operator configured.
 *
 * On the web there is no keychain behind this; see `secret-store.web.ts`.
 */
export type SecretStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * The three moments a chat is allowed to buzz.
 *
 * Deliberately a closed set rather than a pass-through of the Expo API. Haptics
 * read as punctuation: one on committing a message, one on committing an answer
 * to a question the agent asked, one when a reply lands. Anything more and the
 * phone is vibrating at the user for things they did not do.
 */
export type HapticMoment = 'send' | 'choice' | 'complete'

/**
 * "Is there a network", as the connection's dial ladder asks it.
 *
 * One subscription that reports the current value immediately and then on every
 * change, and returns its own unsubscribe.
 */
export interface NetworkWatcher {
  subscribe(onChange: (online: boolean) => void): () => void
  /**
   * What kind of link this device says it is on, asked once.
   *
   * Not part of the subscription, because nothing reacts to it: the one reader
   * is the onboarding probe's failure hint, which asks at the moment a probe
   * has already failed. A cellular link is the one answer strong enough to be
   * worth a sentence — it means this device is not on the LAN and, unless a
   * tunnel is up, not on the tailnet either — and `unknown` is a real answer
   * rather than an error, which is what a browser gives.
   */
  kind(): Promise<NetworkKind>
}

/**
 * What this device can ask for before it hands the app back.
 *
 * A closed set rather than the module's own enums, because the only thing any
 * caller branches on is which of four sentences to say and whether the setting
 * may be switched on at all:
 *
 * - `unavailable` there is no hardware, or no module at all. The browser.
 * - `none`        hardware, and nothing enrolled: no face, no finger, no
 *                 passcode. The lock cannot be switched on, because switching
 *                 it on would lock the app with nothing able to open it.
 * - `passcode`    a device passcode and no biometric. The prompt is still
 *                 worth offering; it simply asks for digits.
 * - `biometric`   a face, a finger or an iris is enrolled, with the device
 *                 passcode behind it as the platform's own fallback.
 */
export type BiometricEnrolment = 'unavailable' | 'none' | 'passcode' | 'biometric'

/** What the platform prompt answered. `unavailable` is the module refusing to run at all. */
export type BiometricVerdict = 'ok' | 'failed' | 'unavailable'

/**
 * The device's own "prove it is you", behind one seam.
 *
 * Two methods and no state: the app lock keeps every decision it makes in
 * `features/lock/lock-state.ts`, and this only answers what the hardware can do
 * and what the person in front of it just did.
 */
export interface Biometrics {
  /** False where there is no such prompt at all, which is what the browser answers. */
  readonly available: boolean
  enrolment(): Promise<BiometricEnrolment>
  /** `reason` is the line the platform prints above its own prompt. */
  authenticate(reason: string): Promise<BiometricVerdict>
}

/** Which ink the system status bar draws its clock and indicators in. */
export type StatusBarInk = 'light' | 'dark'

/**
 * What the shell around the app is told about the app's appearance.
 *
 * `ink` is the only half the phones use; `background` exists for the browser,
 * where there is no status bar to tint but there IS a document whose
 * `theme-color` and page background have to follow the theme the visitor
 * pinned. It is handed down rather than read from the theme inside the seam,
 * because the theme provider is what renders this and a seam that imported it
 * back would close a module cycle.
 */
export interface SystemChromeProps {
  ink: StatusBarInk
  /** The app's wallpaper fill, as a CSS-ready colour. */
  background: string
  /**
   * The colour the keyboard's focus ring is drawn in, for the same reason.
   *
   * The document rings every button, row, tab and link from one stylesheet rule
   * — nothing in React can reach a `:focus-visible` selector — and that rule has
   * to be told which accent the visitor's preset is using. Ignored by the
   * phones, which draw no such ring.
   */
  focus: string
}

/**
 * One file the user picked, in whichever form this platform hands it over.
 *
 * `body` is appended to a `FormData` as-is: a `File` in a browser, and the
 * `{uri, name, type}` blob React Native's own `FormData` streams from on the
 * phones and the Mac.
 */
export interface PickedFileSource {
  uri: string
  name: string | null
  /** Bytes. `0` when the platform did not say; the upload then finds out. */
  size: number
  mimeType: string | null
  body: unknown
}

/**
 * The shared container the home-screen widgets read out of.
 *
 * A widget is a separate process with its own sandbox, so nothing the app
 * writes into its own container is visible to one. Everything below writes into
 * the place both sides can reach — an App Group container on Apple platforms, a
 * named `SharedPreferences` file plus the app's files directory on Android —
 * and then asks the platform to redraw.
 *
 * Every method answers `false` rather than throwing when there is nowhere to
 * write. A home screen with no widget on it is the normal case, the web and the
 * Jest environment have no container at all, and none of that is a reason for a
 * message not to arrive.
 */
export interface WidgetBridge {
  /** Whether this platform has a shared container at all. */
  readonly available: boolean
  /** Replace the snapshot file and ask the platform to reload every timeline. */
  writeSnapshot(json: string): Promise<boolean>
  /** Put one PNG in the container, as raw base64 with no data-URL prefix. */
  writeAvatar(botName: string, base64: string): Promise<boolean>
  /** Delete every avatar whose bot is not in `keep`. Answers how many went. */
  pruneAvatars(keep: readonly string[]): Promise<number>
}

/**
 * The other direction through the same shared container: what another app gave
 * Hermie through the system's share sheet.
 *
 * The widget bridge writes; this one only reads and deletes. That asymmetry is
 * the whole design — the writer is a process this app does not control and
 * cannot talk to, so the two halves meet at a directory of versioned JSON
 * (`features/share/outbox.ts`) and nowhere else.
 *
 * `files` is resolved natively rather than joined here because only the native
 * side knows where its own container is: an App Group directory on Apple
 * platforms, the app's own files directory on Android, where `ACTION_SEND`
 * reaches the app process directly and no group is needed.
 */
export interface ShareInbox {
  /** Whether this platform can receive a share at all. */
  readonly available: boolean
  /** Every entry waiting, unparsed. Answers `[]` rather than throwing. */
  list(): Promise<ShareOutboxEntry[]>
  /** Delete one entry and its copied files. Answers whether anything went. */
  clear(id: string): Promise<boolean>
  /**
   * Put `share-targets.json` where the share extension can read it.
   *
   * The one call in this seam that goes OUTWARDS, and it is here rather than in a
   * seam of its own because it answers to the same platform capability: a
   * platform that cannot receive a share has nothing to tell a sheet either. See
   * `features/share/targets.ts` for what the bytes say and ADR-0026 for why an
   * extension needs them.
   *
   * Answers false where there is no container, which is every platform but iOS.
   */
  writeTargets(json: string): Promise<boolean>
}

/**
 * What a Shortcut asked for, and where the answer goes.
 *
 * The third traffic through the same shared container, and the only one that
 * runs in both directions inside one second: an App Intent writes a request,
 * opens the app, and polls for a result while the app writes one. See
 * `features/intents/queue.ts` for the format and for the budget both sides
 * share.
 *
 * `indexBots` is the odd one out and is here rather than in a fourth seam
 * because it answers to the same platform capability — App Intents and
 * Spotlight are the same story from the person's side, which is "Hermie's bots
 * are things the system knows about".
 */
export interface IntentQueue {
  /** Whether this platform has Shortcuts at all. */
  readonly available: boolean
  /** Every request waiting, unparsed. Answers `[]` rather than throwing. */
  list(): Promise<IntentQueueEntry[]>
  /** Write the answer and drop the request. Answers whether anything moved. */
  complete(id: string, result: string): Promise<boolean>
  /**
   * Put the roster in the system's own search index.
   *
   * Called when the widget snapshot changes, because that is exactly when the
   * roster the system should know about has changed. Answers `false` where
   * there is no index.
   */
  indexBots(bots: readonly { name: string; label: string; subtitle: string }[]): Promise<boolean>
}

/**
 * The browser tab's name for a screen.
 *
 * Shared rather than owned by the web seam because both shells compute the
 * screen half and only one platform has a tab to put it in — and because a
 * `.web.ts` seam cannot import a value from the module it replaces.
 *
 * `undefined` means "nothing more specific than the app", which is what the
 * exported document already says, so the app name is returned alone rather than
 * as a separator with nothing before it.
 */
export function formatPageTitle(screen: string | undefined, app = 'Hermie'): string {
  return screen && screen !== app ? `${screen} · ${app}` : app
}

/**
 * One thing to say out loud.
 *
 * `language` is a BCP-47 tag or nothing; nothing means "the device's own", which
 * every engine here already defaults to. `rate` is a multiplier where 1 is the
 * platform's normal speaking rate — deliberately relative rather than words per
 * minute, because none of the three engines behind this agrees on an absolute.
 */
export interface SpeechUtterance {
  text: string
  language?: string
  rate?: number
  /** Speaking finished on its own. Never called for an utterance that was stopped. */
  onDone?: () => void
  /** The engine refused or failed. The caller treats this as "move on". */
  onError?: () => void
}

/**
 * Speaking, as the one call the app makes.
 *
 * `available` is a fact about the platform rather than about permission: there
 * is no permission to speak on any of the three targets, so a `false` here means
 * the browser has no `speechSynthesis` at all. Every method is safe to call when
 * it is `false` — they do nothing — because the alternative is a guard at every
 * call site that would be wrong the moment a fourth target appeared.
 *
 * It is deliberately NOT a queue. Queueing is a decision about which reply a
 * reader wants next and it belongs above the platform, in `features/voice/reader.ts`;
 * a seam that queued would make "stop everything" mean two different things on
 * two platforms.
 */
export interface SpeechEngine {
  readonly available: boolean
  /** Say this, interrupting whatever was being said. */
  speak(utterance: SpeechUtterance): void
  /** Silence, now. Any `onDone` still pending is dropped rather than fired. */
  stop(): void
}

/** Why a recognizer stopped, in the only four shapes a caller acts on. */
export type RecognitionFailure = 'permission' | 'no-speech' | 'unavailable' | 'failed'

/** What a microphone permission request came back with. */
export type RecognitionPermission = 'granted' | 'denied' | 'unavailable'

export interface RecognitionRequest {
  /** BCP-47. Nothing means the device's own language. */
  language?: string
  /**
   * Keep listening through pauses.
   *
   * Off for push-to-talk, where the reader's finger is the end of the utterance;
   * on for voice mode, where a silence IS the end and the loop wants one final
   * result rather than a session that restarts under it.
   */
  continuous?: boolean
  /** Text so far, replaced on every event. Never final. */
  onPartial?: (text: string) => void
  /** The recognizer's own answer. Fired at most once per session. */
  onFinal?: (text: string) => void
  /** Input level, roughly 0…1, where the platform reports one. */
  onVolume?: (level: number) => void
  onError?: (failure: RecognitionFailure) => void
  /** The session is over, however it ended. Always the last callback. */
  onEnd?: () => void
}

/**
 * Listening, as the one call the app makes.
 *
 * `available` answers "is there a recognizer here at all" and nothing about
 * permission — a phone whose owner has refused the microphone is still a phone
 * with a recognizer, and the two facts drive different copy: a missing
 * recognizer hides the button, a refused permission explains itself and offers
 * Settings.
 */
export interface RecognitionEngine {
  readonly available: boolean
  /** Ask the platform. Safe to call repeatedly; the system only prompts once. */
  requestPermission(): Promise<RecognitionPermission>
  /**
   * BCP-47 tags this device can actually recognise OFFLINE, or an empty list.
   *
   * Empty means "this platform will not say", not "none" — Android below API 31
   * has no way to answer and a browser has none at all — so the caller offers
   * the device's own language alone rather than an empty picker. Asking the
   * platform beats a list in this repository, which would be a promise about
   * somebody else's models that goes stale the first time one ships.
   */
  supportedLanguages(): Promise<string[]>
  start(request: RecognitionRequest): void
  /** Stop listening and ask for a final result. */
  stop(): void
  /** Stop listening and throw away what was heard. */
  abort(): void
}
