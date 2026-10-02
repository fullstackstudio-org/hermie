/**
 * Notifications on the Mac, where there is no permission dialog at all.
 *
 * What was reported: on the Mac build the prompt never appeared, the switch
 * moved and came straight back, and nothing worked until the owner turned
 * Hermie on by hand in System Settings → Notifications — after which
 * registration succeeded first time.
 *
 * All of that follows from one fact. The Mac build is the iPad binary running
 * under `isiOSAppOnMac` (ADR-0011), and `requestPermissionsAsync` there
 * resolves without raising anything. The app read that resolution as a refusal,
 * so it put the switch back: a decision reported that nobody had been asked to
 * make, and a control that visibly did nothing.
 *
 * The fix is three behaviours and this suite is one case each:
 *
 *  1. the switch STAYS where the reader put it, pending;
 *  2. the Registration row names the pane and the button opens it;
 *  3. a foreground while it is pending does not undo it — and is the retry,
 *     because coming back from System Settings IS a foreground.
 *
 * Driven entirely through `PushPlatform`, which is what that seam is for: a
 * Mac without a Mac.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { NS_A } from './support/gateway-namespace'

import { NotificationsSection } from '../src/features/push/NotificationsSection'
import type { PushAddress } from '@hermie/gateway-client/push'
import type { PushPermission, PushPlatform } from '../src/features/push/platform-contract'
import { PushSync } from '../src/features/push/push-sync'
import { pushRegistrationState } from '../src/features/push/status'
import { strings } from '../src/i18n/strings'
import { keyValueStore } from '../src/platform/key-value-store'
import { PUSH_KEY, usePushStore } from '../src/store/push'
import { renderScreen } from './support/render'

const TOKEN: PushAddress = { transport: 'expo', token: 'ExponentPushToken[mac]' }

interface MacPlatform extends PushPlatform {
  permissionValue: PushPermission
  opened: number
  /** How many times an address was actually asked for. */
  obtained: number
}

/** The Designed-for-iPad build on macOS: no dialog, and a pane instead. */
function macPlatform(permission: PushPermission = 'undetermined'): MacPlatform {
  const platform: MacPlatform = {
    available: true,
    platform: 'ios',
    needsSystemSettings: true,
    permissionValue: permission,
    opened: 0,
    obtained: 0,
    async openSystemSettings() {
      platform.opened += 1

      return true
    },
    prepare: async () => undefined,
    permission: async () => platform.permissionValue,
    // The whole of the Mac's behaviour: asking resolves, unchanged, silently.
    requestPermission: async () => platform.permissionValue,
    obtainAddress: async () => {
      platform.obtained += 1

      return { address: TOKEN }
    },
    dropAddress: async () => undefined,
    onResponse: () => () => undefined,
    consumeInitialResponse: async () => null
  }

  return platform
}

const syncOn = (platform: PushPlatform) =>
  new PushSync({
    platform,
    namespace: NS_A,
    ports: { showChat: async () => undefined, openApprovals: async () => [], respondApproval: async () => undefined }
  })

beforeEach(async () => {
  usePushStore.getState().reset()
  await keyValueStore.delete(NS_A.key(PUSH_KEY))
  await usePushStore.getState().hydrate(NS_A)
})

describe('turning notifications on', () => {
  it('leaves the switch on and says System Settings rather than reporting a refusal', async () => {
    const platform = macPlatform()
    const sync = syncOn(platform)

    expect(await sync.enable()).toBe('system-settings')

    // The one that was wrong: this used to be false, so the toggle moved back
    // under the finger and the screen said "off" about a question nobody asked.
    expect(usePushStore.getState().enabled).toBe(true)
    expect(usePushStore.getState().address).toBeNull()
  })

  it('still reports a real refusal as one, where a dialog does exist', async () => {
    const platform = macPlatform('denied')

    platform.needsSystemSettings = false

    expect(await syncOn(platform).enable()).toBe('denied')
    expect(usePushStore.getState().enabled).toBe(false)
  })
})

describe('the Registration row', () => {
  it('names the pane and offers to open it', async () => {
    const platform = macPlatform()
    const sync = syncOn(platform)

    renderScreen(<NotificationsSection push={sync} />)
    fireEvent.press(screen.getByTestId('settings-push-enabled'))

    await waitFor(() => expect(screen.getByTestId('settings-push-system-settings')).toBeTruthy())

    expect(screen.getByTestId('settings-push-status')).toHaveTextContent(
      strings.settings.notifications.statusSystemSettings
    )

    fireEvent.press(screen.getByTestId('settings-push-system-settings'))

    await waitFor(() => expect(platform.opened).toBe(1))
  })

  it('offers no retry button, because pressing it again would ask nothing', () => {
    // Retry re-runs the flow, and on this platform the flow raises no dialog.
    // A button that visibly does nothing is worse than no button.
    const state = pushRegistrationState({
      available: true,
      enabled: true,
      permission: 'undetermined',
      address: null,
      failure: null,
      needsSystemSettings: true
    })

    expect(state.kind).toBe('needs-system-settings')
  })
})

describe('coming back from System Settings', () => {
  it('does not switch itself off while it is pending', async () => {
    const platform = macPlatform()
    const sync = syncOn(platform)

    await sync.enable()
    await sync.refresh()

    expect(usePushStore.getState().enabled).toBe(true)
    expect(platform.obtained).toBe(0)
  })

  it('registers on the foreground after macOS has allowed it', async () => {
    const platform = macPlatform()
    const sync = syncOn(platform)

    await sync.enable()

    // The owner walks into System Settings and turns Hermie on. Returning to
    // the app is a foreground, and a foreground is a refresh.
    platform.permissionValue = 'granted'
    await sync.refresh()

    expect(usePushStore.getState().address).toEqual(TOKEN)
    expect(platform.obtained).toBe(1)
  })

  it('still follows the system on a platform that has a dialog', async () => {
    const platform = macPlatform('granted')

    platform.needsSystemSettings = false

    const sync = syncOn(platform)

    await sync.enable()
    platform.permissionValue = 'denied'
    await sync.refresh()

    // Revoked outside the app, where revoking is a thing somebody did. A switch
    // that says ON while nothing can arrive is the lie this must not tell.
    expect(usePushStore.getState().enabled).toBe(false)
  })
})
