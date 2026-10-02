/**
 * "Is this phone actually registered for push?" — the question the app could
 * not answer.
 *
 * The owner's gateway held `hermie-app.push` with a live heartbeat and
 * `registrations: {}`, which is a device that looks on from the inside and is
 * absent from the outside. The cause was `obtainAddress` swallowing five
 * unrelated failures into one `null`; the fix is a state computed from what is
 * actually known and a row in Settings that says it.
 *
 * `pushRegistrationState` is pure, so most of this needs no React — and the
 * part that does is about the two things a component can still get wrong: which
 * sentence, and whether Retry is offered at all.
 */
import type { PushAddress } from '@hermie/gateway-client/push'
import { screen } from '@testing-library/react-native'

import { NS_A } from './support/gateway-namespace'

import { NotificationsSection } from '../src/features/push/NotificationsSection'
import type { PushPlatform } from '../src/features/push/platform-contract'
import { PushSync } from '../src/features/push/push-sync'
import {
  PUSH_ADDRESS_TAIL,
  pushAddressTail,
  pushRegistrationState,
  pushRetryable,
  type PushStatusInput
} from '../src/features/push/status'
import { usePushStore } from '../src/store/push'
import { renderScreen } from './support/render'

const TOKEN: PushAddress = { transport: 'expo', token: 'ExponentPushToken[k2vN9qLm]' }
const WEB: PushAddress = {
  transport: 'webpush',
  endpoint: 'https://push.example/send/abcdef123456',
  keys: { p256dh: 'p', auth: 'a' }
}

const state = (patch: Partial<PushStatusInput> = {}) =>
  pushRegistrationState({
    available: true,
    enabled: true,
    permission: 'granted',
    address: null,
    failure: null,
    ...patch
  })

describe('what this device’s registration is', () => {
  it('is off before the switch is moved', () => {
    expect(state({ enabled: false })).toEqual({ kind: 'off' })
  })

  it('is unavailable where the platform has no notifications, whatever the switch says', () => {
    // A browser over plain http. Nothing below availability can be true, so it
    // is checked first.
    expect(state({ available: false, enabled: true, address: TOKEN })).toEqual({ kind: 'unavailable' })
  })

  it('is denied before it is anything else, even holding an old address', () => {
    // The one lie a settings screen must not tell: a row saying "Registered"
    // while the OS is dropping every notification.
    expect(state({ permission: 'denied', address: TOKEN })).toEqual({ kind: 'denied' })
  })

  it('names the address tail when it is registered', () => {
    expect(state({ address: TOKEN })).toEqual({ kind: 'registered', tail: 'k2vN9qLm' })
  })

  it('takes the tail off whichever kind of address it is', () => {
    expect(pushAddressTail(WEB)).toBe('abcdef123456'.slice(-PUSH_ADDRESS_TAIL))
  })

  it('is pending between the switch moving and the platform answering', () => {
    expect(state()).toEqual({ kind: 'pending' })
  })

  it.each([
    ['a build that cannot mint a token', { reason: 'no-project-id' as const }, { kind: 'no-project-id' }],
    [
      'a token request that threw',
      { reason: 'failed' as const, message: 'no valid aps-environment entitlement' },
      { kind: 'failed', message: 'no valid aps-environment entitlement' }
    ],
    [
      'a platform that answered with nothing',
      { reason: 'empty' as const },
      { kind: 'failed', message: 'the platform returned no address' }
    ],
    [
      'a deployment that cannot do it at all',
      { reason: 'unsupported' as const, message: 'no VAPID key URL' },
      { kind: 'unavailable', detail: 'no VAPID key URL' }
    ]
  ])('distinguishes %s', (_label, failure, expected) => {
    expect(state({ failure })).toEqual(expected)
  })

  /**
   * Retry re-runs the flow, so it is offered only where re-running it could
   * change the answer. A button that visibly does nothing is worse than no
   * button: asking again on a denied permission shows no dialog, and a build
   * with no EAS project id cannot grow one at runtime.
   */
  it.each([
    ['failed', { kind: 'failed' as const, message: 'x' }, true],
    ['pending', { kind: 'pending' as const }, true],
    ['registered', { kind: 'registered' as const, tail: 'abc' }, false],
    ['denied', { kind: 'denied' as const }, false],
    ['no project id', { kind: 'no-project-id' as const }, false],
    ['off', { kind: 'off' as const }, false]
  ])('offers Retry for %s: %s', (_label, value, expected) => {
    expect(pushRetryable(value)).toBe(expected)
  })
})

describe('Settings → Notifications says it out loud', () => {
  const platform = (patch: Partial<PushPlatform> = {}): PushPlatform => ({
    available: true,
    platform: 'ios',
    prepare: async () => undefined,
    permission: async () => 'granted',
    requestPermission: async () => 'granted',
    obtainAddress: async () => ({ address: null, failure: { reason: 'failed', message: 'unreachable' } }),
    dropAddress: async () => undefined,
    onResponse: () => () => undefined,
    consumeInitialResponse: async () => null,
    ...patch
  })

  const sync = () =>
    new PushSync({
      namespace: NS_A,
      platform: platform(),
      ports: {
        showChat: async () => undefined,
        openApprovals: async () => [],
        respondApproval: async () => undefined
      }
    })

  beforeEach(() => {
    usePushStore.getState().reset()
  })

  it('shows nothing about registration while the switch is off', () => {
    renderScreen(<NotificationsSection push={sync()} />)

    expect(screen.queryByTestId('settings-push-status')).toBeNull()
  })

  it('names the concrete failure, with a Retry beside it', () => {
    usePushStore.setState({
      loaded: true,
      enabled: true,
      addressFailure: { reason: 'failed', message: 'no valid aps-environment entitlement' }
    })

    renderScreen(<NotificationsSection push={sync()} />)

    expect(screen.getByTestId('settings-push-status').props.children).toContain('no valid aps-environment entitlement')
    expect(screen.getByTestId('settings-push-retry')).toBeTruthy()
  })

  it('names a build that cannot register, and offers no Retry for it', () => {
    usePushStore.setState({ loaded: true, enabled: true, addressFailure: { reason: 'no-project-id' } })

    renderScreen(<NotificationsSection push={sync()} />)

    expect(screen.getByTestId('settings-push-status').props.children).toContain('EAS project id')
    expect(screen.queryByTestId('settings-push-retry')).toBeNull()
  })

  it('shows the address tail once there is one, so it can be matched against ui_meta', () => {
    usePushStore.setState({ loaded: true, enabled: true, address: TOKEN, addressFailure: null })

    renderScreen(<NotificationsSection push={sync()} />)

    expect(screen.getByTestId('settings-push-status').props.children).toContain('k2vN9qLm')
    expect(screen.queryByTestId('settings-push-retry')).toBeNull()
  })
})
