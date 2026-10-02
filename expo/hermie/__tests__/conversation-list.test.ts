/**
 * The own-chat title family and the per-bot conversation list model.
 *
 * Sub-chats plan, Task 1: a pure model of "the group chat, plus as many of the
 * reader's own as they have started", built once a `session.list` answer and
 * this reader's lead (`Chat · <name>`) are known. No socket anywhere below.
 */
import type { SessionListRow } from '@hermes/shared/gateway-contract'

import {
  buildConversationList,
  isOwnChatTitle,
  isStampLabel,
  labelFromText,
  newOwnChatTitle,
  OWN_CHAT_LABEL_MAX,
  ownChatActions,
  ownChatLabel,
  ownChatTitle,
  TITLE_SEPARATOR
} from '../src/features/sessions/conversation-list'
import { cacheKeyFor, classifyConversations, conversationKey } from '../src/features/sessions/session-model'

const ADA = 'Chat · Ada'
const ADAM = 'Chat · Adam'

const row = (fields: Partial<SessionListRow> & { id: string }): SessionListRow => ({
  title: '',
  ...fields
})

describe('the own-chat title family', () => {
  it('builds the bare lead for an empty label, and a full title for a real one', () => {
    expect(ownChatTitle(ADA, '')).toBe(ADA)
    expect(ownChatTitle(ADA, 'Trip planning')).toBe(`${ADA}${TITLE_SEPARATOR}Trip planning`)
  })

  it('answers no title at all for an empty lead', () => {
    expect(ownChatTitle('', 'Trip planning')).toBe('')
  })

  it('recognises the bare lead and a labelled chat as the same reader’s', () => {
    expect(isOwnChatTitle(ADA, ADA)).toBe(true)
    expect(isOwnChatTitle(`${ADA}${TITLE_SEPARATOR}Trip planning`, ADA)).toBe(true)
  })

  it('does not let one lead match another reader’s chats', () => {
    // Ada does not own Adam's chats merely because her name is a prefix of
    // his — the separator is load-bearing, not decoration.
    expect(isOwnChatTitle(ADAM, ADA)).toBe(false)
    expect(isOwnChatTitle(`${ADAM}${TITLE_SEPARATOR}Trip planning`, ADA)).toBe(false)
  })

  it('never matches anything against an empty lead', () => {
    expect(isOwnChatTitle(ADA, '')).toBe(false)
  })

  it("reads the label back out, and answers '' for the bare lead", () => {
    expect(ownChatLabel(ADA, ADA)).toBe('')
    expect(ownChatLabel(`${ADA}${TITLE_SEPARATOR}Trip planning`, ADA)).toBe('Trip planning')
    expect(ownChatLabel(ADAM, ADA)).toBe('')
  })
})

describe('buildConversationList', () => {
  it('lists the bare lead as an own chat, with an empty label', () => {
    const list = buildConversationList({
      lead: ADA,
      rows: [row({ id: 'stored-ada', title: ADA, started_at: 10 })]
    })

    expect(list.own).toHaveLength(1)
    expect(list.own[0]?.id).toBe('stored-ada')
    expect(list.own[0]?.kind).toBe('mine')
    expect(ownChatLabel(list.own[0]!.title, ADA)).toBe('')
  })

  it('distinguishes Chat · Ada from Chat · Adam', () => {
    const list = buildConversationList({
      lead: ADA,
      rows: [
        row({ id: 'stored-ada', title: `${ADA}${TITLE_SEPARATOR}Trip planning`, started_at: 5 }),
        row({ id: 'stored-adam', title: `${ADAM}${TITLE_SEPARATOR}Trip planning`, started_at: 5 })
      ]
    })

    expect(list.own.map(conversation => conversation.id)).toEqual(['stored-ada'])
  })

  it('keeps a row matching the canonical id out of "own" even when its title looks like the lead’s family', () => {
    const list = buildConversationList({
      canonicalId: 'stored-shared',
      lead: ADA,
      rows: [row({ id: 'stored-shared', title: `${ADA}${TITLE_SEPARATOR}Whatever`, started_at: 1 })]
    })

    expect(list.group?.id).toBe('stored-shared')
    expect(list.group?.kind).toBe('canonical')
    expect(list.own).toHaveLength(0)
  })

  it('falls back to the canonical TITLE when no id is known yet', () => {
    const list = buildConversationList({
      lead: ADA,
      rows: [row({ id: 'stored-shared', title: 'Bot Chat', started_at: 1 })]
    })

    expect(list.group?.id).toBe('stored-shared')
    expect(list.own).toHaveLength(0)
  })

  it('drops rows with no id', () => {
    const list = buildConversationList({
      lead: ADA,
      rows: [row({ id: '', title: ADA, started_at: 1 })]
    })

    expect(list.own).toHaveLength(0)
  })

  it('answers canCreate false on an empty lead, and lists nothing as own', () => {
    const list = buildConversationList({
      lead: '',
      rows: [row({ id: 'stored-ada', title: ADA, started_at: 1 })]
    })

    expect(list.canCreate).toBe(false)
    expect(list.own).toHaveLength(0)
  })

  it('answers canCreate true once the lead is real, regardless of how many own chats exist', () => {
    expect(buildConversationList({ lead: ADA, rows: [] }).canCreate).toBe(true)
  })

  describe('ordering: most recently used first (Owner Decisions, 2026-09-22)', () => {
    it('sorts by the local last-opened stamp when one is given', () => {
      const list = buildConversationList({
        lead: ADA,
        lastOpenedAt: { 'stored-old': 500, 'stored-new': 900 },
        rows: [
          row({ id: 'stored-old', title: `${ADA}${TITLE_SEPARATOR}Old`, started_at: 100 }),
          row({ id: 'stored-new', title: `${ADA}${TITLE_SEPARATOR}New`, started_at: 200 })
        ]
      })

      expect(list.own.map(conversation => conversation.id)).toEqual(['stored-new', 'stored-old'])
    })

    it('falls back to creation time for a chat never opened on this device', () => {
      const list = buildConversationList({
        lead: ADA,
        // Only "stored-opened" has a local last-opened stamp; "stored-fresh"
        // must fall back to its own started_at rather than sorting as if it
        // had never been touched at all.
        lastOpenedAt: { 'stored-opened': 50 },
        rows: [
          row({ id: 'stored-opened', title: `${ADA}${TITLE_SEPARATOR}Opened`, started_at: 10 }),
          row({ id: 'stored-fresh', title: `${ADA}${TITLE_SEPARATOR}Fresh`, started_at: 999 })
        ]
      })

      expect(list.own.map(conversation => conversation.id)).toEqual(['stored-fresh', 'stored-opened'])
    })

    it('ties break on title when no timestamp is given at all', () => {
      const list = buildConversationList({
        lead: ADA,
        rows: [
          row({ id: 'stored-b', title: `${ADA}${TITLE_SEPARATOR}Bravo` }),
          row({ id: 'stored-a', title: `${ADA}${TITLE_SEPARATOR}Alpha` })
        ]
      })

      expect(list.own.map(conversation => conversation.id)).toEqual(['stored-a', 'stored-b'])
    })
  })
})

describe('ownChatActions', () => {
  it('offers the canonical row nothing', () => {
    const list = buildConversationList({
      canonicalId: 'stored-shared',
      lead: ADA,
      rows: [row({ id: 'stored-shared', title: 'Bot Chat' })]
    })

    expect(ownChatActions(list.group!)).toEqual([])
  })

  it('offers an own chat open, rename and delete', () => {
    const list = buildConversationList({
      lead: ADA,
      rows: [row({ id: 'stored-ada', title: ADA })]
    })

    expect(ownChatActions(list.own[0]!)).toEqual(['open', 'rename', 'delete'])
  })
})

describe('newOwnChatTitle', () => {
  it('is always lead · stamp, never the bare lead', () => {
    expect(newOwnChatTitle(ADA, '2026-09-22 09:00')).toBe(`${ADA}${TITLE_SEPARATOR}2026-09-22 09:00`)
  })

  it('answers no title at all for an empty lead', () => {
    expect(newOwnChatTitle('', '2026-09-22 09:00')).toBe('')
  })
})

describe('labelFromText', () => {
  it('takes the first six words, cut at a word boundary', () => {
    expect(labelFromText('Planning the next trip together as a family')).toBe('Planning the next trip together as')
  })

  it('collapses whitespace from a pasted block', () => {
    expect(labelFromText('Trip\n\nplanning')).toBe('Trip planning')
  })

  it('never cuts mid-word, and stays inside the character budget', () => {
    const label = labelFromText('Supercalifragilisticexpialidocious is a very long word indeed and then some')

    expect(label.length).toBeLessThanOrEqual(OWN_CHAT_LABEL_MAX)
    expect(label.endsWith('…')).toBe(false)
  })

  it('answers an empty label for text with no words at all', () => {
    expect(labelFromText('   ')).toBe('')
    expect(labelFromText('')).toBe('')
  })
})

describe('isStampLabel', () => {
  it('recognises the minute-precision stamp a new chat is born with', () => {
    expect(isStampLabel('2026-09-22 09:00')).toBe(true)
  })

  it('recognises the seconds-precision retry stamp', () => {
    expect(isStampLabel('2026-09-22 09:00:05')).toBe(true)
  })

  it('does not mistake a reader-given label, or a partial date, for a stamp', () => {
    expect(isStampLabel('Trip planning')).toBe(false)
    expect(isStampLabel('2026-09-22')).toBe(false)
    expect(isStampLabel('09:00')).toBe(false)
  })

  it('is false for anything that is not a string', () => {
    expect(isStampLabel(undefined)).toBe(false)
    expect(isStampLabel(42)).toBe(false)
  })
})

describe('cacheKeyFor', () => {
  it('is the bare bot name for the group chat', () => {
    expect(cacheKeyFor('gardener', 'stored-shared', true)).toBe('gardener')
  })

  it('is the conversationKey scheme for an own chat', () => {
    expect(cacheKeyFor('gardener', 'stored-ada', false)).toBe(conversationKey('gardener', 'stored-ada'))
    expect(cacheKeyFor('gardener', 'stored-ada', false)).toBe('gardener#stored-ada')
  })
})

describe('classifyConversations keeps every own chat, not just the bare lead, out of "past"', () => {
  it('excludes a labelled own chat from past when userChatTitle is given', () => {
    const rows: SessionListRow[] = [
      row({ id: 'stored-shared', title: 'Bot Chat' }),
      row({ id: 'stored-ada', title: ADA }),
      row({ id: 'stored-ada-2', title: `${ADA}${TITLE_SEPARATOR}Trip planning` })
    ]

    const groups = classifyConversations({ rows, userChatTitle: ADA })

    expect(groups.past.map(conversation => conversation.id)).toEqual([])
    expect(groups.mine?.id).toBe('stored-ada')
  })
})
