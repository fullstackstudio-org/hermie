/**
 * Silencing one chat.
 *
 * A mute is a DEADLINE rather than a flag, and almost every case here is about
 * that one choice: nothing fires, nothing has to be running, and a phone that
 * was in a drawer for two days comes back to exactly the state the arithmetic
 * says it should be in.
 *
 * The other half is what "silent" is allowed to mean. Mute stops the buzzing
 * and the totals; it does not stop the row saying that four things arrived. The
 * cases at the bottom pin that line, because it is the one a future change will
 * be tempted to cross in either direction.
 */
import { projectWidgetSnapshot, type WidgetSnapshotInput } from '../src/features/widgets/snapshot'
import { parseRowMenuAction, rowMenuItems, type RowMenuModel } from '../src/features/bots/row-menu-items'
import {
  formatMuteUntil,
  isMuted,
  MUTE_FOREVER,
  muteUntil,
  mutedUntil,
  mutesOf,
  withoutExpired
} from '../src/store/mute'
import { menuLeaves } from '../src/ui/menu'
import { strings } from '../src/i18n/strings'
import type { Bot } from '../src/store/bots'

/** A Wednesday at 10:00 local time, so the day-boundary cases are readable. */
const NOON = Math.floor(new Date(2026, 8, 23, 10, 0, 0).getTime() / 1000)

const HOUR = 60 * 60

describe('a mute as a deadline', () => {
  it('turns each offered span into the second it lapses', () => {
    expect(muteUntil('1h', NOON)).toBe(NOON + HOUR)
    expect(muteUntil('8h', NOON)).toBe(NOON + 8 * HOUR)
    expect(muteUntil('1w', NOON)).toBe(NOON + 7 * 24 * HOUR)
  })

  it('stores forever as a deadline that never comes', () => {
    expect(muteUntil('forever', NOON)).toBe(MUTE_FOREVER)
    expect(isMuted({ writer: MUTE_FOREVER }, 'writer', NOON + 10 * 365 * 24 * HOUR)).toBe(true)
  })

  it('reads a deadline in the past as unmuted without anybody sweeping it', () => {
    // The property the whole design rests on. Nothing fires when a mute lapses,
    // so a phone that was asleep for two days must come back unmuted purely by
    // comparing two numbers.
    const mutes = { writer: NOON + HOUR }

    expect(isMuted(mutes, 'writer', NOON)).toBe(true)
    expect(isMuted(mutes, 'writer', NOON + HOUR - 1)).toBe(true)
    expect(isMuted(mutes, 'writer', NOON + HOUR)).toBe(false)
    expect(isMuted(mutes, 'writer', NOON + 2 * 24 * HOUR)).toBe(false)
  })

  it('says a chat nobody muted is not muted', () => {
    expect(isMuted({}, 'writer', NOON)).toBe(false)
    expect(mutedUntil({}, 'writer', NOON)).toBeNull()
  })

  it('hands back the deadline only while it still stands', () => {
    expect(mutedUntil({ writer: NOON + HOUR }, 'writer', NOON)).toBe(NOON + HOUR)
    expect(mutedUntil({ writer: NOON + HOUR }, 'writer', NOON + 2 * HOUR)).toBeNull()
    expect(mutedUntil({ writer: MUTE_FOREVER }, 'writer', NOON)).toBe(MUTE_FOREVER)
  })
})

describe('sweeping the ones that lapsed', () => {
  it('drops the expired and keeps the rest', () => {
    const swept = withoutExpired({ writer: NOON - HOUR, researcher: NOON + HOUR, notes: MUTE_FOREVER }, NOON)

    expect(swept).toEqual({ researcher: NOON + HOUR, notes: MUTE_FOREVER })
  })

  it('answers null when nothing had lapsed', () => {
    // Not an equal copy. The sweep runs on every foreground and the map is part
    // of the `ui_meta` projection, so a fresh object each time would send the
    // whole arrangement to the gateway for nothing.
    expect(withoutExpired({ researcher: NOON + HOUR }, NOON)).toBeNull()
    expect(withoutExpired({}, NOON)).toBeNull()
  })
})

describe('reading a map another build wrote', () => {
  it('keeps the deadlines and drops everything else', () => {
    expect(mutesOf({ writer: NOON, notes: MUTE_FOREVER, a: 'soon', b: null, c: Number.NaN, d: -1, '': 5 })).toEqual({
      writer: NOON,
      notes: MUTE_FOREVER
    })
  })

  it('answers empty for anything that is not a map at all', () => {
    expect(mutesOf(undefined)).toEqual({})
    expect(mutesOf(null)).toEqual({})
    expect(mutesOf([1, 2])).toEqual({})
    expect(mutesOf('muted')).toEqual({})
  })
})

describe('saying when it comes back', () => {
  const weekdays = strings.layout.muteWeekdays

  it('says the clock alone for a deadline later today', () => {
    expect(formatMuteUntil(muteUntil('1h', NOON), NOON, weekdays)).toBe('11:00')
  })

  it('carries the day for a deadline that is not today', () => {
    // The case a bare clock would lie about: "Muted until 10:00" on a Wednesday,
    // meaning next Wednesday.
    expect(formatMuteUntil(muteUntil('1w', NOON), NOON, weekdays)).toBe('Wed 10:00')
    expect(formatMuteUntil(muteUntil('8h', NOON + 10 * HOUR), NOON, weekdays)).toBe('Thu 04:00')
  })
})

describe('the row menu', () => {
  const model: RowMenuModel = {
    accent: 'teal',
    archived: false,
    botName: 'writer',
    displayName: 'Writer',
    now: NOON,
    folders: [],
    unread: false
  }

  const idsOf = (over: Partial<RowMenuModel>): string[] =>
    menuLeaves(rowMenuItems({ ...model, ...over })).map(item => item.id)

  it('offers the four spans while the chat is not muted', () => {
    expect(idsOf({})).toEqual(expect.arrayContaining(['mute:1h', 'mute:8h', 'mute:1w', 'mute:forever']))
    expect(idsOf({})).not.toContain('unmute')
  })

  it('offers Unmute instead once it is', () => {
    const ids = idsOf({ mutedUntil: NOON + HOUR })

    expect(ids).toContain('unmute')
    expect(ids).not.toContain('mute:1h')
  })

  it('says when the silence lapses, above Unmute', () => {
    const items = rowMenuItems({ ...model, mutedUntil: NOON + HOUR })
    const state = items.find(item => item.id === 'mutedState')

    expect(state?.title).toBe('Muted until 11:00')
    // A caption, not an action: UIKit greys it and never fires it.
    expect(state?.disabled).toBe(true)
  })

  it('says only Muted for a chat silenced with no end', () => {
    const items = rowMenuItems({ ...model, mutedUntil: MUTE_FOREVER })

    expect(items.find(item => item.id === 'mutedState')?.title).toBe('Muted')
  })

  it('reads each span back as the duration it was built to mean', () => {
    expect(parseRowMenuAction('mute:8h')).toEqual({ kind: 'mute', duration: '8h' })
    expect(parseRowMenuAction('unmute')).toEqual({ kind: 'unmute' })
  })

  it('refuses a span this build does not offer', () => {
    // An id is a string on the wire between UIKit and JavaScript, and a menu
    // built by a newer binary could carry anything.
    expect(parseRowMenuAction('mute:1y')).toBeNull()
    expect(parseRowMenuAction('mute')).toBeNull()
  })
})

describe('what the widgets count', () => {
  const bot = (name: string): Bot =>
    ({
      name,
      displayName: name,
      canonical: { id: `s-${name}`, lastActive: NOON, preview: 'hello' }
    }) as unknown as Bot

  const input = (mutes: Record<string, number>): WidgetSnapshotInput => ({
    bots: [bot('writer'), bot('researcher')],
    nameOrder: 'profile',
    chats: {},
    running: {},
    lastSeen: {},
    accents: {},
    labels: {},
    archived: {},
    folders: [],
    mutes,
    gatewayReady: true,
    avatars: {},
    now: NOON * 1000
  })

  it('keeps a muted bot’s row, because mute is not archiving', () => {
    const snapshot = projectWidgetSnapshot(input({ writer: MUTE_FOREVER }))

    expect(snapshot.bots.map(entry => entry.name).sort()).toEqual(['researcher', 'writer'])
  })

  it('zeroes its numbers, because a widget is where a count is loudest', () => {
    const snapshot = projectWidgetSnapshot(input({ writer: MUTE_FOREVER }))
    const writer = snapshot.bots.find(entry => entry.name === 'writer')

    expect(writer?.unread).toBe(0)
    expect(writer?.needsInput).toBe(false)
  })

  it('counts it again once the deadline has passed', () => {
    const snapshot = projectWidgetSnapshot({ ...input({ writer: NOON - 1 }), now: NOON * 1000 })

    expect(snapshot.bots.find(entry => entry.name === 'writer')?.needsInput).toBe(false)
    // Nothing is open in this fixture, so the assertion that matters is that the
    // muted branch did not run: the bot is projected exactly as an unmuted one.
    expect(projectWidgetSnapshot(input({}))).toEqual(snapshot)
  })
})
