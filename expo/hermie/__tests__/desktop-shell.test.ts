/**
 * The seam between the browser build and the Tauri desktop shell.
 *
 * Three states, and the app has to be right in all of them because two of them
 * are permanent facts of the shape (ADR-0027): an operator updates their Hermie
 * Web on their own cadence, the shell updates on its own, so a page newer than
 * the shell and a shell newer than the page are both normal forever.
 *
 *  1. **No marker** — a browser tab, or native. Nothing may reach for a bridge.
 *  2. **A marker, no `__TAURI__`** — in a shell, but the bridge is not reachable
 *     from this page: an older shell without `withGlobalTauri`, or a page the
 *     shell did not grant the capability to. `RUNS_IN_DESKTOP_SHELL` must still
 *     be true, because the socket rule depends on it and is right regardless.
 *  3. **Both** — the bridge is there. And even then every call can come back
 *     "no": the shell grants the bridge to the Hermie Web origins the reader
 *     configured and to nothing else, so a page it did not grant has its calls
 *     REJECTED by Tauri's ACL, and a page it did grant can still be refused by
 *     the shell's second-layer check with `{ ok: false, reason: 'origin' }`.
 *     The facade answers "no" to both.
 *
 * `RUNS_IN_DESKTOP_SHELL` is a module-load constant (the marker is injected
 * before any page script, so it cannot change while the page lives), which is
 * why every test here sets the globals and then re-imports the module through
 * `jest.isolateModules` rather than importing it at the top of the file.
 */
import type * as DesktopShell from '../src/platform/desktop-shell'
import type { MenuBarTitles } from '../src/platform/desktop-shortcuts.shared'

type ShellModule = typeof DesktopShell

const scope = globalThis as Record<string, unknown>

/** Load the module fresh against whatever is on `globalThis` right now. */
function loadShell(): ShellModule {
  let loaded: ShellModule | undefined

  jest.isolateModules(() => {
    loaded = require('../src/platform/desktop-shell') as ShellModule
  })

  if (!loaded) {
    throw new Error('desktop-shell did not load')
  }

  return loaded
}

function setMarker(marker: unknown) {
  scope.__HERMIE_DESKTOP__ = marker
}

/**
 * A stand-in for what `withGlobalTauri` puts on the page.
 *
 * `invoke` answers whatever the test queued, so a refusal can be expressed
 * either way the shell expresses one: a RESOLVED `{ ok: false, reason }` from
 * the shell's own check, or a rejection from Tauri's ACL. Erasing that
 * distinction is the whole reason the facade exists — a page must not have to
 * tell "this shell has no such command", "you are not the app" and "the ACL
 * never let this call through" apart.
 */
function setTauri(options: {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  listen?: (event: string, handler: (event: { payload?: unknown }) => void) => Promise<() => void>
}) {
  scope.__TAURI__ = {
    ...(options.invoke ? { core: { invoke: options.invoke } } : {}),
    ...(options.listen ? { event: { listen: options.listen } } : {})
  }
}

const TITLES: MenuBarTitles = {
  chats: 'Chats',
  search: 'Search…',
  settings: 'Settings',
  close: 'Close',
  newConversation: 'New Conversation',
  toggleSidebar: 'Hide Sidebar'
}

beforeEach(() => {
  delete scope.__HERMIE_DESKTOP__
  delete scope.__TAURI__
})

afterAll(() => {
  delete scope.__HERMIE_DESKTOP__
  delete scope.__TAURI__
})

describe('without the marker', () => {
  it('is not the shell and offers no bridge', () => {
    const shell = loadShell()

    expect(shell.RUNS_IN_DESKTOP_SHELL).toBe(false)
    expect(shell.DESKTOP_SHELL_PLATFORM).toBeNull()
    expect(shell.desktopShell()).toBeNull()
  })

  it('stays that way even with a whole Tauri global present', () => {
    // A tab cannot get here, but this is the assertion that says the MARKER is
    // what decides: the bridge is the shell's to offer, not something a page
    // infers from finding an API on the window.
    setTauri({ invoke: async () => ({ ok: true }) })

    const shell = loadShell()

    expect(shell.RUNS_IN_DESKTOP_SHELL).toBe(false)
    expect(shell.desktopShell()).toBeNull()
  })

  it.each([
    ['a string', 'macos'],
    ['null', null],
    ['an empty object', {}],
    ['a version that is not a number', { version: '1', platform: 'macos' }],
    ['a platform this app has never heard of', { version: 1, platform: 'haiku' }],
    ['no platform at all', { version: 1 }]
  ])('treats %s as no marker', (_what, marker) => {
    setMarker(marker)

    const shell = loadShell()

    expect(shell.RUNS_IN_DESKTOP_SHELL).toBe(false)
    expect(shell.DESKTOP_SHELL_PLATFORM).toBeNull()
    expect(shell.desktopShell()).toBeNull()
  })
})

describe('with the marker but no reachable bridge', () => {
  it('is the shell, and says which desktop, but has no bridge', () => {
    setMarker({ version: 1, platform: 'windows' })

    const shell = loadShell()

    // The half that matters: `gateway/client.ts` reads this to decide not to
    // pause the socket, and a shell whose bridge this page cannot reach is
    // still a desktop window whose socket should stay up.
    expect(shell.RUNS_IN_DESKTOP_SHELL).toBe(true)
    expect(shell.DESKTOP_SHELL_PLATFORM).toBe('windows')
    expect(shell.desktopShell()).toBeNull()
  })

  it('has no bridge when `__TAURI__` is there but `core.invoke` is not', () => {
    setMarker({ version: 1, platform: 'linux' })
    scope.__TAURI__ = { event: { listen: async () => () => undefined } }

    const shell = loadShell()

    expect(shell.RUNS_IN_DESKTOP_SHELL).toBe(true)
    expect(shell.desktopShell()).toBeNull()
  })
})

describe('with the bridge', () => {
  function withBridge(
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
    listen?: (event: string, handler: (event: { payload?: unknown }) => void) => Promise<() => void>
  ) {
    setMarker({ version: 1, platform: 'macos' })
    setTauri({ invoke, ...(listen ? { listen } : {}) })

    const shell = loadShell()
    const bridge = shell.desktopShell()

    if (!bridge) {
      throw new Error('expected a bridge')
    }

    return { shell, bridge }
  }

  it('reports the shell, the platform and the bridge version', async () => {
    const { shell, bridge } = withBridge(async () => ({
      ok: true,
      version: '0.1.0',
      platform: 'macos',
      bridge: 1,
      gatewayId: 'dev',
      gatewayName: '127.0.0.1'
    }))

    expect(shell.RUNS_IN_DESKTOP_SHELL).toBe(true)
    expect(bridge.platform).toBe('macos')
    await expect(bridge.info()).resolves.toEqual({
      version: '0.1.0',
      platform: 'macos',
      bridge: 1,
      gatewayId: 'dev',
      gatewayName: '127.0.0.1'
    })
  })

  it('reads no info from a reply that is missing a gateway', async () => {
    // A shell with nothing configured. The guard would have refused first, so
    // this is belt and braces — but `null` is a value the app can render and
    // `undefined` leaking into a menu title is not.
    const { bridge } = withBridge(async () => ({
      ok: true,
      version: '0.1.0',
      platform: 'linux',
      bridge: 1,
      gatewayId: null,
      gatewayName: null
    }))

    await expect(bridge.info()).resolves.toEqual({
      version: '0.1.0',
      platform: 'linux',
      bridge: 1,
      gatewayId: null,
      gatewayName: null
    })
  })

  it('reads no info from a reply whose shape it does not recognise', async () => {
    const { bridge } = withBridge(async () => ({ ok: true, version: 1, bridge: 'one' }))

    await expect(bridge.info()).resolves.toBeNull()
  })

  it('sends each command under the name and argument shape the shell expects', async () => {
    const calls: { command: string; args?: Record<string, unknown> }[] = []
    const { bridge } = withBridge(async (command, args) => {
      calls.push({ command, ...(args ? { args } : {}) })

      return { ok: true }
    })

    await expect(bridge.setMenu(TITLES, ['Researcher', 'Scribe'])).resolves.toBe(true)
    await expect(
      bridge.notify({ id: 'evt-1', title: 'Researcher', body: 'Found it', link: 'hermie://chat/r' })
    ).resolves.toBe(true)
    await expect(bridge.setBadge(3)).resolves.toBe(true)
    await expect(bridge.setBadge(null)).resolves.toBe(true)
    await expect(bridge.openGateways()).resolves.toBe(true)
    await expect(bridge.closeHandled(false)).resolves.toBe(true)

    expect(calls).toEqual([
      { command: 'hermie_set_menu', args: { titles: TITLES, chats: ['Researcher', 'Scribe'] } },
      {
        command: 'hermie_notify',
        args: {
          notification: {
            id: 'evt-1',
            title: 'Researcher',
            body: 'Found it',
            link: 'hermie://chat/r'
          }
        }
      },
      { command: 'hermie_set_badge', args: { count: 3 } },
      { command: 'hermie_set_badge', args: { count: null } },
      { command: 'hermie_open_gateways' },
      { command: 'hermie_close_handled', args: { handled: false } }
    ])
  })

  it('copies the chat list rather than handing the caller’s array across', async () => {
    let sent: unknown
    const { bridge } = withBridge(async (_command, args) => {
      sent = args?.chats

      return { ok: true }
    })

    const chats = ['Researcher']
    await bridge.setMenu(TITLES, chats)
    chats.push('Scribe')

    expect(sent).toEqual(['Researcher'])
  })

  it('answers "no" to a refusal from the origin guard, without throwing', async () => {
    const { bridge } = withBridge(async () => ({ ok: false, reason: 'origin' }))

    await expect(bridge.info()).resolves.toBeNull()
    await expect(bridge.setMenu(TITLES, [])).resolves.toBe(false)
    await expect(bridge.notify({ id: 'evt-1', title: 'Researcher' })).resolves.toBe(false)
    await expect(bridge.setBadge(1)).resolves.toBe(false)
    await expect(bridge.openGateways()).resolves.toBe(false)
    await expect(bridge.closeHandled(true)).resolves.toBe(false)
  })

  it('answers "no" when the call rejects, which is what the shell\'s ACL does', async () => {
    // A rejection is the ordinary answer from a page the shell did not grant
    // the bridge to: the desktop shell registers one capability per configured
    // Hermie Web, and Tauri's ACL refuses the call before any command runs, so
    // nothing ever replies `{ ok: false }`. It is also what an older shell says
    // to a newer app about a command it does not have. The facade must not be
    // able to tell those apart, and must never let either one throw into the
    // app.
    const { bridge } = withBridge(async () => {
      throw new Error('hermie_set_badge not allowed on window "main"')
    })

    await expect(bridge.info()).resolves.toBeNull()
    await expect(bridge.setMenu(TITLES, [])).resolves.toBe(false)
    await expect(bridge.notify({ id: 'evt-1', title: 'Researcher' })).resolves.toBe(false)
    await expect(bridge.setBadge(1)).resolves.toBe(false)
    await expect(bridge.openGateways()).resolves.toBe(false)
    await expect(bridge.closeHandled(true)).resolves.toBe(false)
  })

  describe('events', () => {
    it('delivers a payload and unsubscribes', async () => {
      const handlers = new Map<string, (event: { payload?: unknown }) => void>()
      const stop = jest.fn()

      const { bridge } = withBridge(
        async () => ({ ok: true }),
        async (event, handler) => {
          handlers.set(event, handler)

          return stop
        }
      )

      const seen: unknown[] = []
      const unsubscribe = bridge.subscribe('hermie://shortcut', payload => seen.push(payload))

      // `listen` is asynchronous; the subscription is not live until it settles.
      await Promise.resolve()

      handlers.get('hermie://shortcut')?.({ payload: { action: 'search', typing: false } })
      expect(seen).toEqual([{ action: 'search', typing: false }])

      unsubscribe()
      expect(stop).toHaveBeenCalledTimes(1)

      handlers.get('hermie://shortcut')?.({ payload: { action: 'close', typing: false } })
      expect(seen).toHaveLength(1)
    })

    it('unsubscribes a subscription that had not finished registering', async () => {
      let settle: ((stop: () => void) => void) | undefined
      const stop = jest.fn()

      const { bridge } = withBridge(
        async () => ({ ok: true }),
        () =>
          new Promise<() => void>(resolve => {
            settle = resolve
          })
      )

      // A React effect that unmounts before `listen` resolved. Without the
      // cancelled flag the listener would outlive the component that asked.
      const unsubscribe = bridge.subscribe('hermie://focus', () => undefined)
      unsubscribe()

      settle?.(stop)
      await Promise.resolve()
      await Promise.resolve()

      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('is a no-op when the shell exposes no event API', () => {
      const { bridge } = withBridge(async () => ({ ok: true }))

      const unsubscribe = bridge.subscribe('hermie://link', () => {
        throw new Error('nothing should arrive')
      })

      expect(() => unsubscribe()).not.toThrow()
    })

    it('swallows a listen that is refused', async () => {
      const { bridge } = withBridge(
        async () => ({ ok: true }),
        async () => {
          throw new Error('event.listen not allowed by ACL')
        }
      )

      const unsubscribe = bridge.subscribe('hermie://gateway', () => undefined)

      await Promise.resolve()
      await Promise.resolve()

      expect(() => unsubscribe()).not.toThrow()
    })
  })
})
