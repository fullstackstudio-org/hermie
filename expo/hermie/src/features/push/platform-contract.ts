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

/** The category an approval notification is posted under, so it grows buttons. */
export const PUSH_REQUEST_CATEGORY = 'hermie.request'

/** Android's two channels: ADR-0017's four types collapse onto exactly these. */
export const PUSH_CHANNEL_DEFAULT = 'default'
export const PUSH_CHANNEL_NEEDS_INPUT = 'needs-input'

/** The two actions an approval notification offers. */
export const PUSH_ACTION_ALLOW = 'allow'
export const PUSH_ACTION_DENY = 'deny'

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
