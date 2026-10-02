/**
 * Settings → Privacy & security → Require unlock, as a pushed picker
 * (HERM-106) rather than the five-segment control it used to be.
 *
 * One rule makes every case here: a pick authenticates FIRST, in both
 * directions and with `off` included, and a refused, failed or cancelled
 * prompt leaves the stored value, the lock machine and the row exactly where
 * they were. Picking the value already in force is the one exception — it is
 * not a change, so it costs no prompt at all.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native'

import { start } from '../src/features/lock/lock-state'
import { useLockStore } from '../src/features/lock/store'
import { SettingsScreen } from '../src/features/settings'
import { strings } from '../src/i18n/strings'
import { keyValueStore } from '../src/platform/key-value-store'
import { renderScreen, waitForGone } from './support/render'

const mockBiometrics = {
  available: true,
  enrolment: jest.fn(async () => 'biometric' as const),
  authenticate: jest.fn(async () => 'ok' as const)
}

jest.mock('../src/platform/biometrics', () => ({
  get biometrics() {
    return mockBiometrics
  }
}))

// `Account` and `Gateways` read this unconditionally for their own row
// summaries, which run the moment `Root` is anywhere in the stack (it always
// is: the picker's chain is `Root → Privacy → LockThreshold`).
const mockGateway = {
  canRefresh: true,
  changeGateway: jest.fn(),
  config: { authMode: 'session_token', baseUrl: 'https://gateway.example.com', version: '1.2.3' },
  connection: null,
  forgetGateway: jest.fn(),
  gatewayId: 'g1',
  http: null,
  refreshRegistry: jest.fn(async () => undefined),
  registry: {
    activeGatewayId: 'g1',
    gateways: [
      {
        addedAt: 1,
        address: 'https://gateway.example.com',
        authKind: 'session_token' as const,
        id: 'g1',
        name: 'Home',
        signedInUser: 'Sam'
      }
    ]
  },
  removeGateway: jest.fn(),
  renameGateway: jest.fn(),
  signOut: jest.fn(),
  signOutOf: jest.fn(),
  status: 'ready',
  switchGateway: jest.fn()
}

jest.mock('../src/gateway', () => ({
  createGatewayConnection: () => ({
    http: { get: jest.fn(), post: jest.fn() },
    onStatus: () => () => undefined,
    start: jest.fn(),
    stop: jest.fn()
  }),
  hostOf: (url: string) => url.replace(/^https?:\/\//u, ''),
  useGateway: () => mockGateway
}))

const lockPage = () => screen.getByTestId('settings-page-LockThreshold')
const privacyPage = () => screen.getByTestId('settings-page-Privacy')

async function openLockThreshold() {
  renderScreen(<SettingsScreen initialRoute="LockThreshold" />)
  await waitFor(() => expect(lockPage()).toBeTruthy())
}

beforeEach(async () => {
  mockBiometrics.available = true
  mockBiometrics.enrolment.mockClear().mockResolvedValue('biometric')
  mockBiometrics.authenticate.mockClear().mockResolvedValue('ok')
  await keyValueStore.delete('hermie.lock')
  useLockStore.setState({ machine: start('off'), ready: false, prompting: false, enrolment: null })
})

describe('the picker', () => {
  it('shows a row for every threshold', async () => {
    await openLockThreshold()

    for (const value of ['off', 'immediately', '1m', '5m', '15m']) {
      expect(within(lockPage()).getByTestId(`picker-option-${value}`)).toBeTruthy()
    }
  })

  it('authenticates before turning the lock on, then goes back', async () => {
    await openLockThreshold()

    fireEvent.press(within(lockPage()).getByTestId('picker-option-immediately'))

    await waitForGone(() => screen.queryByTestId('settings-page-LockThreshold'), 'the LockThreshold page')
    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
    expect(useLockStore.getState().machine.threshold).toBe('immediately')
    expect(await keyValueStore.getJson('hermie.lock')).toEqual({ threshold: 'immediately' })
  })

  it('authenticates before turning an on lock off, then goes back', async () => {
    useLockStore.setState({ machine: start('5m') })
    await openLockThreshold()

    fireEvent.press(within(lockPage()).getByTestId('picker-option-off'))

    await waitForGone(() => screen.queryByTestId('settings-page-LockThreshold'), 'the LockThreshold page')
    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
    expect(useLockStore.getState().machine.threshold).toBe('off')
    expect(await keyValueStore.getJson('hermie.lock')).toEqual({ threshold: 'off' })
  })

  it('goes back with no prompt at all when the value picked is already in force', async () => {
    useLockStore.setState({ machine: start('5m') })
    await openLockThreshold()

    fireEvent.press(within(lockPage()).getByTestId('picker-option-5m'))

    await waitForGone(() => screen.queryByTestId('settings-page-LockThreshold'), 'the LockThreshold page')
    expect(mockBiometrics.authenticate).not.toHaveBeenCalled()
    expect(useLockStore.getState().machine.threshold).toBe('5m')
  })

  it('leaves the value unchanged and stays open when the prompt is refused', async () => {
    mockBiometrics.authenticate.mockResolvedValue('failed')
    await openLockThreshold()

    fireEvent.press(within(lockPage()).getByTestId('picker-option-immediately'))

    await waitFor(() => expect(within(lockPage()).getByText(strings.settings.lock.refused)).toBeTruthy())
    expect(screen.getByTestId('settings-page-LockThreshold')).toBeTruthy()
    expect(useLockStore.getState().machine.threshold).toBe('off')
    expect(await keyValueStore.getJson('hermie.lock')).toBeNull()
  })

  it('leaves an on lock on and stays open when the prompt to turn it off is cancelled', async () => {
    useLockStore.setState({ machine: start('5m') })
    mockBiometrics.authenticate.mockResolvedValue('failed')
    await openLockThreshold()

    fireEvent.press(within(lockPage()).getByTestId('picker-option-off'))

    await waitFor(() => expect(within(lockPage()).getByText(strings.settings.lock.refused)).toBeTruthy())
    expect(useLockStore.getState().machine.threshold).toBe('5m')
  })

  it('refuses turning the lock on with the no-enrolment footer, and never prompts', async () => {
    mockBiometrics.enrolment.mockResolvedValue('none')
    await openLockThreshold()

    fireEvent.press(within(lockPage()).getByTestId('picker-option-immediately'))

    await waitFor(() => expect(within(lockPage()).getByText(strings.settings.lock.noEnrolment)).toBeTruthy())
    expect(mockBiometrics.authenticate).not.toHaveBeenCalled()
    expect(useLockStore.getState().machine.threshold).toBe('off')
  })
})

describe('the row on Privacy', () => {
  it('shows the current option, and updates once the picker changes it', async () => {
    renderScreen(<SettingsScreen initialRoute="Privacy" />)
    await waitFor(() => expect(privacyPage()).toBeTruthy())

    expect(within(privacyPage()).getByTestId('settings-app-lock')).toHaveTextContent(
      new RegExp(strings.settings.lock.options.off)
    )

    fireEvent.press(within(privacyPage()).getByTestId('settings-app-lock'))
    await waitFor(() => expect(screen.getByTestId('settings-page-LockThreshold')).toBeTruthy())

    fireEvent.press(within(lockPage()).getByTestId('picker-option-immediately'))
    await waitForGone(() => screen.queryByTestId('settings-page-LockThreshold'), 'the LockThreshold page')

    expect(within(privacyPage()).getByTestId('settings-app-lock')).toHaveTextContent(
      new RegExp(strings.settings.lock.options.immediately)
    )
  })
})
