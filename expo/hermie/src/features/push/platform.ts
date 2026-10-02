/**
 * `expo-notifications`, behind `PushPlatform`.
 *
 * Everything device-specific about ADR-0017 is in this file, and there is
 * deliberately no decision in it: it asks for permission, it obtains an Expo
 * token, it declares Android's channels and the Allow/Deny category, and it
 * reports taps. What a tap MEANS is `actions.ts`, which is pure.
 *
 * **The token is an address, not a credential.** ADR-0017's threat model says
 * so: `ExponentPushToken[…]` is where the Expo Push API delivers, and the worst
 * a holder can do with one is make a phone buzz with a payload that says a bot's
 * name. That is why it is written into `ui_meta` rather than the secret store,
 * and why nothing here treats losing it as an error worth surfacing.
 *
 * **Two Android channels, not four.** ADR-0017 notifies on four things, but a
 * channel is the unit the OWNER tunes in system settings, and the distinction
 * they actually care about is "a bot is waiting on me" versus everything else.
 * A question with a countdown on it gets `MAX`; a message, a DM and a cron
 * delivery share `default`. Splitting further would give somebody four sliders
 * to discover and three of them would always be set the same way.
 */
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Linking, Platform } from 'react-native'

import { RUNS_ON_MAC } from '../../platform/runs-on-mac'

import {
  MAC_NOTIFICATION_SETTINGS_URL,
  PUSH_ACTION_ALLOW,
  PUSH_ACTION_DENY,
  PUSH_CHANNEL_DEFAULT,
  PUSH_CHANNEL_NEEDS_INPUT,
  PUSH_REQUEST_CATEGORY,
  pushDataOf,
  pushFailureMessageOf,
  type PushAddressResult,
  type PushPermission,
  type PushPlatform,
  type PushResponse
} from './platform-contract'

/**
 * How a notification behaves while the app is in front.
 *
 * It still appears. The app cannot know whether the reader is looking at the
 * chat the notification is about — that is the whole reason ADR-0017's
 * suppression is a heartbeat the DAEMON reads rather than something decided here
 * — and swallowing it locally would hide the one case the heuristic is allowed
 * to get wrong.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
})

const permissionOf = (status: Notifications.PermissionStatus, canAskAgain: boolean): PushPermission => {
  if (status === 'granted') {
    return 'granted'
  }

  // `undetermined` on iOS becomes `denied` with `canAskAgain: false` once the
  // reader has said no, and the difference decides whether Settings offers a
  // button or an explanation.
  return status === 'undetermined' || canAskAgain ? 'undetermined' : 'denied'
}

const responseOf = (response: Notifications.NotificationResponse): PushResponse => ({
  actionIdentifier: response.actionIdentifier,
  data: pushDataOf(response.notification.request.content.data)
})

/** `extra.eas.projectId` from app.config.ts, as the runtime reports it. */
export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined
  const id = extra?.eas?.projectId

  return typeof id === 'string' && id ? id : null
}

let prepared = false

export const pushPlatform: PushPlatform = {
  available: true,
  platform: Platform.OS,
  /*
    The Designed-for-iPad build on macOS. `requestPermissionsAsync` resolves
    there without ever raising a prompt, so an app that read that as a refusal
    was reporting a decision nobody was asked to make.
  */
  needsSystemSettings: RUNS_ON_MAC,

  async openSystemSettings() {
    try {
      await Linking.openURL(MAC_NOTIFICATION_SETTINGS_URL)

      return true
    } catch {
      // A macOS that will not open the pane, or an iPhone where this URL means
      // nothing. The row still says where to go; only the shortcut is missing.
      return false
    }
  },

  async prepare() {
    if (prepared) {
      return
    }

    prepared = true

    try {
      await Notifications.setNotificationCategoryAsync(PUSH_REQUEST_CATEGORY, [
        {
          identifier: PUSH_ACTION_ALLOW,
          buttonTitle: 'Allow',
          // Neither action answers anything by itself — see `actions.ts` — so
          // both bring the app to the front, where the request can be re-read
          // against the gateway before anything is sent.
          options: { opensAppToForeground: true }
        },
        {
          identifier: PUSH_ACTION_DENY,
          buttonTitle: 'Deny',
          options: { opensAppToForeground: true, isDestructive: true }
        }
      ])
    } catch {
      // A category that could not be registered costs the two buttons and
      // nothing else: the notification still arrives and still opens the chat.
    }

    if (Platform.OS !== 'android') {
      return
    }

    try {
      await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_DEFAULT, {
        name: 'Messages',
        importance: Notifications.AndroidImportance.DEFAULT
      })
      await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_NEEDS_INPUT, {
        name: 'Needs your input',
        importance: Notifications.AndroidImportance.MAX
      })
    } catch {
      // Same: a channel that failed to register leaves the platform's own
      // fallback channel, which delivers.
    }
  },

  async permission() {
    const current = await Notifications.getPermissionsAsync()

    return permissionOf(current.status, current.canAskAgain)
  },

  async requestPermission() {
    const current = await Notifications.getPermissionsAsync()

    if (current.status === 'granted') {
      return 'granted'
    }

    if (!current.canAskAgain) {
      // Asking again does not show a dialog; it resolves with the same refusal.
      // Settings says so rather than appearing to do nothing.
      return 'denied'
    }

    const next = await Notifications.requestPermissionsAsync()

    return permissionOf(next.status, next.canAskAgain)
  },

  /**
   * Mint an Expo token, or say precisely why not.
   *
   * Every branch here used to answer a bare `null`, and the three reasons are
   * three different jobs for whoever reads it: a build with no EAS project can
   * never register and needs a rebuild; a throw is usually an entitlement or a
   * network and is worth retrying; an empty `data` is Expo answering something
   * nobody expected. The owner's gateway held a heartbeat and no registration
   * at all because all three looked identical from up here.
   */
  async obtainAddress(request): Promise<PushAddressResult> {
    if (!request.projectId) {
      // No EAS project is a build that cannot mint a token. It is a
      // configuration fact, not a failure at runtime — see app.config.ts.
      return { address: null, failure: { reason: 'no-project-id' } }
    }

    try {
      const token = await Notifications.getExpoPushTokenAsync({ projectId: request.projectId })

      return token.data
        ? { address: { transport: 'expo', token: token.data } }
        : { address: null, failure: { reason: 'empty' } }
    } catch (error) {
      // No network, a device with no APNs entitlement, a project id that does
      // not resolve. The platform's own words are the whole diagnosis.
      return { address: null, failure: { reason: 'failed', message: pushFailureMessageOf(error) } }
    }
  },

  async dropAddress() {
    // Nothing to release. An Expo token is minted per installation and stays
    // valid; what unregisters this device is the row leaving `ui_meta`, which
    // is the store's job. Releasing it here would also invalidate it for a
    // second gateway this device may still be registered with.
  },

  onResponse(handler) {
    const subscription = Notifications.addNotificationResponseReceivedListener(response =>
      handler(responseOf(response))
    )

    return () => subscription.remove()
  },

  async consumeInitialResponse() {
    const response = await Notifications.getLastNotificationResponseAsync()

    if (!response || consumed.has(response.notification.request.identifier)) {
      return null
    }

    consumed.add(response.notification.request.identifier)

    return responseOf(response)
  }
}

/**
 * Identifiers already handed out by `consumeInitialResponse`.
 *
 * `getLastNotificationResponseAsync` keeps answering the same tap for the life
 * of the process, so without this a remount — or a Fast Refresh — would act on
 * it again. A set rather than a boolean because the value can legitimately
 * change: a second cold start through a different notification is a different
 * identifier, and that one should be acted on.
 */
const consumed = new Set<string>()
