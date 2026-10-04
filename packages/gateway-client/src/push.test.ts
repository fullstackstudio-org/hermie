/**
 * ADR-0017's registration, as bytes.
 *
 * Three things are worth pinning here and they are all about a section that
 * belongs to more than one device:
 *
 *  - the ROW: the notifier's reader (the plugin's, and before it Hermie Web's
 *    daemon, since removed) drops an entry that
 *    carries the fields of both transports, so a writer that emits both is
 *    writing an entry nobody will ever send to. The expectations below are
 *    written against that reader's rules rather than against this module's own
 *    types, which is the only way the two stay in step across two packages.
 *  - the NEIGHBOURS: ADR-0016 replaces a key whole, so every case here checks
 *    what happens to rows this device did not write.
 *  - the ABSENCE: turning notifications off has to REMOVE the row, not write an
 *    empty one, because an empty one is still a registration to the reader.
 */
import { describe, expect, it } from 'vitest'

import {
  adoptedPushTypes,
  effectivePushTypes,
  foreignPushRows,
  noPushTypes,
  PUSH_SEEN_TTL_SECONDS,
  PUSH_TYPES,
  pushRowFor,
  pushSectionFor,
  pushSeenOf,
  pushStampOf,
  pushTypesOf,
  type PushRegistrationInput
} from './push'

const NOW = 1_789_957_143

const registration = (patch: Partial<PushRegistrationInput> = {}): PushRegistrationInput => ({
  installationId: 'i-phone',
  address: { transport: 'expo', token: 'ExponentPushToken[abc]' },
  platform: 'ios',
  types: { ...noPushTypes(), message: true, request: true },
  preview: false,
  updatedAt: NOW,
  ...patch
})

/** The daemon's reader, restated: what it will and will not accept as a row. */
function readable(row: Record<string, unknown>): boolean {
  if (row.v !== 1) {
    return false
  }

  if (row.transport === 'expo') {
    return typeof row.token === 'string' && Boolean(row.token) && row.endpoint === undefined
  }

  if (row.transport === 'webpush') {
    const keys = row.keys as { p256dh?: unknown; auth?: unknown } | undefined

    return (
      typeof row.endpoint === 'string' &&
      Boolean(row.endpoint) &&
      typeof keys?.p256dh === 'string' &&
      typeof keys?.auth === 'string' &&
      row.token === undefined
    )
  }

  return false
}

describe('one row', () => {
  it('writes an expo entry with a token and no endpoint', () => {
    const row = pushRowFor(registration())

    expect(row).toEqual({
      v: 1,
      transport: 'expo',
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
      types: {
        message: true,
        request: true,
        cron: false,
        cron_done: false,
        cron_failed: false,
        turn_done: false,
        turn_failed: false
      },
      preview: false,
      updatedAt: NOW
    })
    expect(readable(row)).toBe(true)
  })

  it('writes a webpush entry with an endpoint and both keys, and no token', () => {
    const row = pushRowFor(
      registration({
        installationId: 'i-browser',
        platform: 'web',
        address: { transport: 'webpush', endpoint: 'https://push.example/x', keys: { p256dh: 'pp', auth: 'aa' } }
      })
    )

    expect(row.token).toBeUndefined()
    expect(row.endpoint).toBe('https://push.example/x')
    expect(row.keys).toEqual({ p256dh: 'pp', auth: 'aa' })
    expect(readable(row)).toBe(true)
  })

  it('copies the types rather than aliasing the caller’s object', () => {
    const types = { ...noPushTypes(), message: true }
    const row = pushRowFor(registration({ types })) as { types: Record<string, boolean> }

    types.message = false

    expect(row.types.message).toBe(true)
  })
})

describe('the projection', () => {
  it('carries rows this device did not write, unread', () => {
    // A row from a build that does not exist yet. It is carried because of WHO
    // wrote it, not because this build can read it: dropping it would turn a
    // version skew into another person's phone going quiet.
    const remote = { 'i-tablet': { v: 99, transport: 'martian', token: 'x' } }

    const section = pushSectionFor({ others: remote, own: registration(), seen: {}, now: NOW })

    expect(Object.keys(section?.registrations ?? {}).sort()).toEqual(['i-phone', 'i-tablet'])
    expect(section?.registrations['i-tablet']).toBe(remote['i-tablet'])
  })

  it('replaces this device’s own row rather than adding a second', () => {
    const section = pushSectionFor({
      others: {},
      own: registration({ address: { transport: 'expo', token: 'ExponentPushToken[new]' } }),
      seen: {},
      now: NOW
    })

    expect(section?.registrations['i-phone']).toMatchObject({ token: 'ExponentPushToken[new]' })
  })

  it('keeps the neighbours when this device turns notifications off', () => {
    const section = pushSectionFor({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 't' } },
      own: null,
      seen: { 'i-tablet': { bot: 'writer', at: NOW } },
      now: NOW
    })

    expect(section?.registrations).toEqual({ 'i-tablet': { v: 1, transport: 'expo', token: 't' } })
    expect(section?.registrations['i-phone']).toBeUndefined()
  })

  it('answers nothing at all when the last device leaves', () => {
    // `undefined`, not `{registrations:{},seen:{}}`: the caller omits the key,
    // so a profile belonging to somebody who never turned this on carries no
    // `push` at all.
    expect(pushSectionFor({ others: {}, own: null, seen: {}, now: NOW })).toBeUndefined()
  })

  it('treats a registration that wants no type as no registration', () => {
    const section = pushSectionFor({ others: {}, own: registration({ types: noPushTypes() }), seen: {}, now: NOW })

    expect(section).toBeUndefined()
  })

  it('sweeps a heartbeat older than its TTL and keeps a fresh one', () => {
    const section = pushSectionFor({
      others: { 'i-tablet': { v: 1, transport: 'expo', token: 't' } },
      own: null,
      seen: {
        'i-gone': { bot: 'writer', at: NOW - PUSH_SEEN_TTL_SECONDS - 1 },
        'i-tablet': { bot: 'writer', at: NOW - 30 }
      },
      now: NOW
    })

    expect(section?.seen).toEqual({ 'i-tablet': NOW - 30 })
  })

  it('keeps a stamp from the future, because that is a wrong clock and not a dead device', () => {
    const section = pushSectionFor({
      others: {},
      own: registration(),
      seen: { 'i-phone': { bot: 'writer', at: NOW + 5_000 } },
      now: NOW
    })

    expect(section?.seen['i-phone']).toBe(NOW + 5_000)
  })
})

describe('reading a section back', () => {
  const section = {
    push: {
      registrations: {
        'i-phone': { v: 1, transport: 'expo', token: 'mine' },
        'i-tablet': { v: 1, transport: 'expo', token: 'theirs' }
      },
      seen: { 'i-phone': 10, 'i-tablet': 20, 'i-broken': 'soon', 'i-zero': 0 }
    }
  }

  it('hands back everyone else’s rows and never our own', () => {
    expect(foreignPushRows(section, 'i-phone')).toEqual({ 'i-tablet': { v: 1, transport: 'expo', token: 'theirs' } })
  })

  it('answers nothing for a bag with no push in it', () => {
    expect(foreignPushRows({ v: 1 }, 'i-phone')).toEqual({})
    expect(foreignPushRows(null, 'i-phone')).toEqual({})
    expect(pushSeenOf(undefined)).toEqual({})
  })

  it('drops a stamp that is not a positive number', () => {
    // A bare number is what every build before `push.seen.per_chat` wrote, and
    // it normalises to an entry with no chat name — which is precisely as much
    // as it ever said.
    expect(pushSeenOf(section)).toEqual({ 'i-phone': { bot: '', at: 10 }, 'i-tablet': { bot: '', at: 20 } })
  })

  it('reads the chat name where a newer build said one', () => {
    expect(
      pushSeenOf({
        push: {
          seen: {
            'i-phone': { bot: 'researcher', at: 40 },
            'i-old': 12,
            'i-broken': { bot: 'writer' },
            'i-zero': { bot: 'writer', at: 0 },
            'i-unnamed': { at: 7 }
          }
        }
      })
    ).toEqual({
      'i-phone': { bot: 'researcher', at: 40 },
      'i-old': { bot: '', at: 12 },
      'i-unnamed': { bot: '', at: 7 }
    })
  })
})

describe('the seven types', () => {
  it('names every event the notifier can raise, in the order the switches are drawn', () => {
    // Pinned rather than counted: this array is the wire's list AND the running
    // order of Settings → Notifications, so a reordering is a visible change
    // and a silent removal is a device that stops asking about something.
    expect([...PUSH_TYPES]).toEqual([
      'message',
      'request',
      'cron',
      'cron_done',
      'cron_failed',
      'turn_done',
      'turn_failed'
    ])
  })

  it('folds a per-chat override over all seven, and leaves the rest following the global', () => {
    const global = { ...noPushTypes(), cron: true, cron_done: true, cron_failed: true }

    expect(effectivePushTypes(global, { cron_done: false })).toEqual({
      ...global,
      cron_done: false
    })
  })

  it('lets a chat keep the failures and lose the chatter, which is why the two are separate', () => {
    const global = { ...noPushTypes(), cron: true, cron_done: true, cron_failed: true }
    const quiet = effectivePushTypes(global, { cron: false, cron_done: false })

    expect(quiet.cron).toBe(false)
    expect(quiet.cron_done).toBe(false)
    expect(quiet.cron_failed).toBe(true)
  })
})

describe('a device that upgrades into a new type', () => {
  const defaults = { ...noPushTypes(), message: true, cron: true, cron_done: true, cron_failed: true }

  it('takes the default for a type it was never offered a switch for', () => {
    // The bag on disk predates `cron_done` and `cron_failed`. Read by the
    // WIRE's rule they would be off, and the owner's phone would silently never
    // mention the routine that stopped running — with both switches looking on.
    const stored = { message: true, request: true, cron: true, turn_done: true, turn_failed: true }

    expect(adoptedPushTypes(stored, defaults)).toMatchObject({ cron_done: true, cron_failed: true })
  })

  it('never re-opens a type the reader switched off', () => {
    expect(adoptedPushTypes({ cron: false }, defaults).cron).toBe(false)
  })

  it('leaves the wire’s rule alone, where an absent type means off', () => {
    // The two functions differ on purpose and this is the difference: a
    // registration that does not name a type never agreed to it.
    expect(pushTypesOf({ message: true }).cron_done).toBe(false)
  })

  it('reads nothing at all as the defaults, which is what a fresh install gets', () => {
    expect(adoptedPushTypes(null, defaults)).toEqual(defaults)
    expect(adoptedPushTypes('nonsense', defaults)).toEqual(defaults)
  })
})

describe('the small pieces', () => {
  it('reads absent as off, exactly as the daemon does', () => {
    expect(pushTypesOf({ message: true, request: 'yes' })).toEqual({ ...noPushTypes(), message: true })
    expect(pushTypesOf(null)).toEqual(noPushTypes())
  })

  it('drops a `dm` an older build of this app wrote, rather than carrying it', () => {
    // The plugin cannot produce one — there is no hook — so a switch for it
    // would be a switch that never does anything. The removed Hermie Web daemon
    // could still send one; this is only about what the app offers.
    expect(pushTypesOf({ message: true, dm: true })).not.toHaveProperty('dm')
  })

  it('stamps in seconds, because that is what the daemon compares against', () => {
    expect(pushStampOf(1_789_957_143_987)).toBe(1_789_957_143)
  })
})
