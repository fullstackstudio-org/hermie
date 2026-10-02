/**
 * When the widget file is written, and — more to the point — when it is not.
 *
 * A widget reload is a rationed resource: WidgetKit gives an app a budget per
 * day and an app that spends it on writes nobody can see stops updating for
 * everybody. So the two things worth pinning are the debounce (a streaming turn
 * notifies the chat store on every token) and the comparison that drops a write
 * which would draw the same pixels.
 */
import { WidgetSync } from '../src/features/widgets/widget-sync'
import type { WidgetBridge } from '../src/platform/platform-contracts'
import type { Bot } from '../src/store/bots'

function fakeBridge(overrides: Partial<WidgetBridge> = {}) {
  const snapshots: string[] = []
  const avatars: { name: string; base64: string }[] = []
  const pruned: string[][] = []

  return {
    snapshots,
    avatars,
    pruned,
    bridge: {
      available: true,
      async writeSnapshot(json: string) {
        snapshots.push(json)

        return true
      },
      async writeAvatar(name: string, base64: string) {
        avatars.push({ name, base64 })

        return true
      },
      async pruneAvatars(keep: readonly string[]) {
        pruned.push([...keep])

        return 0
      },
      ...overrides
    } as WidgetBridge
  }
}

/** A minimal stand-in for one zustand store: a value and a listener list. */
function fakeStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    set(next: Partial<T>) {
      state = { ...state, ...next }
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

function bot(name: string): Bot {
  return {
    name,
    displayName: name,
    description: '',
    model: 'example-provider/example-model',
    provider: 'example-provider',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0,
    canonical: { id: 's', resolvedId: 's', preview: 'hi', lastActive: 10, messageCount: 1 }
  }
}

function harness(bridgeOverrides: Partial<WidgetBridge> = {}) {
  const fake = fakeBridge(bridgeOverrides)
  /**
   * Spotlight's half, which hangs off the same edge the widget write does.
   *
   * It is recorded rather than stubbed away because the thing worth pinning is
   * WHEN it is called: the roster changing in a way somebody would see is
   * exactly what this class already decides, and a streaming turn must not
   * reindex the roster a hundred times a second.
   */
  const indexed: { name: string; label: string; subtitle: string }[][] = []
  const bots = fakeStore({ bots: [bot('researcher')], running: {}, lastSeen: {}, avatars: {} })
  const chats = fakeStore({ chats: {} })
  const layout = fakeStore({ accents: {}, archived: {}, folders: [], labels: {}, mutes: {} })
  // The widget's one name line follows the app's own order, so the sync reads
  // it and re-writes when it changes. `profile` is the shipping default.
  const settings = fakeStore({ botNameOrder: 'profile' })

  const sync = new WidgetSync({
    bridge: fake.bridge,
    spotlight: {
      async indexBots(bots) {
        indexed.push([...bots])

        return true
      }
    },
    // The stores are structurally what the sync reads and nothing more, which
    // is the whole reason it takes them rather than importing them.
    stores: { bots, chats, layout, settings } as unknown as never,
    debounceMs: 10,
    now: () => 1_770_000_000_000
  })

  return { ...fake, sync, bots, chats, layout, settings, indexed }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40))

describe('WidgetSync', () => {
  it('writes once on start, so a widget added while the app was shut has something to draw', async () => {
    const { sync, snapshots } = harness()
    const stop = sync.start()

    await settle()
    stop()

    expect(snapshots).toHaveLength(1)
    expect(JSON.parse(snapshots[0] ?? '{}').bots[0].name).toBe('researcher')
  })

  /** The case the debounce exists for: a turn streaming into the chat store. */
  it('coalesces a burst of notifications into one write', async () => {
    const { sync, snapshots, chats } = harness()
    const stop = sync.start()

    await settle()
    snapshots.length = 0

    for (let index = 0; index < 20; index += 1) {
      chats.set({ chats: {} })
    }

    await settle()
    stop()

    expect(snapshots.length).toBeLessThanOrEqual(1)
  })

  it('drops a write that would draw the same pixels', async () => {
    const { sync, snapshots, layout } = harness()
    const stop = sync.start()

    await settle()
    snapshots.length = 0

    // A notification with no change behind it — which is most of them.
    layout.set({ accents: {}, archived: {}, labels: {}, mutes: {} })
    await settle()
    stop()

    expect(snapshots).toHaveLength(0)
  })

  it('writes again when something a reader would see changed', async () => {
    const { sync, snapshots, bots } = harness()
    const stop = sync.start()

    // Presence is `offline` for everything until the socket is up, so a busy
    // session would change nothing at all without this.
    sync.setGatewayReady(true)
    await settle()
    snapshots.length = 0

    bots.set({ running: { researcher: true } })
    await settle()
    stop()

    expect(snapshots).toHaveLength(1)
    expect(JSON.parse(snapshots[0] ?? '{}').bots[0].presence).toBe('working')
  })

  it('reports offline until it is told the socket is up', async () => {
    const { sync, snapshots } = harness()
    const stop = sync.start()

    await settle()
    expect(JSON.parse(snapshots[0] ?? '{}').bots[0].presence).toBe('offline')

    sync.setGatewayReady(true)
    await settle()
    stop()

    expect(JSON.parse(snapshots[snapshots.length - 1] ?? '{}').bots[0].presence).toBe('online')
  })

  it('writes an avatar once, with the data-URL prefix taken off', async () => {
    const { sync, avatars, bots } = harness()
    const stop = sync.start()

    await settle()
    bots.set({ avatars: { researcher: 'data:image/png;base64,AAAA' } })
    await settle()
    // A second notification that changes nothing about the picture.
    bots.set({ running: { researcher: true } })
    await settle()
    stop()

    expect(avatars).toEqual([{ name: 'researcher', base64: 'AAAA' }])
  })

  it('names the avatar in the snapshot only after the file went in', async () => {
    const { sync, snapshots, bots } = harness()
    const stop = sync.start()

    await settle()
    bots.set({ avatars: { researcher: 'data:image/png;base64,AAAA' } })
    await settle()
    stop()

    expect(JSON.parse(snapshots[snapshots.length - 1] ?? '{}').bots[0].avatarPath).toBe('avatars/researcher.png')
  })

  it('skips something that is not a data URL rather than writing garbage', async () => {
    const { sync, avatars, bots } = harness()
    const stop = sync.start()

    await settle()
    bots.set({ avatars: { researcher: 'https://example.invalid/a.png' } })
    await settle()
    stop()

    expect(avatars).toEqual([])
  })

  it('does nothing at all where there is no shared container', async () => {
    const { sync, snapshots } = harness({ available: false })
    const stop = sync.start()

    await settle()
    stop()

    expect(snapshots).toHaveLength(0)
  })

  it('flushes without waiting for the debounce', async () => {
    const { sync, snapshots } = harness()
    const stop = sync.start()

    await sync.flush()
    stop()

    expect(snapshots).toHaveLength(1)
  })

  /**
   * Measured on a simulator on 2026-09-21: pressing the home button turned every
   * bead on the widget grey, because the socket goes down when a phone
   * backgrounds the app and `presenceOf` correctly calls that offline. The last
   * word a widget has must be the last thing the app SAW, not the state of the
   * app being put away.
   */
  it('writes the foreground truth on pause and then goes quiet', async () => {
    const { sync, snapshots, bots } = harness()
    const stop = sync.start()

    sync.setGatewayReady(true)
    await settle()
    snapshots.length = 0

    // A roster change that landed inside the debounce window, the way one does
    // while somebody is pressing the home button.
    bots.set({ bots: [bot('researcher'), bot('writer')] })
    sync.pause()

    // The socket going down BEFORE the paused write has run, which is what
    // actually happens: the write is serialised behind a promise and awaits the
    // avatar pass, and React's effect on `status` gets to run in between. The
    // first version of this read the flag late and wrote four grey beads.
    sync.setGatewayReady(false)
    await settle()

    expect(snapshots).toHaveLength(1)
    expect(JSON.parse(snapshots[0] ?? '{}').bots[0].presence).toBe('online')

    bots.set({ running: { researcher: true } })
    await settle()
    stop()

    expect(snapshots).toHaveLength(1)
  })

  it('writes what is true again on resume', async () => {
    const { sync, snapshots } = harness()
    const stop = sync.start()

    sync.setGatewayReady(true)
    await settle()
    sync.pause()
    await settle()
    sync.setGatewayReady(false)
    snapshots.length = 0

    sync.resume()
    await settle()
    stop()

    expect(snapshots).toHaveLength(1)
    expect(JSON.parse(snapshots[0] ?? '{}').bots[0].presence).toBe('offline')
  })

  it('stops writing once it is torn down', async () => {
    const { sync, snapshots, bots } = harness()
    const stop = sync.start()

    await settle()
    snapshots.length = 0
    stop()

    bots.set({ running: { researcher: true } })
    await settle()

    expect(snapshots).toHaveLength(0)
  })
})

/**
 * Spotlight rides on the widget write.
 *
 * Not a separate schedule, and the reason is that this class already answers
 * the question the index is asking. "The roster changed in a way somebody would
 * see" is what `sameWidgetContent` decides, and it is already debounced — so an
 * index pass costs one call on exactly the edges that matter.
 */
describe('the Spotlight index', () => {
  it('is written with the same roster the widget draws', async () => {
    const { sync, indexed } = harness()
    const stop = sync.start()

    await settle()
    stop()

    expect(indexed).toHaveLength(1)
    expect(indexed[0]).toEqual([{ name: 'researcher', label: 'researcher', subtitle: 'hi' }])
  })

  /**
   * The whole point of hanging it here. An undebounced index pass on every
   * token of every turn would be the same mistake the widget write was written
   * to avoid, one API further down.
   */
  it('is not rewritten for a notification that changes nothing', async () => {
    const { sync, indexed, chats } = harness()
    const stop = sync.start()

    await settle()
    indexed.length = 0

    for (let index = 0; index < 20; index += 1) {
      chats.set({ chats: {} })
    }

    await settle()
    stop()

    expect(indexed).toHaveLength(0)
  })

  /**
   * A failing index must not take the widget down with it. There is no
   * container on the web and no CoreSpotlight on Android, and both answer
   * `false` — but a throw from a native promise here would reject inside a
   * store subscription, where nobody is catching.
   */
  it('survives an index that throws', async () => {
    const { sync, snapshots } = harness()

    // The harness's own port is replaced after construction, which is the only
    // way to reach the failure path without a second harness.
    Object.assign(sync as unknown as { spotlight: unknown }, {
      spotlight: {
        indexBots: () => Promise.reject(new Error('no index'))
      }
    })

    const stop = sync.start()

    await settle()
    stop()

    expect(snapshots).toHaveLength(1)
  })
})
