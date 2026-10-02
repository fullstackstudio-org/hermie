/**
 * The seam between ADR-0017 and whatever the platform calls a notification.
 *
 * Three implementations answer this: `platform.ts` through `expo-notifications`
 * on iOS and Android, `platform.web.ts` through a service worker and the Push
 * API in a browser, and a hand-written object in a test. Everything above this
 * line — the store, the registration projection, the action validation — is
 * ordinary TypeScript with no native module in it, which is what makes the parts
 * that matter testable without a device.
 *
 * It is deliberately small. Obtaining an address, dropping it, asking for
 * permission, and hearing that somebody tapped something is the entire surface;
 * deciding what to do about any of it belongs on the other side.
 */

import type { PushAddress } from '@hermie/gateway-client/push'

/** ADR-0017's payload, as far as the app is willing to read it. */
export interface PushPayloadData {
  /** The bot whose chat this is about. */
  bot?: unknown
  /** `message`, `request`, `cron`, `cron_done`, `cron_failed`, `turn_done`, `turn_failed`. */
  type?: unknown
  /** The approval or clarify this notification was raised for. */
  requestId?: unknown
  /** Hermie Web's spelling of `requestId` before the push contract; read as a fallback. */
  request?: unknown
  /** The session it happened in. `session` is Hermie Web's older spelling of it. */
  sessionId?: unknown
  session?: unknown
  /** `canonical`, `branch` or `other`; absent where the notifier could not read a title. */
  sessionKind?: unknown
  [key: string]: unknown
}

/** One tap, with whichever action it carried. */
export interface PushResponse {
  /**
   * The button, or the platform's own "the notification itself was tapped".
   *
   * `allow` and `deny` are ours, from the category below. Anything else — and
   * every value on a platform that has no categories — is a plain open.
   */
  actionIdentifier: string
  data: PushPayloadData
}

export type PushPermission = 'granted' | 'denied' | 'undetermined'

/** What `obtainAddress` needs from the app to ask the platform for an address. */
export interface PushAddressRequest {
  /** `extra.eas.projectId`, which is what mints an Expo token. Native only. */
  projectId: string | null
  /**
   * Where to fetch the VAPID public key. Browser only, and same-origin in
   * practice: the daemon serves both the page and `/push/vapid-public-key`.
   */
  vapidUrl: string | null
}

/**
 * Why this device has no push address.
 *
 * It exists because of a silence. `obtainAddress` answered `null` for five
 * unrelated reasons — no EAS project id, a `getExpoPushTokenAsync` that threw,
 * a token with no `data`, a browser with no service worker, a daemon serving no
 * VAPID key — and the caller could not tell them apart, so Settings said
 * nothing and the owner's gateway held a `hermie-app.push` with a live
 * heartbeat and `registrations: {}`. That is a device that looks registered
 * from the inside and is not, which is the one state this feature must not be
 * able to reach quietly.
 *
 * `message` is the platform's own words, kept verbatim and truncated. It is the
 * whole diagnosis on this path: "no valid 'aps-environment' entitlement" and
 * "Invalid uuid" are different problems with the same shape.
 */
export type PushAddressFailure =
  | { reason: 'no-project-id' }
  /** The platform cannot mint one here at all: no worker, no VAPID key served. */
  | { reason: 'unsupported'; message?: string }
  /** The call came back, with nothing in it. */
  | { reason: 'empty' }
  | { reason: 'failed'; message: string }

/**
 * What `obtainAddress` answers.
 *
 * `address` OR `failure`, never neither: a `null` address with no reason is
 * exactly the silence this type replaces.
 */
export type PushAddressResult =
  { address: PushAddress; failure?: never } | { address: null; failure: PushAddressFailure }

/** The platform's own message, trimmed to something a settings row can hold. */
export const MAX_PUSH_FAILURE_MESSAGE = 200

export function pushFailureMessageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')

  return raw.replace(/\s+/gu, ' ').trim().slice(0, MAX_PUSH_FAILURE_MESSAGE) || 'no message'
}

/*
  The push contract (`contract/push/contract.json`) and the ids that came
  before it.

  Compatibility window, one release: the senders are fixed in the same change
  (Hermie Web here, the gateway plugin in its own repository) but neither the
  senders nor this app update in lockstep, so this build reads both spellings:

    what                 contract (new)          before the contract (old)
    category id          hermie.request          request (plugin), hermie.approval (Hermie Web)
    action ids           hermie.request.allow    allow
                         hermie.request.deny     deny
    request id key       requestId               request (Hermie Web)
    Android channels     one per type, id=type   default, needs-input

  An updated sender emits only the contract's ids; the Expo app 0.1.9 already
  registers `hermie.request` and reads `requestId`, and posts a notification
  whose channel it never created on its fallback channel, so it keeps working
  with one. The legacy entries below can be removed once no supported sender
  predates the contract: the plugin and Hermie Web releases that carry it are
  the floor, which is the release after this one.
*/

/** The category an approval notification is posted under, so it grows buttons. */
export const PUSH_REQUEST_CATEGORY = 'hermie.request'

/**
 * Categories older senders used for the same notification, registered with the
 * same two actions for the compatibility window. `request` is the plugin's
 * (it sent the type as the category, so a clarify carries it too — its buttons
 * find no open approval and open the chat, which is the safe answer).
 * `hermie.approval` is Hermie Web's.
 */
export const LEGACY_PUSH_REQUEST_CATEGORIES: readonly string[] = ['request', 'hermie.approval']

/**
 * Android's channels: one per type, the id equal to the type name, as the
 * contract says and as the plugin has always addressed them.
 */
export const PUSH_CHANNELS: readonly { id: string; type: string; name: string; urgent: boolean }[] = [
  { id: 'message', type: 'message', name: 'Messages', urgent: false },
  { id: 'request', type: 'request', name: 'Needs your input', urgent: true },
  { id: 'cron', type: 'cron', name: 'Scheduled reports', urgent: false },
  { id: 'cron_done', type: 'cron_done', name: 'Scheduled runs finished', urgent: false },
  { id: 'cron_failed', type: 'cron_failed', name: 'Scheduled runs failed', urgent: false },
  { id: 'turn_done', type: 'turn_done', name: 'Replies finished', urgent: false },
  { id: 'turn_failed', type: 'turn_failed', name: 'Replies failed', urgent: false }
]

/**
 * The channel a notification with NO channel id lands on, which is what Hermie
 * Web sent before the contract. Kept for the compatibility window above.
 */
export const PUSH_CHANNEL_DEFAULT = 'default'

/**
 * The 0.1.9 channel for questions. No sender ever addressed it (the plugin used
 * the type names, Hermie Web no channel at all), so this build no longer
 * creates it; an upgraded device keeps the one it has.
 */
export const PUSH_CHANNEL_NEEDS_INPUT = 'needs-input'

/** The two actions an approval notification offers, as the contract names them. */
export const PUSH_ACTION_ALLOW = 'hermie.request.allow'
export const PUSH_ACTION_DENY = 'hermie.request.deny'

/** The same two actions as the Expo app 0.1.9 and its web worker registered them. */
export const LEGACY_PUSH_ACTION_ALLOW = 'allow'
export const LEGACY_PUSH_ACTION_DENY = 'deny'

/**
 * The payload types that carry those two buttons.
 *
 * Only a blocked agent has an answer a button could send. A message, a DM and a
 * cron delivery have nothing to decide, so they are posted plain and a tap on
 * one is an ordinary open.
 */
export const PUSH_TYPES_WITH_ACTIONS: readonly string[] = ['request']

/**
 * Where a permission dialog does not exist and only System Settings can grant.
 *
 * Measured on the Mac build, which is the iPad binary running under
 * `isiOSAppOnMac` (ADR-0011): `requestPermissionsAsync` resolves without ever
 * showing a prompt, and nothing happened until the owner turned Hermie on by
 * hand in System Settings → Notifications — after which registration worked
 * first time.
 *
 * The old code treated that resolution like any other refusal and put the
 * switch back, so the screen said "off" about a decision nobody had been asked
 * to make and offered a button that appeared to do nothing. Naming the
 * condition is what lets the switch stay where the reader put it and the row
 * say where to go.
 */
export const MAC_NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'

export interface PushPlatform {
  /** False where there is no notification machinery at all, and nothing throws. */
  readonly available: boolean
  /** `ios`, `android` or `web`. Written into the registration as a label. */
  readonly platform: string
  /**
   * True where asking raises no dialog and only System Settings can grant.
   *
   * A property rather than something inferred from `Platform`, so a test can
   * stage a Mac without a Mac and so the one place that knows stays the one
   * place that knows.
   */
  readonly needsSystemSettings: boolean
  /** Open the pane that grants it. False where there is no such pane. */
  openSystemSettings(): Promise<boolean>
  /** Register channels and categories. Idempotent; safe to call on every launch. */
  prepare(): Promise<void>
  permission(): Promise<PushPermission>
  /** Ask, if the platform still allows asking. Returns the settled answer. */
  requestPermission(): Promise<PushPermission>
  /** The address to register, or the concrete reason there is not one. */
  obtainAddress(request: PushAddressRequest): Promise<PushAddressResult>
  /** Let the platform go: unsubscribe a browser, forget a token natively. */
  dropAddress(): Promise<void>
  /** Every tap while the app is running. Returns its own teardown. */
  onResponse(handler: (response: PushResponse) => void): () => void
  /**
   * The tap that STARTED this process, once.
   *
   * `consume` rather than `get`, for the reason `deep-link.ts` gives about a
   * launch URL: a value that is true for the life of the process is a value a
   * remount would act on again, and reopening the launch chat on every Fast
   * Refresh is exactly the bug that shape produces.
   */
  consumeInitialResponse(): Promise<PushResponse | null>
}

/** Read a notification's data defensively: it arrived from a push service. */
export function pushDataOf(value: unknown): PushPayloadData {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as PushPayloadData) : {}
}
