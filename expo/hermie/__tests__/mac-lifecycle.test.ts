/**
 * A desktop window does not pause the connection when it leaves the front.
 *
 * `pause()` tears the socket down. On a phone that is right — the OS is about to
 * kill a half-open socket anyway — and on a Mac it is the difference between a
 * window you Cmd+Tab away from and a window that says "gateway not connected"
 * when you come back. The native macOS target skipped AppState entirely for this
 * reason, and the rule has to survive that target's removal.
 *
 * Two windows now reach it by two different routes, and both are mocked here
 * because neither can be produced in a test environment:
 *
 *  - the iPad build on a Mac (`RUNS_ON_MAC`, a native module's answer), which
 *    reports iOS's AppState values like any other iOS app;
 *  - the Tauri desktop shell (`RUNS_IN_DESKTOP_SHELL`, a global the shell
 *    injects), which is the BROWSER build — and react-native-web reports
 *    `background` on `document.hidden`, so merely covering the window arrives
 *    here. That is also the window where the socket has a second job: it is what
 *    raises notifications, since a webview has no Push API.
 *
 * A browser tab is neither, and still pauses. That is the case this file's first
 * test stands for as much as a phone does.
 *
 * `resume()` on `active` is wired on all three, deliberately: it returns
 * immediately unless the connection really is paused or stopped, so on a desktop
 * window it is a no-op and on anything else it is the recovery.
 */
import type { GatewayConnection } from '@hermie/gateway-client'
import { AppState, type AppStateStatus } from 'react-native'

import { attachLifecycle } from '../src/gateway/client'

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))
jest.mock('../src/platform/desktop-shell', () => ({ RUNS_IN_DESKTOP_SHELL: false }))

const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }
const desktopShell = jest.requireMock('../src/platform/desktop-shell') as {
  RUNS_IN_DESKTOP_SHELL: boolean
}

function attach() {
  const connection = {
    pause: jest.fn(),
    resume: jest.fn(),
    setOnline: jest.fn()
  }

  let handler: ((state: AppStateStatus) => void) | undefined

  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, next) => {
    handler = next as (state: AppStateStatus) => void

    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>
  })

  const detach = attachLifecycle(connection as unknown as GatewayConnection)

  if (!handler) {
    throw new Error('attachLifecycle did not subscribe to AppState')
  }

  return { connection, send: handler, detach, spy }
}

afterEach(() => {
  jest.restoreAllMocks()
  runsOnMac.RUNS_ON_MAC = false
  desktopShell.RUNS_IN_DESKTOP_SHELL = false
})

describe('attachLifecycle', () => {
  it('pauses on background on a phone, and in a plain browser tab', () => {
    const { connection, send, detach } = attach()

    send('background')
    expect(connection.pause).toHaveBeenCalledTimes(1)

    send('active')
    expect(connection.resume).toHaveBeenCalledTimes(1)

    detach()
  })

  it('never pauses on a Mac, and still resumes', () => {
    runsOnMac.RUNS_ON_MAC = true
    const { connection, send, detach } = attach()

    send('background')
    expect(connection.pause).not.toHaveBeenCalled()

    send('active')
    expect(connection.resume).toHaveBeenCalledTimes(1)

    detach()
  })

  it('never pauses in the desktop shell, and still resumes', () => {
    desktopShell.RUNS_IN_DESKTOP_SHELL = true
    const { connection, send, detach } = attach()

    send('background')
    expect(connection.pause).not.toHaveBeenCalled()

    send('active')
    expect(connection.resume).toHaveBeenCalledTimes(1)

    detach()
  })

  it('ignores `inactive` on all three, which is what a window losing focus reports', () => {
    const { connection, send, detach } = attach()

    send('inactive')
    expect(connection.pause).not.toHaveBeenCalled()
    expect(connection.resume).not.toHaveBeenCalled()

    detach()
  })
})
