/**
 * Settings → Notifications, which is where ADR-0017's defaults become visible.
 *
 * The section is the only place a reader can find out what a notification will
 * carry, so what is pinned here is the wording and the shape rather than the
 * plumbing: OFF to begin with, no per-type controls until it is on, the preview
 * switch off with its warning under it, and a footer that changes when the
 * platform has something the reader has to go elsewhere to fix.
 */
import { PUSH_TYPES } from '@hermie/gateway-client/push'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'

import { NS_A } from './support/gateway-namespace'

import { NotificationsSection } from '../src/features/push/NotificationsSection'
import type { PushPermission } from '../src/features/push/platform-contract'
import { PushSync } from '../src/features/push/push-sync'
import { strings } from '../src/i18n/strings'
import { keyValueStore } from '../src/platform/key-value-store'
import { ownRegistration, PUSH_KEY, usePushStore } from '../src/store/push'
import { ThemeProvider } from '../src/ui/theme'

const TOKEN = { transport: 'expo' as const, token: 'ExponentPushToken[abc]' }

function syncWith(permission: PushPermission, address = TOKEN as { transport: 'expo'; token: string } | null) {
  return new PushSync({
    ports: {
      showChat: async () => undefined,
      openApprovals: async () => [],
      respondApproval: async () => undefined
    },
    platform: {
      available: true,
      platform: 'ios',
      needsSystemSettings: false,
      openSystemSettings: async () => false,
      prepare: async () => undefined,
      permission: async () => permission,
      requestPermission: async () => permission,
      obtainAddress: async () => address,
      dropAddress: async () => undefined,
      onResponse: () => () => undefined,
      consumeInitialResponse: async () => null
    }
  })
}

const paint = (push: PushSync, available = true) =>
  render(
    <ThemeProvider>
      <NotificationsSection available={available} push={push} />
    </ThemeProvider>
  )

beforeEach(async () => {
  usePushStore.getState().reset()
  await keyValueStore.delete(NS_A.key(PUSH_KEY))
  await usePushStore.getState().hydrate(NS_A)
})

it('shows one switch, off, and no per-type controls', () => {
  paint(syncWith('undetermined'))

  expect(screen.getByTestId('settings-push-enabled').props.accessibilityState.checked).toBe(false)
  expect(screen.queryByTestId('settings-push-type-message')).toBeNull()
  expect(screen.queryByTestId('settings-push-preview')).toBeNull()
})

it('opens every type and the preview switch once it is on', async () => {
  const push = syncWith('granted')

  paint(push)
  fireEvent.press(screen.getByTestId('settings-push-enabled'))

  await waitFor(() => expect(screen.getByTestId('settings-push-preview')).toBeTruthy())

  /*
    All of them, and `dm` is not one of them. ADR-0017's amendment: Hermes fires
    no hook when a bot-to-bot DM arrives, so the plugin cannot produce one — a
    switch for it would be a switch that never does anything.
  */
  expect(PUSH_TYPES).toHaveLength(7)

  for (const type of PUSH_TYPES) {
    expect(screen.getByTestId(`settings-push-type-${type}`).props.accessibilityState.checked).toBe(true)
  }

  expect(screen.queryByTestId('settings-push-type-dm')).toBeNull()

  // The owner's rule, and the reason the two cron outcomes are worth their own
  // switches: a routine that was supposed to happen and did not is the one
  // nobody wants to find out about the next morning.
  expect(screen.getByTestId('settings-push-type-cron_failed').props.accessibilityState.checked).toBe(true)

  // ADR-0017's default: a notification says who and what kind, never what was
  // said, because it is rendered on a lock screen by somebody else's software.
  expect(screen.getByTestId('settings-push-preview').props.accessibilityState.checked).toBe(false)
  expect(screen.getByText(strings.settings.notifications.previewHint)).toBeTruthy()
})

it('turns a newly added type on for a device that upgrades into it', async () => {
  /*
    The bag on disk was written by a build that had never heard of the two cron
    outcomes. Read by the WIRE's rule — absent means off — both switches would
    come back on screen looking ON while the registration said otherwise, and
    the owner would never be told the routine had stopped running.

    A type the reader actually switched OFF is a different thing and stays off:
    that is a decision, and an upgrade must not undo one.
  */
  await keyValueStore.setJson(NS_A.key(PUSH_KEY), {
    enabled: true,
    preview: false,
    types: { message: true, request: true, cron: false, turn_done: true, turn_failed: true }
  })
  usePushStore.getState().reset()
  await usePushStore.getState().hydrate(NS_A)

  paint(syncWith('granted'))

  await waitFor(() => expect(screen.getByTestId('settings-push-type-cron_failed')).toBeTruthy())

  expect(screen.getByTestId('settings-push-type-cron_done').props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('settings-push-type-cron_failed').props.accessibilityState.checked).toBe(true)
  expect(screen.getByTestId('settings-push-type-cron').props.accessibilityState.checked).toBe(false)
})

it('carries the newly adopted types into the row the gateway is sent', async () => {
  await keyValueStore.setJson(NS_A.key(PUSH_KEY), {
    enabled: true,
    preview: false,
    types: { message: true, request: true, cron: true, turn_done: true, turn_failed: true }
  })
  usePushStore.getState().reset()
  await usePushStore.getState().hydrate(NS_A)
  usePushStore.getState().setAddress(TOKEN, 1_789_957_143)

  // The row is rewritten by the `refresh` every launch and every foreground
  // makes — `push-sync.test.ts` pins that — so adopting a type on hydrate is
  // what carries it to the notifier without anybody touching a switch.
  expect(ownRegistration(usePushStore.getState(), 'ios')?.types).toMatchObject({
    cron_done: true,
    cron_failed: true
  })
})

it('sends the reader to system settings when permission was refused there', async () => {
  paint(syncWith('denied'))

  await waitFor(() => expect(screen.getByText(strings.settings.notifications.denied)).toBeTruthy())
})

it('says so, and disables the switch, where the platform cannot register at all', () => {
  paint(syncWith('undetermined'), false)

  expect(screen.getByText(strings.settings.notifications.unavailable)).toBeTruthy()
  expect(screen.getByTestId('settings-push-enabled').props.accessibilityState.disabled).toBe(true)
})

it('renders nothing before there is a gateway connection to register against', () => {
  const { toJSON } = render(
    <ThemeProvider>
      <NotificationsSection push={null} />
    </ThemeProvider>
  )

  expect(toJSON()).toBeNull()
})
