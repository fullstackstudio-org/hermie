/**
 * The page's half of ADR-0016: the stores against the two `ui_meta` keys.
 *
 * `packages/gateway-client/src/ui-meta.test.ts` exercises the protocol against
 * a real fake gateway. This is the adapter above it, and what is worth pinning
 * here is what an adapter can get quietly wrong:
 *
 *  - the SHAPE: which store field lands in which key, and that the window's own
 *    state (`sidebarCollapsed`, the closed folders) lands in neither;
 *  - the DIFF: a change anybody makes, through any setter, is noticed — and a
 *    section that goes AWAY is a change too;
 *  - the LOOP that must not close: a gateway's copy going into the stores must
 *    not read back as a local change and be sent straight home again;
 *  - the CARRY: what this build does not understand goes back as it came.
 *
 * Ported from the Expo app's `__tests__/ui-meta-bridge.test.ts` (the projection
 * and bridge cases, against this client's stores; the settings-store cases
 * became raw-carry cases, since the defaults, name order and theme have no store
 * here). The take rules, the carry, the retired fields and the persistence of
 * pending edits are new, and follow the Swift app's `UIMetaDocuments`.
 */
import type { UiMetaSnapshot } from '@hermie/gateway-client/ui-meta'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStampStore } from '../state/app-stamp'
import { createLayoutStore } from '../state/layout'
import { createTextSizeStore } from '../state/text-size'
import {
  APP_KEY,
  holdingGateway,
  newDisk,
  OWNER,
  openPage,
  type Page,
  PER_USER_ADVERT,
  settled
} from '../test-support/ui-meta-devices'
import { applyToStores, takeApp, UI_META_PENDING_KEY, UiMetaBridge, withoutRetiredStamp } from './ui-meta-bridge'

const pages: Page[] = []

afterEach(async () => {
  while (pages.length) {
    pages.pop()?.stop()
  }

  await settled()
})

/** A page on `gateway`, stopped after the case. */
function page(...args: Parameters<typeof openPage>): Page {
  const opened = openPage(...args)

  pages.push(opened)

  return opened
}

/** Fresh stores, for the pure `applyToStores`. */
const freshStores = () => ({
  layout: createLayoutStore(),
  textSize: createTextSizeStore(),
  appStamp: createAppStampStore()
})

describe('the projection', () => {
  it('puts a bot’s own settings in the bot key and the rest in the app key', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    one.layout.getState().addFolder('Finance')
    one.layout.getState().setArchived('writer', true)
    one.layout.getState().setAccent('researcher', 'lime')
    one.textSize.getState().setTextSize('large')

    const { app, bots } = one.bridge.documents

    expect(bots).toEqual({ writer: { v: 1, archived: true }, researcher: { v: 1, colour: 'lime' } })
    expect(app?.textSize).toBe('large')
    // The top level names a folder by id; the folder itself carries the name.
    expect((app?.entries as { kind: string }[]).some(entry => entry.kind === 'folder')).toBe(true)
    expect((app?.folders as { name: string }[]).some(folder => folder.name === 'Finance')).toBe(true)
  })

  it('leaves the window out of it', async () => {
    const one = page(holdingGateway())

    await one.watching
    one.layout.getState().setSidebarCollapsed(true)
    one.layout.getState().setConversationsCollapsed(true)
    one.layout.getState().setFolderOpen(one.layout.getState().addFolder('Finance'), false)

    // A desktop hiding its list must not collapse a tablet's.
    const text = JSON.stringify(one.bridge.documents)

    expect(text).not.toContain('sidebarCollapsed')
    expect(text).not.toContain('conversationsCollapsed')
    expect(text).not.toContain('collapsed')
  })

  it('reads a gateway’s copy back into the stores', () => {
    const stores = freshStores()

    applyToStores(
      {
        app: { v: 1, entries: [{ kind: 'chat', name: 'writer' }], textSize: 'small', updatedAt: 1_000 },
        bots: { researcher: { v: 1, archived: true, colour: 'teal' } }
      },
      stores
    )

    expect(stores.layout.getState().entries).toEqual([{ kind: 'chat', name: 'writer' }])
    expect(stores.layout.getState().archived).toEqual({ researcher: true })
    expect(stores.layout.getState().accents).toEqual({ researcher: 'teal' })
    expect(stores.textSize.getState().textSize).toBe('small')
    expect(stores.appStamp.getState().updatedAt).toBe(1_000)
  })

  describe('what this reader calls a bot', () => {
    it('is projected into the app section, and not onto the bot’s own', async () => {
      const one = page(holdingGateway())

      await one.watching
      one.layout.getState().setAccent('writer', 'lime')
      one.layout.getState().setLabel('writer', 'De Schrijver')

      expect(one.bridge.documents.app?.labels).toEqual({ writer: 'De Schrijver' })
      expect(one.bridge.documents.bots).toEqual({ writer: { v: 1, colour: 'lime' } })
    })

    it('comes back out of a gateway’s copy, and absent is not empty', () => {
      const stores = freshStores()

      applyToStores({ app: { v: 1, labels: { writer: 'De Schrijver' } }, bots: {} }, stores)
      expect(stores.layout.getState().labels).toEqual({ writer: 'De Schrijver' })

      applyToStores({ app: { v: 1 }, bots: {} }, stores)
      expect(stores.layout.getState().labels).toEqual({ writer: 'De Schrijver' })

      // An empty map is the other answer, and clears them.
      applyToStores({ app: { v: 1, labels: {} }, bots: {} }, stores)
      expect(stores.layout.getState().labels).toEqual({})
    })
  })

  it('does not read an absent arrangement as an empty one', () => {
    const stores = freshStores()

    stores.layout.getState().addFolder('Finance')
    applyToStores({ app: { v: 1 }, bots: {} }, stores)

    expect(stores.layout.getState().entries).toHaveLength(1)
  })

  it('keeps a colour this build does not have out of the store', () => {
    const stores = freshStores()

    applyToStores({ app: null, bots: { researcher: { v: 1, colour: 'tartan' } } }, stores)

    expect(stores.layout.getState().accents).toEqual({})
  })

  it('leaves the text size alone for a size it does not know', () => {
    const stores = freshStores()

    stores.textSize.getState().setTextSize('large')
    applyToStores({ app: { v: 1, textSize: 'huge' }, bots: {} }, stores)

    expect(stores.textSize.getState().textSize).toBe('large')
  })
})

/**
 * Taking a gateway's copy (the Swift app's `UIMetaDocuments.take`), as one pure
 * function.
 */
describe('taking a gateway’s copy', () => {
  const remote = (app: Record<string, unknown> | null, extra: Partial<UiMetaSnapshot> = {}): UiMetaSnapshot => ({
    app: app as UiMetaSnapshot['app'],
    bots: {},
    remote: app as UiMetaSnapshot['app'],
    ...extra
  })

  it('takes every field it carries, the ones this build does not know included', () => {
    const app = { v: 1, entries: [], futureField: { a: 1 }, defaults: { level: 'verbose' } }

    expect(takeApp(null, remote(app))).toEqual(app)
  })

  it('drops a field the gateway’s copy no longer carries, unless it predates that field', () => {
    const held = { v: 1, futureField: 'old', labels: { writer: 'W' }, themeChoice: { kind: 'preset', name: 'lime' } }
    const taken = takeApp(held, remote({ v: 1 }))

    // Any client can remove a field it knows; a section that simply predates
    // `labels` or `themeChoice` says nothing about them.
    expect(taken).not.toHaveProperty('futureField')
    expect(taken?.labels).toEqual({ writer: 'W' })
    expect(taken?.themeChoice).toEqual({ kind: 'preset', name: 'lime' })
  })

  it('adopts the date as it arrived, absent included', () => {
    expect(takeApp({ v: 1, updatedAt: 5 }, remote({ v: 1, updatedAt: 9 }))?.updatedAt).toBe(9)
    expect(takeApp({ v: 1, updatedAt: 5 }, remote({ v: 1 }))).not.toHaveProperty('updatedAt')
  })

  it('takes the push rows from where the notifier looks, never from this page', () => {
    const rows = { registrations: { other: { v: 1, transport: 'relay' } } }
    const taken = takeApp(
      { v: 1, push: { registrations: { stale: {} } } },
      remote({ v: 1 }, { pushHome: { v: 1, push: rows } })
    )

    expect(taken?.push).toEqual(rows)
    expect(takeApp({ v: 1, push: { registrations: {} } }, remote({ v: 1 }))).not.toHaveProperty('push')
  })

  it('keeps the held section when the gateway has none, with the gateway’s push rows', () => {
    expect(takeApp({ v: 1, textSize: 'large', push: { registrations: {} } }, remote(null))).toEqual({
      v: 1,
      textSize: 'large'
    })
  })

  it('drops the retired fields: context, and the daemon’s availability stamp', () => {
    const taken = takeApp(
      null,
      remote({
        v: 1,
        context: { users: {} },
        push: {
          registrations: { a: { v: 1 } },
          daemonVersion: 1,
          endpoint: '/push/vapid-public-key',
          vapidPublicKey: 'BK',
          version: '0.4.0',
          capabilities: ['push.webpush'],
          relayOrigins: [],
          at: 1_790_000_000
        }
      })
    )

    expect(taken).not.toHaveProperty('context')
    expect(taken?.push).toEqual({ registrations: { a: { v: 1 } } })
  })

  it('leaves a push map with no stamp in it exactly as it is', () => {
    const push = { registrations: {}, seen: {} }

    expect(withoutRetiredStamp(push)).toBe(push)
    expect(withoutRetiredStamp({ at: 1, endpoint: 'x' })).toEqual({})
  })

  it('takes the gateway’s fields this build does not project even when this page’s copy won', () => {
    // The one departure from the Swift app: this page cannot have chosen
    // anything about a field it does not know, so the gateway's is the newest.
    const local = { v: 1, textSize: 'large', updatedAt: 20, futureField: 'old' }
    const gateway = { v: 1, textSize: 'small', updatedAt: 10, futureField: 'new', addedElsewhere: true }
    const taken = takeApp(local, { app: local, bots: {}, remote: gateway })

    expect(taken).toMatchObject({ textSize: 'large', updatedAt: 20, futureField: 'new', addedElsewhere: true })
  })
})

describe('the bridge', () => {
  it('sends a section anybody changed, whichever setter did it', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    one.layout.getState().setAccent('researcher', 'lime')
    await settled()

    const write = gateway.writes[0]

    expect(write?.name).toBe('researcher')
    expect(write?.ui_meta).toMatchObject({ hermie: { colour: 'lime' } })
    // Only the key it is changing: `hermes-bots` is not ours to send.
    expect(Object.keys(write?.ui_meta ?? {})).toEqual(['hermie'])
  })

  it('notices a section that went away, and removes it rather than emptying it', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.watching
    await one.bridge.reconcile()
    one.layout.getState().setArchived('writer', true)
    await settled()
    gateway.writes.length = 0

    one.layout.getState().setArchived('writer', false)
    await settled()

    expect(gateway.writes.at(-1)?.ui_meta).toEqual({ hermie: null })
    expect(gateway.meta('writer')).toEqual({ 'hermes-bots': {} })
  })

  it('seeds a gateway that has no section yet, and then says nothing more', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.bridge.reconcile()
    await settled()

    expect(gateway.writes).toHaveLength(1)
    expect(gateway.app()).toMatchObject({ v: 1, entries: [], textSize: 'default' })

    // And nothing echoes: what came back in must not read as a local change.
    gateway.writes.length = 0
    await one.bridge.reconcile()
    await settled()

    expect(gateway.writes).toHaveLength(0)
  })

  it('sends one request per profile, not one per section', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.bridge.reconcile()
    gateway.writes.length = 0

    one.layout.getState().setAccent('researcher', 'lime')
    one.textSize.getState().setTextSize('large')
    await settled()

    // `researcher` is the default profile, so both sections are its own.
    expect(gateway.writes).toHaveLength(1)
    expect(Object.keys(gateway.writes[0]?.ui_meta ?? {}).sort()).toEqual(['hermie', APP_KEY])
  })

  it('never writes the plugin’s key, nor the marker another tool owns', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.bridge.reconcile()
    one.layout.getState().reconcile(['researcher', 'writer'])
    one.layout.getState().setAccent('researcher', 'teal')
    one.layout.getState().setArchived('writer', true)
    one.textSize.getState().setTextSize('xlarge')
    await settled()
    await one.bridge.reconcile()

    const named = new Set(gateway.writes.flatMap(write => Object.keys(write.ui_meta)))

    expect(named.has('hermie-plugin')).toBe(false)
    expect(named.has('hermes-bots')).toBe(false)
    expect(gateway.meta('researcher')['hermie-plugin']).toEqual(PER_USER_ADVERT)
    expect(gateway.meta('researcher')).toHaveProperty('hermes-bots')
  })

  it('writes nothing under the app key while nobody has been named', async () => {
    const gateway = holdingGateway()
    const one = page(gateway, { user: '' })

    await one.bridge.reconcile()
    one.textSize.getState().setTextSize('large')
    await settled()

    expect(gateway.writes.flatMap(write => Object.keys(write.ui_meta))).not.toContain(APP_KEY)
    expect(Object.keys(gateway.meta('researcher')).some(key => key.startsWith('hermie-app'))).toBe(false)
  })
})

describe('carrying what this build does not understand', () => {
  it('sends a field another build added back as it came', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', {
      name: 'researcher',
      ui_meta: {
        [APP_KEY]: { v: 1, entries: [], futureField: { nested: [1, 2] }, defaults: { level: 'verbose' }, updatedAt: 10 }
      }
    })

    const one = page(gateway)

    await one.bridge.reconcile()
    one.textSize.getState().setTextSize('large')
    await settled()

    expect(gateway.app()).toMatchObject({
      futureField: { nested: [1, 2] },
      defaults: { level: 'verbose' },
      textSize: 'large'
    })
  })

  it('keeps a size this build cannot read until the reader picks one here', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', {
      name: 'researcher',
      ui_meta: { [APP_KEY]: { v: 1, textSize: 'huge', updatedAt: 10 } }
    })

    const one = page(gateway)

    await one.bridge.reconcile()
    one.layout.getState().setPinned('writer', true)
    await settled()

    expect(gateway.app()?.textSize).toBe('huge')

    one.textSize.getState().setTextSize('small')
    await settled()

    expect(gateway.app()?.textSize).toBe('small')
  })

  it('keeps a colour this build cannot draw on the bot’s section, and every unknown bot field', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', {
      name: 'writer',
      ui_meta: { hermie: { v: 1, colour: 'tartan', futureBotField: 7 } }
    })

    const one = page(gateway)

    await one.bridge.reconcile()
    one.layout.getState().setArchived('writer', true)
    await settled()

    expect(gateway.meta('writer').hermie).toEqual({ v: 1, colour: 'tartan', futureBotField: 7, archived: true })

    // A colour picked here replaces it; unarchiving leaves the unknown field,
    // so the section stays rather than being removed.
    one.layout.getState().setAccent('writer', 'teal')
    one.layout.getState().setArchived('writer', false)
    await settled()

    expect(gateway.meta('writer').hermie).toEqual({ v: 1, colour: 'teal', futureBotField: 7 })
  })

  it('drops the retired availability stamp the next time the section is written', async () => {
    const gateway = holdingGateway()
    const stamp = {
      daemonVersion: 1,
      endpoint: '/push/vapid-public-key',
      vapidPublicKey: 'BK',
      version: '0.4.0',
      at: 9
    }

    await gateway.request('profiles.configure', {
      name: 'researcher',
      ui_meta: { [APP_KEY]: { v: 1, push: { registrations: { phone: { v: 1, transport: 'relay' } }, ...stamp } } }
    })

    const one = page(gateway)

    await one.bridge.reconcile()

    // Not written for the stamp's sake alone ...
    expect(gateway.app()?.push).toMatchObject(stamp)

    one.textSize.getState().setTextSize('large')
    await settled()

    // ... and gone the next time the section is, with every row kept.
    expect(gateway.app()?.push).toEqual({ registrations: { phone: { v: 1, transport: 'relay' } } })
  })

  it('drops the stamp from the bare key too, where an older notifier keeps the rows', async () => {
    // No `ui_meta.per_user`: `UiMetaSync` writes the rows to the bare
    // `hermie-app` as well, a read-modify-write of only its `push`.
    const gateway = holdingGateway({ advert: null })

    await gateway.request('profiles.configure', {
      name: 'researcher',
      ui_meta: {
        'hermie-app': {
          v: 1,
          entries: [{ kind: 'chat', name: 'writer' }],
          push: { registrations: { phone: { v: 1, transport: 'expo', token: 't' } }, endpoint: '/x', at: 9 }
        }
      }
    })

    const one = page(gateway)

    await one.bridge.reconcile()
    await settled()

    const bare = gateway.app('hermie-app')

    expect(bare?.push).toEqual({ registrations: { phone: { v: 1, transport: 'expo', token: 't' } } })
    // The arrangement an older build reads from the bare key is left alone.
    expect(bare?.entries).toEqual([{ kind: 'chat', name: 'writer' }])
    // And the per-person key does not carry the rows a second time.
    expect(gateway.app()).not.toHaveProperty('push')
  })
})

describe('across a reload', () => {
  it('sends a bot edit made with no gateway when the page comes back', async () => {
    const gateway = holdingGateway()
    const disk = newDisk()
    const offline = page({ request: () => Promise.reject(new Error('gateway not connected')) }, { disk })

    await offline.bridge.reconcile()
    offline.layout.getState().reconcile(['researcher', 'writer'])
    offline.layout.getState().setArchived('writer', true)
    await settled()
    offline.stop()
    await offline.bridge.settled()

    expect(JSON.parse(disk.getSync(UI_META_PENDING_KEY) ?? 'null')).toEqual({
      v: 1,
      bots: { writer: { archived: true, v: 1 } },
      fields: { writer: ['archived'] }
    })

    const back = page(gateway, { disk })

    await back.bridge.reconcile()
    await settled()

    expect(gateway.meta('writer').hermie).toEqual({ v: 1, archived: true })
    await back.bridge.settled()
    expect(disk.getSync(UI_META_PENDING_KEY)).toBeNull()
  })
})

describe('reconciling soon', () => {
  it('runs one reconcile, and at most one more, for a burst of calls', async () => {
    const gateway = holdingGateway()
    let lists = 0
    const counting = {
      request: (method: string, params?: Record<string, unknown>) => {
        lists += method === 'profiles.list' ? 1 : 0

        return gateway.request(method, params)
      }
    }
    const one = page(counting)

    await one.watching

    const burst = [one.bridge.reconcileSoon(), one.bridge.reconcileSoon(), one.bridge.reconcileSoon()]

    await Promise.all(burst)

    expect(lists).toBe(2)
  })
})

describe('a different person', () => {
  it('starts from nothing rather than carrying the previous reader’s arrangement', async () => {
    const gateway = holdingGateway()
    const one = page(gateway)

    await one.bridge.reconcile()
    one.layout.getState().reconcile(['researcher', 'writer'])
    one.layout.getState().addFolder('Finance')
    one.layout.getState().setAccent('writer', 'teal')
    await settled()

    one.bridge.setUser('someone-else')
    await one.bridge.reconcile()
    await settled()

    expect(one.layout.getState().folders).toEqual([])
    // The bots' colours are about the bots, and stay.
    expect(one.layout.getState().accents).toEqual({ writer: 'teal' })
    // The first person's section is untouched, and the second has their own.
    expect((gateway.app() as { folders: unknown[] }).folders).toHaveLength(1)
    expect(gateway.app('hermie-app:someone-else')?.folders).toEqual([])
    expect(one.bridge.appKey).toBe('hermie-app:someone-else')
  })
})

describe('the page’s own stores', () => {
  it('are used when none are handed in', () => {
    const bridge = new UiMetaBridge({ gateway: holdingGateway() })

    expect(bridge.appKey).toBeNull()
    bridge.setUser(OWNER)
    expect(bridge.appKey).toBe(APP_KEY)
  })
})

/** The person's folders, undated: what a build before dates wrote. */
const FOLDERS = {
  v: 1,
  entries: [{ kind: 'folder', id: 'f1' }],
  folders: [{ id: 'f1', name: 'Finance', bots: ['researcher', 'writer'] }]
}

/** A gateway that can be taken away and given back. */
function switchable(gateway: ReturnType<typeof holdingGateway>) {
  const state = { down: false }

  return {
    state,
    request: (method: string, params?: Record<string, unknown>) =>
      state.down ? Promise.reject(new Error('gateway not connected')) : gateway.request(method, params)
  }
}

describe('a chore against the gateway’s copy', () => {
  it('never wins over an undated section, and is not sent', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', { name: 'researcher', ui_meta: { [APP_KEY]: FOLDERS } })

    const one = page(gateway)

    await one.watching
    // The roster folded in before the gateway's copy was read: an undated flat list.
    one.layout.getState().reconcile(['researcher', 'writer'])
    await one.bridge.reconcile()
    await settled()

    expect(gateway.app()).toEqual(FOLDERS)
    expect(one.layout.getState().folders.map(folder => folder.name)).toEqual(['Finance'])
    expect(one.layout.getState().entries).toEqual(FOLDERS.entries)
    expect(one.bridge.pending).toBe(false)
  })
})

describe('an edit made while a send is out', () => {
  /** The gateway, with the answer to one `profiles.configure` held back until `release`. */
  function heldBack(gateway: ReturnType<typeof holdingGateway>) {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    let first = false

    return {
      /** Hold back the answer to the next write. */
      arm: () => {
        first = true
      },
      release: () => release(),
      request: async (method: string, params?: Record<string, unknown>) => {
        const answer = gateway.request(method, params)

        if (method === 'profiles.configure' && first) {
          first = false
          await gate
        }

        return answer
      }
    }
  }

  it('is not lost for a bot', async () => {
    const gateway = holdingGateway()
    const slow = heldBack(gateway)
    const one = page(slow)

    await one.bridge.reconcile()
    slow.arm()
    one.layout.getState().setArchived('writer', true)
    await settled()

    // The archive is out; the colour is picked before it lands.
    one.layout.getState().setAccent('writer', 'teal')
    await settled()
    slow.release()
    await settled()
    await settled()

    expect(gateway.meta('writer').hermie).toEqual({ v: 1, archived: true, colour: 'teal' })
    expect(one.bridge.pending).toBe(false)

    await one.bridge.reconcile()
    expect(one.layout.getState().accents).toEqual({ writer: 'teal' })
  })

  it('is not lost for the app section', async () => {
    const gateway = holdingGateway()
    const slow = heldBack(gateway)
    const one = page(slow)

    await one.bridge.reconcile()
    slow.arm()
    one.textSize.getState().setTextSize('large')
    await settled()

    one.layout.getState().setPinned('writer', true)
    await settled()
    slow.release()
    await settled()
    await settled()

    expect(gateway.app()).toMatchObject({ textSize: 'large', pinned: ['writer'] })
    expect(one.bridge.pending).toBe(false)

    await one.bridge.reconcile()
    expect(one.layout.getState().pinned).toEqual({ writer: true })
  })
})

describe('pending bots across a reload', () => {
  it('are sent from their stored raw sections, with what another client added meanwhile', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', {
      name: 'writer',
      ui_meta: { hermie: { v: 1, colour: 'tartan', futureBotField: 7 } }
    })

    const link = switchable(gateway)
    const disk = newDisk()
    const first = page(link, { disk })

    await first.bridge.reconcile()
    link.state.down = true
    first.layout.getState().setArchived('writer', true)
    await settled()
    first.stop()
    await first.bridge.settled()

    // Stored raw: the colour this build cannot draw and the field it does not own.
    expect(JSON.parse(disk.getSync(UI_META_PENDING_KEY) ?? 'null')).toEqual({
      v: 1,
      bots: { writer: { v: 1, colour: 'tartan', futureBotField: 7, archived: true } },
      fields: { writer: ['archived'] }
    })

    // Another client adds a field while this page is away.
    await gateway.request('profiles.configure', {
      name: 'writer',
      ui_meta: { hermie: { v: 1, colour: 'tartan', futureBotField: 7, addedElsewhere: true } }
    })

    link.state.down = false

    const back = page(link, { disk })

    await back.bridge.reconcile()
    await settled()

    expect(gateway.meta('writer').hermie).toEqual({
      v: 1,
      colour: 'tartan',
      futureBotField: 7,
      addedElsewhere: true,
      archived: true
    })
  })

  it('never removes a section that carries fields this page does not own', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', {
      name: 'writer',
      ui_meta: { hermie: { v: 1, archived: true, futureBotField: 7 } }
    })

    // A page that never saw the gateway's copy archives and unarchives: what it
    // holds for the bot is nothing at all.
    const disk = newDisk()
    const offline = page({ request: () => Promise.reject(new Error('gateway not connected')) }, { disk })

    await offline.bridge.reconcile()
    offline.layout.getState().setArchived('writer', true)
    offline.layout.getState().setArchived('writer', false)
    await settled()
    offline.stop()
    await offline.bridge.settled()

    expect(JSON.parse(disk.getSync(UI_META_PENDING_KEY) ?? 'null')).toEqual({
      v: 1,
      bots: { writer: null },
      fields: { writer: ['archived'] }
    })

    const back = page(gateway, { disk })

    await back.bridge.reconcile()
    await settled()

    // Unarchived, as chosen here; the field it does not own, still there.
    expect(gateway.meta('writer').hermie).toEqual({ v: 1, futureBotField: 7 })
    expect(gateway.writes.flatMap(write => Object.values(write.ui_meta))).not.toContain(null)
  })
})

describe('inheriting the anonymous arrangement, end to end', () => {
  const LEGACY = {
    ...FOLDERS,
    themeChoice: { kind: 'preset', name: 'graphite' },
    context: { users: { someone: {} } },
    push: {
      registrations: { phone: { v: 1, transport: 'expo', token: 't' } },
      endpoint: '/push/vapid-public-key',
      vapidPublicKey: 'BK',
      at: 9
    }
  }

  it('gives the person’s key the arrangement, and leaves the bare key as it was but for the stamp', async () => {
    // No `ui_meta.per_user`: the rows stay on the bare key, where the notifier reads.
    const gateway = holdingGateway({ advert: null })

    await gateway.request('profiles.configure', { name: 'researcher', ui_meta: { 'hermie-app': LEGACY } })

    const one = page(gateway)

    await one.watching
    one.layout.getState().reconcile(['researcher', 'writer'])
    await one.bridge.reconcile()
    await settled()

    const mine = gateway.app()
    const bare = gateway.app('hermie-app')

    expect(mine).toMatchObject({ entries: FOLDERS.entries, folders: FOLDERS.folders, themeChoice: LEGACY.themeChoice })
    expect(mine).not.toHaveProperty('push')
    expect(mine).not.toHaveProperty('context')
    expect(bare).toEqual({ ...LEGACY, push: { registrations: LEGACY.push.registrations } })
    expect(one.layout.getState().folders.map(folder => folder.name)).toEqual(['Finance'])
  })

  it('does not write the bare key at all where the notifier reads the person’s', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', { name: 'researcher', ui_meta: { 'hermie-app': LEGACY } })

    const one = page(gateway)

    await one.bridge.reconcile()
    await settled()

    expect(gateway.app()).toMatchObject({ folders: FOLDERS.folders })
    expect(gateway.app()).not.toHaveProperty('push')
    expect(gateway.app('hermie-app')).toEqual(LEGACY)
  })
})

describe('when this page’s app section wins', () => {
  it('drops a field the gateway no longer carries, and keeps one a section can predate', () => {
    const local = {
      v: 1,
      textSize: 'large',
      updatedAt: 20,
      removedElsewhere: 'gone',
      themeChoice: { kind: 'preset', name: 'lime' },
      defaults: { level: 'verbose' }
    }
    const gateway = { v: 1, textSize: 'small', updatedAt: 10, defaults: { level: 'quiet' } }
    const taken = takeApp(local, { app: local, bots: {}, remote: gateway })

    // Another build removed it: the gateway's copy is the newest word on a field
    // this build does not project.
    expect(taken).not.toHaveProperty('removedElsewhere')
    // Silent about a field a section can predate: the held value stays.
    expect(taken?.themeChoice).toEqual({ kind: 'preset', name: 'lime' })
    // Carried by the gateway: its value.
    expect(taken?.defaults).toEqual({ level: 'quiet' })
    // And what this page projects is this page's.
    expect(taken).toMatchObject({ textSize: 'large', updatedAt: 20 })
  })
})

describe('a bot section written by a newer build', () => {
  const NEWER = { v: 2, shape: 'new', archived: 'by-policy' }

  it('is never written over: the change is kept back, pending, and said in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', { name: 'writer', ui_meta: { hermie: NEWER } })
    gateway.writes.length = 0

    const one = page(gateway)

    await one.bridge.reconcile()
    one.layout.getState().setArchived('writer', true)
    one.layout.getState().setAccent('researcher', 'teal')
    await settled()

    expect(gateway.meta('writer').hermie).toEqual(NEWER)
    expect(gateway.writes.some(write => write.name === 'writer')).toBe(false)
    // Every other section still goes out.
    expect(gateway.meta('researcher').hermie).toEqual({ v: 1, colour: 'teal' })
    expect(one.bridge.pending).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writer'))

    // A further reconcile does not send it either.
    await one.bridge.reconcile()
    expect(gateway.meta('writer').hermie).toEqual(NEWER)

    warn.mockRestore()
  })

  it('is not written over by a send made before this page read the roster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', { name: 'writer', ui_meta: { hermie: NEWER } })

    const one = page(gateway)

    await one.watching
    // Sent at once, under revision 0: refused, re-read, and then held.
    one.layout.getState().setArchived('writer', true)
    await settled()
    await settled()

    expect(gateway.meta('writer').hermie).toEqual(NEWER)
    expect(one.bridge.pending).toBe(true)

    warn.mockRestore()
  })
})

describe('a pending bot’s own fields', () => {
  it('send only what this page changed, so a colour picked elsewhere since survives an old archive', async () => {
    const gateway = holdingGateway()

    await gateway.request('profiles.configure', { name: 'writer', ui_meta: { hermie: { v: 1, colour: 'teal' } } })

    const link = switchable(gateway)
    const disk = newDisk()
    const yesterday = page(link, { disk })

    await yesterday.bridge.reconcile()
    link.state.down = true
    yesterday.layout.getState().setArchived('writer', true)
    await settled()
    yesterday.stop()
    await yesterday.bridge.settled()

    // Today, on another device: a new colour.
    await gateway.request('profiles.configure', { name: 'writer', ui_meta: { hermie: { v: 1, colour: 'red' } } })
    link.state.down = false

    const today = page(link, { disk })

    await today.bridge.reconcile()
    await settled()

    expect(gateway.meta('writer').hermie).toEqual({ v: 1, colour: 'red', archived: true })
    expect(today.layout.getState().accents).toEqual({ writer: 'red' })
    expect(today.layout.getState().archived).toEqual({ writer: true })
  })
})
