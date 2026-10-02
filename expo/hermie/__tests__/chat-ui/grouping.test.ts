/**
 * Grouping, tails and date stamps — the three whole-list facts a row cannot work
 * out for itself.
 *
 * The one that matters most: the tail is drawn ONLY on the last bubble of a run.
 * The previous build drew it on every bubble, which is what put a protruding
 * square on the corner of each one.
 */
import { dateStampFor, GROUP_WINDOW_SECONDS, layoutRows, speakerKey } from '../../src/chat-ui'
import type { TranscriptItem, VisibleItem } from '../../src/chat-ui/types'

const AT = 1_767_000_000

function user(id: string, ts: number, extra: Partial<TranscriptItem> = {}): VisibleItem {
  return {
    item: { id, kind: 'user', origin: 'history', seq: ts, text: id, ts, version: 0, ...extra } as TranscriptItem,
    presentation: 'full'
  }
}

function assistant(id: string, ts: number): VisibleItem {
  return {
    item: {
      id,
      interim: false,
      kind: 'assistant',
      origin: 'history',
      seq: ts,
      status: 'complete',
      streaming: false,
      text: id,
      ts,
      version: 0
    } as TranscriptItem,
    presentation: 'full'
  }
}

function tool(id: string, ts: number): VisibleItem {
  return {
    item: {
      id,
      kind: 'tool',
      name: 'terminal',
      origin: 'history',
      resultKnown: false,
      seq: ts,
      status: 'complete',
      toolId: id,
      ts,
      version: 0
    } as TranscriptItem,
    presentation: 'collapsed'
  }
}

describe('speakerKey', () => {
  it('keeps a turn of unknown authorship out of the owner’s own run', () => {
    expect(speakerKey(user('a', AT).item)).toBe('own')
    expect(speakerKey(user('b', AT, { unknownAuthor: true }).item)).toBe('foreign')
  })

  // HERM-83, D6: `ownAuthorId` is the whole of the attribution gate. Nothing
  // about an `author` matters unless a caller passes it — a personal
  // sub-chat, a branch and a retired conversation never do.
  it('ignores an attributed author entirely when no own id is given', () => {
    const authored = user('a', AT, { author: { id: 'authentik:someone-else' } }).item

    expect(speakerKey(authored)).toBe('own')
  })

  it('keys the reader’s own attributed row as own', () => {
    const mine = user('a', AT, { author: { id: 'authentik:me' } }).item

    expect(speakerKey(mine, 'authentik:me')).toBe('own')
  })

  it('keys a colleague’s attributed row by their identity, not their name', () => {
    const theirs = user('a', AT, { author: { id: 'authentik:writer', name: 'Robin' } }).item

    expect(speakerKey(theirs, 'authentik:me')).toBe('user:authentik:writer')
  })

  it('gives two different colleagues two different keys', () => {
    const first = user('a', AT, { author: { id: 'authentik:writer' } }).item
    const second = user('b', AT, { author: { id: 'authentik:researcher' } }).item

    expect(speakerKey(first, 'authentik:me')).not.toBe(speakerKey(second, 'authentik:me'))
  })

  it('keeps the unknown-author placeholder its own key even with an own id given', () => {
    const placeholder = user('a', AT, { unknownAuthor: true }).item

    expect(speakerKey(placeholder, 'authentik:me')).toBe('foreign')
  })

  it('separates an interim note from the answer', () => {
    const answer = assistant('a', AT).item
    const note = { ...answer, id: 'b', interim: true } as TranscriptItem

    expect(speakerKey(answer)).not.toBe(speakerKey(note))
  })

  it('gives anything that is not speech no key at all', () => {
    expect(speakerKey(tool('t', AT).item)).toBeNull()
  })
})

describe('layoutRows', () => {
  it('tails only the LAST bubble of a run', () => {
    const layout = layoutRows([user('a', AT), user('b', AT + 5), user('c', AT + 10)])

    expect(layout.a?.tail).toBe(false)
    expect(layout.b?.tail).toBe(false)
    expect(layout.c?.tail).toBe(true)
  })

  it('groups every bubble after the first of a run', () => {
    const layout = layoutRows([user('a', AT), user('b', AT + 5), user('c', AT + 10)])

    expect(layout.a?.grouped).toBe(false)
    expect(layout.b?.grouped).toBe(true)
    expect(layout.c?.grouped).toBe(true)
  })

  it('tails a lone bubble', () => {
    const layout = layoutRows([user('a', AT)])

    expect(layout.a).toMatchObject({ grouped: false, tail: true })
  })

  it('ends a run when the speaker changes', () => {
    const layout = layoutRows([user('a', AT), assistant('b', AT + 2), user('c', AT + 4)])

    expect(layout.a?.tail).toBe(true)
    expect(layout.b?.tail).toBe(true)
    expect(layout.c?.tail).toBe(true)
    expect(layout.c?.grouped).toBe(false)
  })

  // A tool row between two replies is visible, so the replies are not adjacent on
  // screen and drawing the second as a continuation of the first would misreport
  // the order things happened in.
  it('ends a run at anything that is not speech', () => {
    const layout = layoutRows([assistant('a', AT), tool('t', AT + 1), assistant('b', AT + 2)])

    expect(layout.a?.tail).toBe(true)
    expect(layout.b?.grouped).toBe(false)
  })

  it('ends a run when the two turns are far apart in time', () => {
    const layout = layoutRows([user('a', AT), user('b', AT + GROUP_WINDOW_SECONDS + 1)])

    expect(layout.a?.tail).toBe(true)
    expect(layout.b?.grouped).toBe(false)
  })

  // Turning Quiet on must not visibly re-group the conversation: a hidden row is
  // not on screen, so it cannot separate two bubbles.
  it('looks through a hidden row', () => {
    const hidden = { ...tool('t', AT + 1), presentation: 'hidden-placeholder' as const }
    const layout = layoutRows([user('a', AT), hidden, user('b', AT + 2)])

    expect(layout.b?.grouped).toBe(true)
    expect(layout.a?.tail).toBe(false)
  })

  it('groups rows with no timestamps at all rather than never grouping them', () => {
    const noStamp = (id: string): VisibleItem => ({
      item: { id, kind: 'user', origin: 'history', seq: 0, text: id, version: 0 } as TranscriptItem,
      presentation: 'full'
    })
    const layout = layoutRows([noStamp('a'), noStamp('b')])

    expect(layout.b?.grouped).toBe(true)
  })

  it('stamps the first row of each day and no other', () => {
    const day = 86_400
    const layout = layoutRows([user('a', AT - day), user('b', AT - day + 5), user('c', AT)], AT)

    expect(layout.a?.dateStamp).toBeTruthy()
    expect(layout.b?.dateStamp).toBeUndefined()
    expect(layout.c?.dateStamp).toBeTruthy()
    expect(layout.a?.dateStamp).not.toBe(layout.c?.dateStamp)
  })

  /**
   * The owner's `TODAY … YESTERDAY … TODAY` report, reproduced from the list's
   * side so the blame lands where it belongs.
   *
   * A stamp marks a change of day between NEIGHBOURS, which is the only thing a
   * single pass over a list can honestly say. Hand it an order that goes
   * forwards, backwards and forwards again and it will say so twice — correctly.
   * The invariant that keeps one day to one stamp is the ORDER, and it is
   * `reconcile`'s to hold (`packages/transcript/src/request-order.test.ts`).
   */
  it('says the day changed twice when the order it was handed doubles back', () => {
    const day = 86_400
    const layout = layoutRows([user('a', AT), user('b', AT - day), user('c', AT + 60)], AT)

    expect(layout.a?.dateStamp).toBe('Today')
    expect(layout.b?.dateStamp).toBe('Yesterday')
    expect(layout.c?.dateStamp).toBe('Today')
  })

  // HERM-83, D6: with the group-chat gate open (an `ownAuthorId` given), two
  // people alternating break each other's runs — the same rule that makes an
  // avatar appear "when the sender changes".
  describe('with attribution active', () => {
    const me = 'authentik:me'
    const writer = { id: 'authentik:writer' }
    const researcher = { id: 'authentik:researcher' }

    it('groups three consecutive messages from one colleague into one run', () => {
      const layout = layoutRows(
        [
          user('a', AT, { author: writer }),
          user('b', AT + 5, { author: writer }),
          user('c', AT + 10, { author: writer })
        ],
        undefined,
        me
      )

      expect(layout.a?.grouped).toBe(false)
      expect(layout.b?.grouped).toBe(true)
      expect(layout.c?.grouped).toBe(true)
      expect(layout.c?.tail).toBe(true)
    })

    it('breaks the run when two colleagues alternate', () => {
      const layout = layoutRows(
        [user('a', AT, { author: writer }), user('b', AT + 5, { author: researcher })],
        undefined,
        me
      )

      expect(layout.a?.tail).toBe(true)
      expect(layout.b?.grouped).toBe(false)
    })

    it('keeps the reader’s own attributed row out of a colleague’s run', () => {
      const layout = layoutRows(
        [user('a', AT, { author: writer }), user('b', AT + 5, { author: { id: me } })],
        undefined,
        me
      )

      expect(layout.b?.grouped).toBe(false)
    })
  })
})

describe('dateStampFor', () => {
  it('names today and yesterday rather than dating them', () => {
    expect(dateStampFor(AT, AT)).toBe('Today')
    expect(dateStampFor(AT - 86_400, AT)).toBe('Yesterday')
  })

  it('uses a weekday inside the last week and a date beyond it', () => {
    expect(dateStampFor(AT - 3 * 86_400, AT)).toMatch(/^[A-Z][a-z]{2} \d+ \w+$/)
    expect(dateStampFor(AT - 30 * 86_400, AT)).not.toMatch(/^[A-Z][a-z]{2} /)
  })

  it('adds the year once the date is in another one', () => {
    expect(dateStampFor(AT - 400 * 86_400, AT)).toMatch(/\d{4}$/)
  })
})

/**
 * What a row above may be told while a turn is still arriving.
 *
 * A layout that changes on a settled row is a settled row that re-renders, and if
 * the change reaches its geometry it is a settled row that changes HEIGHT — under
 * the reader, mid-turn. That was the third suspect for the transcript's jump, and
 * it is ruled out here rather than in prose: the turn as it really arrives is
 * replayed one frame at a time and every earlier row is compared with itself.
 */
describe('a row that is already on screen, while the turn under it grows', () => {
  const turn: VisibleItem[] = [
    user('u1', AT),
    assistant('a1', AT + 1),
    tool('t1', AT + 2),
    assistant('a2', AT + 3),
    user('u2', AT + 4)
  ]

  it('is laid out exactly as it was before the row under it arrived', () => {
    for (let length = 1; length < turn.length; length += 1) {
      const before = layoutRows(turn.slice(0, length), AT + 10)
      const after = layoutRows(turn.slice(0, length + 1), AT + 10)

      for (const entry of turn.slice(0, length)) {
        expect(after[entry.item.id]).toEqual(before[entry.item.id])
      }
    }
  })

  it('gives up only its tail when the next row is the same speaker, and nothing else', () => {
    // The one thing that DOES flip, and the reason it is allowed to: `tail` says
    // whether the tail shape is painted into the bubble's own left gutter. It is
    // an absolutely positioned path, so losing it changes what the row draws and
    // not how tall it is — unlike `grouped`, which is a margin, or `dateStamp`,
    // which is a whole extra band.
    const run = [assistant('a1', AT), assistant('a2', AT + 1)]
    const before = layoutRows(run.slice(0, 1), AT + 10).a1
    const after = layoutRows(run, AT + 10).a1

    expect(before?.tail).toBe(true)
    expect(after?.tail).toBe(false)
    expect({ ...after, tail: true }).toEqual(before)
  })
})
