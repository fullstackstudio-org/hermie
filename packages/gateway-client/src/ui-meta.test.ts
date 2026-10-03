/**
 * The `ui_meta` client, against a running fake gateway.
 *
 * `packages/fake-gateway/src/ui-meta.test.ts` pins the PROTOCOL — that a write
 * leaves other keys alone, that revisions count per key, that a stale expected
 * revision is refused with `{ expected, actual }`. This suite is about the
 * CLIENT on top of it, and the four things ADR-0016 promises a reader:
 *
 *  1. a round trip: what one device writes, the next device reads;
 *  2. a conflict retried: a second writer between the read and the write does not
 *     cost the later writer their change;
 *  3. a write made with no gateway, and then synced when one appears;
 *  4. the marker `hermes-bots` still there afterwards — which is the one that
 *     would un-bot somebody's whole roster if it were ever false.
 *
 * It talks over a real socket rather than to a stub, because the question being
 * asked is whether this client and that protocol agree, and two stubs agreeing
 * with each other proves nothing.
 */
import { PLUGIN_ADVERT, startFakeGateway } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { HERMIE_PLUGIN_KEY } from './plugin'
import {
  APP_UPDATED_AT,
  appKeyFor,
  BOT_MARKER_KEY,
  HERMIE_APP_KEY,
  HERMIE_KEY,
  UiMetaSync,
  type UiMetaGateway,
  type UiMetaSnapshot
} from './ui-meta'

/** One JSON-RPC round trip over a real socket, so a case reads as the call it is. */
function callOn(socket: WebSocket): UiMetaGateway['request'] {
  let id = 0

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        const frame = JSON.parse(String(data)) as {
          id?: string
          result?: unknown
          error?: { message?: string }
        }

        if (frame.id !== frameId) {
          return
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(new Error(frame.error.message ?? 'rpc error'))

          return
        }

        resolve(frame.result ?? {})
      }

      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
    })
}

/**
 * Whoever the gateway named, for the cases that are not about two people.
 *
 * Every device in this suite belongs to somebody, because the app-wide key now
 * carries a person's name and a device the gateway has named nobody on writes no
 * arrangement at all. `owner` is what an ungated gateway answers.
 */
const OWNER = 'owner'

const APP_KEY = appKeyFor(OWNER)

interface Harness {
  request: UiMetaGateway['request']
  /** A device: its own local copy, and a sync bound to it. */
  device: (initial?: UiMetaSnapshot, userId?: string) => { sync: UiMetaSync; local: UiMetaSnapshot }
}

async function withGateway<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const request = callOn(socket)

    try {
      return await run({
        request,
        device(initial = { app: null, bots: {} }, userId = OWNER) {
          // The local copy is the thing the UI paints from; the sync only reads
          // it at the moment of a write and writes into it on a reconcile.
          const local: UiMetaSnapshot = { app: initial.app, bots: { ...initial.bots } }
          const sync = new UiMetaSync({
            gateway: { request },
            read: () => local,
            apply: snapshot => {
              local.app = snapshot.app
              local.bots = { ...snapshot.bots }
            }
          })

          // Before anything is read, exactly as `ChatRuntime` does it.
          sync.setUser(userId)

          return { sync, local }
        }
      })
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

const metaOf = async (request: UiMetaGateway['request'], name: string): Promise<Record<string, unknown>> => {
  const roster = (await request('profiles.list', {})) as {
    profiles?: { name: string; ui_meta?: Record<string, unknown> }[]
  }

  return roster.profiles?.find(row => row.name === name)?.ui_meta ?? {}
}

describe('one device writing', () => {
  it('sends a bot section and reads it back through profiles.list', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()

      phone.local.bots.researcher = { v: 1, archived: true, colour: 'lime' }
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      expect(await metaOf(request, 'researcher')).toMatchObject({
        [HERMIE_KEY]: { v: 1, archived: true, colour: 'lime' }
      })
      expect(phone.sync.pending).toBe(false)
      expect(phone.sync.mode).toBe('synced')
    })
  })

  it('leaves the marker another tool owns exactly where it was', async () => {
    // The one that matters. `hermes-bots` is what makes a profile show up as a
    // bot at all; a client that wrote its key by replacing the bag would un-bot
    // every profile it coloured.
    await withGateway(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.bots.researcher = { v: 1, colour: 'teal' }
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(meta).toHaveProperty(BOT_MARKER_KEY)
      // `hermie-plugin` is there too, and belongs to the gateway-side plugin.
      // Naming it here is the same assertion as the marker's: this client
      // writes its own key and leaves every other one exactly where it was.
      expect(Object.keys(meta).sort()).toEqual([BOT_MARKER_KEY, HERMIE_PLUGIN_KEY, HERMIE_KEY].sort())
    })
  })

  it('puts the app-wide section on the DEFAULT profile, and nowhere else', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = { v: 1, order: ['writer', 'researcher'] }
      phone.sync.markApp()
      await phone.sync.flush()

      expect(await metaOf(request, 'researcher')).toHaveProperty(APP_KEY)
      expect(await metaOf(request, 'writer')).not.toHaveProperty(APP_KEY)
    })
  })
})

describe('a second device', () => {
  it('reads what the first one wrote', async () => {
    await withGateway(async ({ device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = { v: 1, dividers: ['Finance'] }
      phone.local.bots.writer = { v: 1, archived: true }
      phone.sync.markApp()
      phone.sync.markBot('writer')
      await phone.sync.flush()

      const desktop = device()

      await desktop.sync.reconcile()

      expect(desktop.local.app).toMatchObject({ dividers: ['Finance'] })
      expect(desktop.local.bots.writer).toMatchObject({ archived: true })
    })
  })

  it('ignores a section whose schema version it does not know', async () => {
    // A newer build's shape is not something to guess at: the reader keeps its
    // local copy rather than painting fields it cannot read.
    await withGateway(async ({ request, device }) => {
      await request('profiles.configure', {
        name: 'researcher',
        ui_meta: { [HERMIE_KEY]: { v: 99, colour: 'from-the-future' } }
      })

      const phone = device({ app: null, bots: { researcher: { v: 1, colour: 'teal' } } })

      await phone.sync.reconcile()

      expect(phone.local.bots.researcher).toBeUndefined()
    })
  })
})

describe('two devices at once', () => {
  it('retries a refused write with the revision that won, and lands', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()
      const desktop = device()

      // Both read the same revision …
      await phone.sync.reconcile()
      await desktop.sync.reconcile()

      // … the desktop writes first …
      desktop.local.bots.researcher = { v: 1, colour: 'teal' }
      desktop.sync.markBot('researcher')
      await desktop.sync.flush()

      // … and the phone, holding a revision that is now stale, writes anyway.
      phone.local.bots.researcher = { v: 1, colour: 'lime' }
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      // Last writer wins, per section. The phone was later, so the phone's
      // value is the one on the profile — and nothing was left dirty.
      expect(await metaOf(request, 'researcher')).toMatchObject({ [HERMIE_KEY]: { colour: 'lime' } })
      expect(phone.sync.pending).toBe(false)
    })
  })

  it('lands the sections of a request whose other section conflicts', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device()
      const desktop = device()

      await phone.sync.reconcile()
      await desktop.sync.reconcile()

      desktop.local.app = { v: 1, order: ['writer'] }
      desktop.sync.markApp()
      await desktop.sync.flush()

      // The phone's app section is stale and its bot section is not; the bot
      // section goes to the same profile in the same request.
      phone.local.app = { v: 1, order: ['researcher'] }
      phone.local.bots.researcher = { v: 1, archived: true }
      phone.sync.markApp()
      phone.sync.markBot('researcher')
      await phone.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(meta).toMatchObject({
        [HERMIE_KEY]: { archived: true },
        [APP_KEY]: { order: ['researcher'] }
      })
      expect(meta).toHaveProperty(BOT_MARKER_KEY)
    })
  })
})

describe('no gateway, and then one', () => {
  it('keeps a write local and sends it on the next reconcile', async () => {
    await withGateway(async ({ request }) => {
      const offline: UiMetaSnapshot = { app: null, bots: {} }
      const failing = new UiMetaSync({
        gateway: {
          request: () => Promise.reject(new Error('gateway not connected'))
        },
        read: () => offline,
        apply: snapshot => {
          offline.app = snapshot.app
          offline.bots = { ...snapshot.bots }
        }
      })

      offline.bots.researcher = { v: 1, colour: 'lime' }
      failing.markBot('researcher')

      expect(await failing.reconcile()).toBeNull()
      // The device's own copy is correct; the gateway's is not. That is the
      // ADR-0012 behaviour, still correct, rather than a degraded mode.
      expect(failing.mode).toBe('local')
      expect(failing.pending).toBe(true)
      expect(await metaOf(request, 'researcher')).not.toHaveProperty(HERMIE_KEY)

      // The same pending write, once a gateway is reachable.
      const back = new UiMetaSync({
        gateway: { request },
        read: () => offline,
        apply: () => {}
      })

      back.markBot('researcher')
      await back.reconcile()

      expect(await metaOf(request, 'researcher')).toMatchObject({ [HERMIE_KEY]: { colour: 'lime' } })
      expect(back.mode).toBe('synced')
      expect(back.pending).toBe(false)
    })
  })

  it('does not let a remote copy overwrite a change made while it was away', async () => {
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.bots.researcher = { v: 1, colour: 'teal' }
      desktop.sync.markBot('researcher')
      await desktop.sync.flush()

      // The phone changed the same bot while it had no socket. Reconcile reads
      // the desktop's value, hands it over — and then sends the phone's, which
      // is still dirty.
      const phone = device({ app: null, bots: { researcher: { v: 1, colour: 'lime' } } })

      phone.sync.markBot('researcher')
      await phone.sync.reconcile()

      expect(await metaOf(request, 'researcher')).toMatchObject({ [HERMIE_KEY]: { colour: 'lime' } })
    })
  })
})

/**
 * One key per person.
 *
 * ADR-0016 ended on an accepted regression: "two people on one gateway now share
 * an arrangement… if the gateway grows [a per-user scope], this is the ADR to
 * supersede." It never grew one. What these cases pin is that the arrangement
 * did not need it — the key is a string this client chooses, so a person's name
 * inside it keeps two readers apart as completely as two scopes would, and the
 * only thing standing between them is that nobody else writes these keys.
 */
describe('one key per person', () => {
  it('keeps two people on one gateway out of the other one’s arrangement', async () => {
    await withGateway(async ({ request, device }) => {
      const alice = device({ app: null, bots: {} }, 'alice')
      const bob = device({ app: null, bots: {} }, 'bob')

      await alice.sync.reconcile()
      alice.local.app = { v: 1, themeChoice: 'midnight', entries: [{ kind: 'chat', name: 'writer' }] }
      alice.sync.markApp()
      await alice.sync.flush()

      await bob.sync.reconcile()

      // The one that matters: Bob read the gateway and found nothing of his
      // own. Before this change he would have been handed Alice's theme.
      expect(bob.local.app).toBeNull()

      bob.local.app = { v: 1, themeChoice: 'sand', entries: [{ kind: 'chat', name: 'researcher' }] }
      bob.sync.markApp()
      await bob.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(meta[appKeyFor('alice')]).toMatchObject({ themeChoice: 'midnight' })
      expect(meta[appKeyFor('bob')]).toMatchObject({ themeChoice: 'sand' })

      // And neither of them wrote over the other, which is what the per-key
      // compare-and-swap is being leaned on for.
      await alice.sync.reconcile()

      expect(alice.local.app).toMatchObject({ themeChoice: 'midnight' })
    })
  })

  it('writes a token gateway under the owner id', async () => {
    // A gateway with no accounts has nobody to name, and `owner` is the fixed id
    // that makes that a hit rather than a coin toss — the same one the context
    // section already uses.
    await withGateway(async ({ request, device }) => {
      const phone = device({ app: null, bots: {} }, 'owner')

      await phone.sync.reconcile()
      phone.local.app = { v: 1, themeChoice: 'midnight' }
      phone.sync.markApp()
      await phone.sync.flush()

      expect(await metaOf(request, 'researcher')).toHaveProperty('hermie-app:owner')
    })
  })

  it('gives a second device of the same person the same arrangement', async () => {
    await withGateway(async ({ device }) => {
      const phone = device({ app: null, bots: {} }, 'alice')

      await phone.sync.reconcile()
      phone.local.app = { v: 1, entries: [{ kind: 'chat', name: 'writer' }], themeChoice: 'midnight' }
      phone.sync.markApp()
      await phone.sync.flush()

      const tablet = device({ app: null, bots: {} }, 'alice')

      await tablet.sync.reconcile()

      expect(tablet.local.app).toMatchObject({
        entries: [{ kind: 'chat', name: 'writer' }],
        themeChoice: 'midnight'
      })
    })
  })

  it('writes no arrangement at all while the gateway has named nobody', async () => {
    // A gated gateway whose identity call was refused. The bot sections still
    // sync — archived and colour are about the bot, not about who is looking —
    // and the arrangement stays on the device, which is where ADR-0012 had it.
    await withGateway(async ({ request, device }) => {
      const phone = device({ app: null, bots: {} }, '')

      await phone.sync.reconcile()
      phone.local.app = { v: 1, themeChoice: 'midnight' }
      phone.local.bots.writer = { v: 1, archived: true }
      phone.sync.markApp()
      phone.sync.markBot('writer')
      await phone.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(Object.keys(meta).filter(key => key.startsWith(HERMIE_APP_KEY))).toEqual([])
      expect(await metaOf(request, 'writer')).toMatchObject({ [HERMIE_KEY]: { archived: true } })
    })
  })
})

/**
 * Whose copy is the newer one.
 *
 * ADR-0016 said "last writer wins, per section", and "last" meant whichever
 * device flushed last. On one device that is the same sentence; on two it is not,
 * and the difference was reported twice in one day: a theme picked on a desktop
 * went back to the phone's the moment the phone was opened, and the folders with
 * it. The losing device then wrote its own copy home, so the choice was gone for
 * every device rather than merely wrong on one.
 *
 * A device holds this section for reasons that are nobody's decision — its own
 * push row, its context facts, a disk read that landed late, the live roster
 * folded into the list — so the dirty bit cannot answer the question. The section
 * therefore says WHEN it was chosen, and these cases are the comparison.
 */
describe('the newest choice, wherever it was made', () => {
  const HOUR = 3600
  const noon = 1_789_950_000

  /** One person's two devices, and the app-wide key they share. */
  const appOf = async (request: UiMetaGateway['request']): Promise<Record<string, unknown>> =>
    (await metaOf(request, 'researcher'))[APP_KEY] as Record<string, unknown>

  it('takes the desktop’s later choice onto the phone, and leaves it there', async () => {
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.app = { v: 1, themeChoice: 'graphite', [APP_UPDATED_AT]: noon }
      desktop.sync.markApp()
      await desktop.sync.flush()

      // The phone chose Lime an hour EARLIER and never sent it.
      const phone = device({ app: { v: 1, themeChoice: 'lime', [APP_UPDATED_AT]: noon - HOUR }, bots: {} })

      phone.sync.markApp()
      await phone.sync.reconcile()

      expect(phone.local.app).toMatchObject({ themeChoice: 'graphite' })
      expect(await appOf(request)).toMatchObject({ themeChoice: 'graphite' })
    })
  })

  it('does the same in the other connect order', async () => {
    await withGateway(async ({ request, device }) => {
      // This time the OLDER choice is the one already on the gateway.
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = { v: 1, themeChoice: 'lime', [APP_UPDATED_AT]: noon - HOUR }
      phone.sync.markApp()
      await phone.sync.flush()

      const desktop = device({ app: { v: 1, themeChoice: 'graphite', [APP_UPDATED_AT]: noon }, bots: {} })

      await desktop.sync.reconcile()

      // Not marked dirty by the caller: the date is what says this device is
      // holding something the gateway has not got, which is the only thing left
      // to go on after the app was relaunched and the dirty bit went with it.
      expect(desktop.local.app).toMatchObject({ themeChoice: 'graphite' })
      expect(await appOf(request)).toMatchObject({ themeChoice: 'graphite' })
    })
  })

  it('gives a tie to the gateway, so that one of the two stops', async () => {
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.app = { v: 1, themeChoice: 'graphite', [APP_UPDATED_AT]: noon }
      desktop.sync.markApp()
      await desktop.sync.flush()

      const phone = device({ app: { v: 1, themeChoice: 'lime', [APP_UPDATED_AT]: noon }, bots: {} })

      phone.sync.markApp()
      await phone.sync.reconcile()

      expect(phone.local.app).toMatchObject({ themeChoice: 'graphite' })
      expect(await appOf(request)).toMatchObject({ themeChoice: 'graphite' })
    })
  })

  it('keeps an undated local change, which is where this started', async () => {
    // Neither side has a date: a build that predates the field, or a device that
    // has never had a choice made on it. The rule is then the one that was there
    // before — a dirty section is the newer one — because that is what makes a
    // change made on a plane survive the landing.
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.app = { v: 1, themeChoice: 'graphite' }
      desktop.sync.markApp()
      await desktop.sync.flush()

      const phone = device({ app: { v: 1, themeChoice: 'lime' }, bots: {} })

      phone.sync.markApp()
      await phone.sync.reconcile()

      expect(phone.local.app).toMatchObject({ themeChoice: 'lime' })
      expect(await appOf(request)).toMatchObject({ themeChoice: 'lime' })
    })
  })

  it('prefers a dated choice to an undated one', async () => {
    await withGateway(async ({ request, device }) => {
      const older = device()

      await older.sync.reconcile()
      older.local.app = { v: 1, themeChoice: 'lime' }
      older.sync.markApp()
      await older.sync.flush()

      const newer = device({ app: { v: 1, themeChoice: 'graphite', [APP_UPDATED_AT]: noon }, bots: {} })

      newer.sync.markApp()
      await newer.sync.reconcile()

      expect(newer.local.app).toMatchObject({ themeChoice: 'graphite' })
      expect(await appOf(request)).toMatchObject({ themeChoice: 'graphite' })
    })
  })

  it('still sends a section to a gateway that has none, whatever the dates say', async () => {
    // An absent key is not a decision anybody made; a present one is. That
    // asymmetry is older than the dates and the dates must not undo it.
    await withGateway(async ({ request, device }) => {
      const phone = device({ app: { v: 1, themeChoice: 'lime', [APP_UPDATED_AT]: noon - HOUR }, bots: {} })

      await phone.sync.reconcile()

      expect(await appOf(request)).toMatchObject({ themeChoice: 'lime' })
    })
  })
})

describe('a gateway whose notifier cannot read the new key yet', () => {
  /**
   * The split write, and why it is not simply "wait for the plugin".
   *
   * The arrangement is read by nothing but this app, so it can move to the
   * per-person key the moment the app ships. The registrations are read by the
   * PLUGIN, and one written where the plugin is not looking is a phone that has
   * silently stopped buzzing — which nobody finds out about except by not being
   * woken up. So the two halves go to two keys until the gateway says otherwise.
   */
  const withoutPerUser = async (run: (harness: Harness) => Promise<void>): Promise<void> => {
    const gateway = await startFakeGateway({
      port: 0,
      plugin: { ...PLUGIN_ADVERT, capabilities: ['push.expo'] }
    })

    try {
      const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })

      const request = callOn(socket)

      try {
        await run({
          request,
          device(initial = { app: null, bots: {} }, userId = OWNER) {
            const local: UiMetaSnapshot = { app: initial.app, bots: { ...initial.bots } }
            const sync = new UiMetaSync({
              gateway: { request },
              read: () => local,
              apply: snapshot => {
                local.app = snapshot.app
                local.bots = { ...snapshot.bots }
              }
            })

            sync.setUser(userId)

            return { sync, local }
          }
        })
      } finally {
        socket.close()
      }
    } finally {
      await gateway.close()
    }
  }

  it('leaves the registrations on the bare key and moves the rest', async () => {
    await withoutPerUser(async ({ request, device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = {
        v: 1,
        themeChoice: 'midnight',
        push: { registrations: { 'i-phone': { v: 1, transport: 'expo', token: 'x' } }, seen: {} }
      }
      phone.sync.markApp()
      await phone.sync.flush()

      const meta = await metaOf(request, 'researcher')

      expect(meta[APP_KEY]).toMatchObject({ themeChoice: 'midnight' })
      expect(meta[APP_KEY]).not.toHaveProperty('push')
      expect(meta[HERMIE_APP_KEY]).toHaveProperty('push')
    })
  })

  it('reads its own registrations back from the bare key', async () => {
    // The other half of the split: a second device of the same person has to
    // find the first one's row, or it will write a section without it.
    await withoutPerUser(async ({ device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = {
        v: 1,
        push: { registrations: { 'i-phone': { v: 1, transport: 'expo', token: 'x' } }, seen: {} }
      }
      phone.sync.markApp()
      await phone.sync.flush()

      const tablet = device()
      const seenByTablet = await tablet.sync.pull()

      expect(seenByTablet?.pushHome).toHaveProperty('push')
      // And the per-person key it found there carries none, so a reader that
      // took the neighbours out of `app` would have found nobody.
      expect(seenByTablet?.app).not.toHaveProperty('push')
    })
  })

  it('sends both keys in one request, because their sections are independent', async () => {
    await withoutPerUser(async ({ device }) => {
      const phone = device()

      await phone.sync.reconcile()
      phone.local.app = { v: 1, themeChoice: 'sand', push: { registrations: {}, seen: {} } }
      phone.sync.markApp()
      await phone.sync.flush()

      expect(phone.sync.pending).toBe(false)
      expect(phone.sync.mode).toBe('synced')
    })
  })
})

describe('inheriting the anonymous arrangement', () => {
  /** The legacy section, as a build before this change left it behind. */
  const seedLegacy = async (request: UiMetaGateway['request']): Promise<void> => {
    await request('profiles.configure', {
      name: 'researcher',
      ui_meta: {
        [HERMIE_APP_KEY]: {
          v: 1,
          themeChoice: 'midnight',
          entries: [{ kind: 'chat', name: 'writer' }],
          push: { registrations: { 'install-a': { v: 1, transport: 'expo', token: 'x' } } },
          context: { users: { someone: { userId: 'someone' } } }
        }
      }
    })
  }

  it('copies the arrangement into the new key on the first reconcile', async () => {
    await withGateway(async ({ request, device }) => {
      await seedLegacy(request)

      const phone = device({ app: null, bots: {} }, 'alice')

      await phone.sync.reconcile()

      // Into the stores...
      expect(phone.local.app).toMatchObject({
        themeChoice: 'midnight',
        entries: [{ kind: 'chat', name: 'writer' }]
      })

      // ...and back out under her name, in the same reconcile.
      expect(await metaOf(request, 'researcher')).toHaveProperty(appKeyFor('alice'))
    })
  })

  it('leaves the per-device and per-person maps behind', async () => {
    // The whole reason the copy is filtered. On a shared gateway the legacy key
    // holds everybody's push rows mixed together, and copying them into each
    // person's key would put one phone in two sections — which a notifier
    // reading both would send to twice.
    await withGateway(async ({ request, device }) => {
      await seedLegacy(request)

      const phone = device({ app: null, bots: {} }, 'alice')

      await phone.sync.reconcile()

      expect(phone.local.app).not.toHaveProperty('push')
      expect(phone.local.app).not.toHaveProperty('context')

      const inherited = (await metaOf(request, 'researcher'))[appKeyFor('alice')] as Record<string, unknown>

      expect(inherited).not.toHaveProperty('push')
      expect(inherited).not.toHaveProperty('context')
    })
  })

  it('copies once, and never looks at the legacy key again', async () => {
    await withGateway(async ({ request, device }) => {
      await seedLegacy(request)

      const phone = device({ app: null, bots: {} }, 'alice')

      await phone.sync.reconcile()

      // She rearranges, and the anonymous section changes underneath her — an
      // older build on somebody's other device, still writing the bare key.
      phone.local.app = { v: 1, themeChoice: 'sand' }
      phone.sync.markApp()
      await phone.sync.flush()

      await request('profiles.configure', {
        name: 'researcher',
        ui_meta: { [HERMIE_APP_KEY]: { v: 1, themeChoice: 'forest' } }
      })

      await phone.sync.reconcile()

      // Hers, not the anonymous one's. A second inheritance would have put
      // `forest` back over the top of a choice she had already made.
      expect(phone.local.app).toMatchObject({ themeChoice: 'sand' })
    })
  })

  it('starts a person who arrives after the copy from the app defaults', async () => {
    await withGateway(async ({ device }) => {
      const alice = device({ app: null, bots: {} }, 'alice')

      await alice.sync.reconcile()
      alice.local.app = { v: 1, themeChoice: 'midnight' }
      alice.sync.markApp()
      await alice.sync.flush()

      // No legacy key was ever written here, so there is nothing to inherit and
      // Bob must not be handed the arrangement of whoever got here first.
      const bob = device({ app: null, bots: {} }, 'bob')

      await bob.sync.reconcile()

      expect(bob.local.app).toBeNull()
    })
  })

  it('leaves the anonymous section exactly where it was', async () => {
    await withGateway(async ({ request, device }) => {
      await seedLegacy(request)

      const phone = device({ app: null, bots: {} }, 'alice')

      await phone.sync.reconcile()
      phone.local.app = { v: 1, themeChoice: 'sand' }
      phone.sync.markApp()
      await phone.sync.flush()

      // Still there, still saying what it said. An older build on another
      // device goes on reading it.
      expect((await metaOf(request, 'researcher'))[HERMIE_APP_KEY]).toMatchObject({ themeChoice: 'midnight' })
    })
  })
})

/**
 * An edit made while a write is out.
 *
 * The write carries the bytes `read()` gave it at the moment it left. A landed
 * write used to clean the section whatever happened meanwhile, so an edit made
 * during its flight was dropped from the pending set and reverted on the next
 * reconcile. Now a write cleans only what it carried (the Swift app's marks), and
 * the flush goes round again for what it did not.
 */
describe('an edit made while a write is out', () => {
  /** A gateway that runs `during` once, while the first `profiles.configure` is in flight. */
  const midFlight = (request: UiMetaGateway['request'], during: () => void): UiMetaGateway['request'] => {
    let done = false

    return async (method, params) => {
      const answer = request(method, params)

      if (method === 'profiles.configure' && !done) {
        done = true
        during()
      }

      return answer
    }
  }

  it('is sent by a further round for a bot section', async () => {
    await withGateway(async ({ request }) => {
      const local: UiMetaSnapshot = { app: null, bots: {} }
      const sync: UiMetaSync = new UiMetaSync({
        gateway: {
          request: midFlight(request, () => {
            local.bots.researcher = { v: 1, archived: true, colour: 'teal' }
            sync.markBot('researcher')
          })
        },
        read: () => local,
        apply: snapshot => {
          local.app = snapshot.app
          local.bots = { ...snapshot.bots }
        }
      })

      sync.setUser(OWNER)
      await sync.reconcile()

      local.bots.researcher = { v: 1, archived: true }
      sync.markBot('researcher')
      await sync.flush()

      expect((await metaOf(request, 'researcher'))[HERMIE_KEY]).toEqual({ v: 1, archived: true, colour: 'teal' })
      expect(sync.pending).toBe(false)

      // And the next reconcile keeps it, rather than taking the first write back.
      await sync.reconcile()
      expect(local.bots.researcher).toEqual({ v: 1, archived: true, colour: 'teal' })
    })
  })

  it('is sent by a further round for the app section', async () => {
    await withGateway(async ({ request }) => {
      const local: UiMetaSnapshot = { app: null, bots: {} }
      const sync: UiMetaSync = new UiMetaSync({
        gateway: {
          request: midFlight(request, () => {
            local.app = { v: 1, order: ['writer', 'researcher'], [APP_UPDATED_AT]: 20 }
            sync.markApp()
          })
        },
        read: () => local,
        apply: snapshot => {
          local.app = snapshot.app
          local.bots = { ...snapshot.bots }
        }
      })

      sync.setUser(OWNER)
      await sync.reconcile()

      local.app = { v: 1, order: ['writer'], [APP_UPDATED_AT]: 10 }
      sync.markApp()
      await sync.flush()

      expect((await metaOf(request, 'researcher'))[APP_KEY]).toMatchObject({ order: ['writer', 'researcher'] })
      expect(sync.pending).toBe(false)
    })
  })
})

/**
 * A chore never wins over data.
 *
 * Housekeeping nobody decided (a roster folded into the list, a lapsed mute
 * swept) is marked as a chore. An undated chore against an undated section used
 * to keep the local copy, by the offline rule, and a flat list folded on a fresh
 * device replaced the person's folders. A chore now loses to any section the
 * gateway holds and is dropped, and still seeds a gateway that has none.
 */
describe('a chore against the gateway’s copy', () => {
  it('loses to an undated section, and is not sent', async () => {
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.app = { v: 1, folders: ['Finance'] }
      desktop.sync.markApp()
      await desktop.sync.flush()

      const before = await metaOf(request, 'researcher')
      const phone = device({ app: { v: 1, order: ['writer', 'researcher'] }, bots: {} })

      phone.sync.markApp('chore')
      await phone.sync.reconcile()

      expect(phone.local.app).toMatchObject({ folders: ['Finance'] })
      expect(phone.local.app).not.toHaveProperty('order')
      expect(phone.sync.pending).toBe(false)
      expect(await metaOf(request, 'researcher')).toEqual(before)
    })
  })

  it('loses to the anonymous section on the inheritance pull too', async () => {
    await withGateway(async ({ request, device }) => {
      await request('profiles.configure', {
        name: 'researcher',
        ui_meta: { [HERMIE_APP_KEY]: { v: 1, folders: ['Finance'] } }
      })

      const phone = device({ app: { v: 1, order: ['writer'] }, bots: {} })

      phone.sync.markApp('chore')
      await phone.sync.reconcile()

      expect((await metaOf(request, 'researcher'))[APP_KEY]).toMatchObject({ folders: ['Finance'] })
      expect((await metaOf(request, 'researcher'))[APP_KEY]).not.toHaveProperty('order')
    })
  })

  it('still seeds a gateway that has no section', async () => {
    await withGateway(async ({ request, device }) => {
      const phone = device({ app: { v: 1, order: ['writer'] }, bots: {} })

      phone.sync.markApp('chore')
      await phone.sync.reconcile()

      expect((await metaOf(request, 'researcher'))[APP_KEY]).toMatchObject({ order: ['writer'] })
    })
  })

  it('wins beside a choice, by the choice’s date', async () => {
    await withGateway(async ({ request, device }) => {
      const desktop = device()

      await desktop.sync.reconcile()
      desktop.local.app = { v: 1, folders: ['Finance'], [APP_UPDATED_AT]: 10 }
      desktop.sync.markApp()
      await desktop.sync.flush()

      const phone = device({ app: { v: 1, folders: ['Travel'], [APP_UPDATED_AT]: 20 }, bots: {} })

      phone.sync.markApp('chore')
      phone.sync.markApp()
      await phone.sync.reconcile()

      expect((await metaOf(request, 'researcher'))[APP_KEY]).toMatchObject({ folders: ['Travel'] })
    })
  })
})
