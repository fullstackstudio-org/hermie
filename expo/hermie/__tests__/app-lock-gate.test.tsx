/**
 * The locked app does not RENDER its contents — it does not merely cover them.
 *
 * The distinction is the whole feature, and it is the one that erodes quietly:
 * a plate laid on top with a z-index still leaves a live transcript, a live
 * chat list and a live connection underneath, all of them still fetching and
 * all of them in whatever snapshot the operating system takes of the window.
 * So every assertion here is an ABSENCE, and the fixture below is a component
 * that shouts when it is mounted.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'

import { AppLock } from '../src/features/lock/AppLock'
import { useLockStore } from '../src/features/lock/store'
import { start } from '../src/features/lock/lock-state'
import { keyValueStore } from '../src/platform/key-value-store'
import { renderScreen, deferred } from './support/render'

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

/** A secret nothing but a mounted child could put on screen. */
const SECRET = 'the transcript nobody may read'

function Secret() {
  return <Text>{SECRET}</Text>
}

beforeEach(async () => {
  mockBiometrics.available = true
  mockBiometrics.enrolment.mockClear().mockResolvedValue('biometric')
  mockBiometrics.authenticate.mockClear().mockResolvedValue('ok')
  await keyValueStore.delete('hermie.lock')
  useLockStore.setState({ machine: start('off'), ready: false, prompting: false, enrolment: null })
})

describe('with the lock off', () => {
  it('renders the app and never asks for a face', async () => {
    renderScreen(
      <AppLock>
        <Secret />
      </AppLock>
    )

    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    expect(mockBiometrics.authenticate).not.toHaveBeenCalled()
  })
})

describe('with the lock on', () => {
  beforeEach(async () => {
    await keyValueStore.setJson('hermie.lock', { threshold: '5m' })
  })

  it('draws neither the app nor the plate until the preference has been read', async () => {
    // The prompt is held open, so hydration cannot race past the assertion.
    const gate = deferred<'ok'>()
    mockBiometrics.authenticate.mockReturnValue(gate.promise)

    renderScreen(
      <AppLock>
        <Secret />
      </AppLock>
    )

    // The very first frame: no content, and no lock screen flashed at somebody
    // who never turned one on.
    expect(screen.queryByText(SECRET)).toBeNull()
    expect(screen.queryByTestId('lock-plate')).toBeNull()
    expect(screen.getByTestId('lock-pending')).toBeTruthy()

    await waitFor(() => expect(screen.getByTestId('lock-plate')).toBeTruthy())

    await act(async () => {
      gate.resolve('ok')
      await gate.promise
    })
  })

  it('does not mount the app behind the plate', async () => {
    const gate = deferred<'ok'>()
    mockBiometrics.authenticate.mockReturnValue(gate.promise)

    renderScreen(
      <AppLock>
        <Secret />
      </AppLock>
    )

    await waitFor(() => expect(screen.getByTestId('lock-plate')).toBeTruthy())

    expect(screen.queryByText(SECRET)).toBeNull()
    // Not "hidden", not "opacity 0", not "behind": absent from the tree.
    expect(screen.toJSON()).not.toContain(SECRET)

    await act(async () => {
      gate.resolve('ok')
      await gate.promise
    })
  })

  it('mounts the app once the device says yes', async () => {
    renderScreen(
      <AppLock>
        <Secret />
      </AppLock>
    )

    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
  })

  it('keeps the app unmounted when the device says no, and re-asks on the button', async () => {
    mockBiometrics.authenticate.mockResolvedValue('failed')

    renderScreen(
      <AppLock>
        <Secret />
      </AppLock>
    )

    await waitFor(() => expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(SECRET)).toBeNull()
    expect(screen.getByTestId('lock-plate')).toBeTruthy()

    mockBiometrics.authenticate.mockResolvedValue('ok')
    await act(async () => {
      fireEvent.press(screen.getByTestId('lock-unlock'))
    })

    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
  })

  it('treats a module that cannot run as a refusal rather than as a way in', async () => {
    mockBiometrics.authenticate.mockResolvedValue('unavailable')

    renderScreen(
      <AppLock>
        <Secret />
      </AppLock>
    )

    await waitFor(() => expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(SECRET)).toBeNull()
  })
})

describe('the store, driven directly', () => {
  it('refuses to switch the lock on when nothing is enrolled to open it', async () => {
    mockBiometrics.enrolment.mockResolvedValue('none')

    const accepted = await useLockStore.getState().changeThreshold('immediately')

    expect(accepted).toBe(false)
    expect(useLockStore.getState().machine.threshold).toBe('off')
    expect(await keyValueStore.getJson('hermie.lock')).toBeNull()
    // Refused on enrolment, so the prompt itself was never reached.
    expect(mockBiometrics.authenticate).not.toHaveBeenCalled()
  })

  it('accepts a passcode-only device, because a passcode is an unlock', async () => {
    mockBiometrics.enrolment.mockResolvedValue('passcode')

    expect(await useLockStore.getState().changeThreshold('1m')).toBe(true)
    expect(await keyValueStore.getJson('hermie.lock')).toEqual({ threshold: '1m' })
    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
  })

  it('leaves the stored value and the machine untouched when the prompt is refused', async () => {
    mockBiometrics.enrolment.mockResolvedValue('biometric')
    mockBiometrics.authenticate.mockResolvedValue('failed')

    expect(await useLockStore.getState().changeThreshold('immediately')).toBe(false)
    expect(useLockStore.getState().machine.threshold).toBe('off')
    expect(await keyValueStore.getJson('hermie.lock')).toBeNull()
  })

  it('asks the hardware even to switch off, but never checks enrolment for it', async () => {
    mockBiometrics.enrolment.mockResolvedValue('none')
    useLockStore.setState({ machine: start('immediately') })

    expect(await useLockStore.getState().changeThreshold('off')).toBe(true)
    expect(mockBiometrics.enrolment).not.toHaveBeenCalled()
    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
    expect(await keyValueStore.getJson('hermie.lock')).toEqual({ threshold: 'off' })
  })

  it('leaves an on lock on when the prompt to turn it off is refused', async () => {
    mockBiometrics.authenticate.mockResolvedValue('failed')
    useLockStore.setState({ machine: start('immediately') })

    expect(await useLockStore.getState().changeThreshold('off')).toBe(false)
    expect(useLockStore.getState().machine.threshold).toBe('immediately')
    expect(await keyValueStore.getJson('hermie.lock')).toBeNull()
  })

  it('does not stack a second prompt on top of the one already up', async () => {
    const gate = deferred<'ok'>()
    mockBiometrics.authenticate.mockReturnValue(gate.promise)
    useLockStore.setState({ machine: start('immediately'), ready: true })

    const first = useLockStore.getState().unlock()
    const second = useLockStore.getState().unlock()

    await act(async () => {
      gate.resolve('ok')
      await Promise.all([first, second])
    })

    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
  })

  it('refuses a threshold change while the lifecycle watcher already has a prompt up', async () => {
    const gate = deferred<'ok'>()
    mockBiometrics.authenticate.mockReturnValue(gate.promise)
    useLockStore.setState({ machine: start('immediately'), ready: true })

    const unlocking = useLockStore.getState().unlock()
    const changed = useLockStore.getState().changeThreshold('5m')

    expect(await changed).toBe(false)

    await act(async () => {
      gate.resolve('ok')
      await unlocking
    })

    expect(mockBiometrics.authenticate).toHaveBeenCalledTimes(1)
  })
})
