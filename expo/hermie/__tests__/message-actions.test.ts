/**
 * The two menu lines that start a turn, and the three questions they raise:
 * which ROW they belong to, what a running turn does to them, and what
 * selecting one actually asks for.
 */
import type { AssistantItem, TranscriptItem, UserItem } from '@hermie/transcript'

import { messageMenuItems, parseMessageMenuAction } from '../src/chat-ui/message-menu'
import { menuLeaves } from '../src/ui/menu'

const base = { id: 'x', origin: 'history' as const, seq: 1, version: 1 }

const userItem = (over: Partial<UserItem> = {}): UserItem => ({
  ...base,
  kind: 'user',
  text: 'Introduce yourself.',
  ...over
})

const assistantItem = (over: Partial<AssistantItem> = {}): AssistantItem => ({
  ...base,
  id: 'a1',
  interim: false,
  kind: 'assistant',
  streaming: false,
  text: 'I am researcher.',
  ...over
})

const ids = (item: TranscriptItem, model: Partial<Parameters<typeof messageMenuItems>[0]> = {}): string[] =>
  menuLeaves(messageMenuItems({ canOpenBot: false, detailsOpen: false, hasDetails: false, item, ...model })).map(
    entry => entry.id
  )

const itemFor = (id: string, item: TranscriptItem, model: Partial<Parameters<typeof messageMenuItems>[0]> = {}) =>
  menuLeaves(messageMenuItems({ canOpenBot: false, detailsOpen: false, hasDetails: false, item, ...model })).find(
    entry => entry.id === id
  )

describe('which row each line belongs to', () => {
  it('offers Edit and resend on your own turn and nowhere else', () => {
    expect(ids(userItem(), { canEditResend: true })).toContain('editResend')
    expect(ids(assistantItem(), { canEditResend: true })).not.toContain('editResend')
    // A turn with no words — a file sent on its own — has nothing to put back.
    expect(ids(userItem({ text: '   ' }), { canEditResend: true })).not.toContain('editResend')
  })

  it('offers Regenerate only on the row the host named as the newest reply', () => {
    // The host answers both halves: it can regenerate at all, and this is the
    // row. A menu that tried to decide the second half for itself would have to
    // see the whole list, which a row never does.
    expect(ids(assistantItem(), { canRegenerate: true })).toContain('regenerate')
    expect(ids(assistantItem(), { canRegenerate: false })).not.toContain('regenerate')
    expect(ids(userItem(), { canRegenerate: true })).not.toContain('regenerate')
  })

  it('offers neither where the host cannot honour them', () => {
    const plain = ids(userItem())

    expect(plain).not.toContain('editResend')
    expect(plain).not.toContain('regenerate')
    // And the lines that were always there still are.
    expect(plain).toContain('copyText')
  })
})

describe('while a turn is running', () => {
  it('greys both lines rather than removing them', () => {
    const edit = itemFor('editResend', userItem(), { canEditResend: true, turnRunning: true })
    const again = itemFor('regenerate', assistantItem(), { canRegenerate: true, turnRunning: true })

    // Present, so the reader learns the action exists; disabled, so they learn
    // it is not available now. A line that vanishes for the length of every turn
    // is a line nobody believes in.
    expect(edit?.disabled).toBe(true)
    expect(again?.disabled).toBe(true)
  })

  it('leaves them selectable once the turn has ended', () => {
    expect(itemFor('editResend', userItem(), { canEditResend: true })?.disabled).toBeFalsy()
    expect(itemFor('regenerate', assistantItem(), { canRegenerate: true })?.disabled).toBeFalsy()
  })
})

describe('what a selection asks for', () => {
  it('reads the turn back off the item rather than off the menu', () => {
    // The same rule the copies follow: a menu can be open while the row changes,
    // and resending the version the menu was built from would resend the wrong
    // thing.
    const grown = userItem({ text: 'Introduce yourself, briefly.' })

    expect(parseMessageMenuAction('editResend', grown)).toEqual({
      attachments: [],
      kind: 'editResend',
      text: 'Introduce yourself, briefly.'
    })
  })

  it('carries the attachment references, which is what the turn actually holds', () => {
    const withFile = userItem({ attachments: ['@file:/root/notes.md'], text: 'Read this.' })

    expect(parseMessageMenuAction('editResend', withFile)).toEqual({
      attachments: ['@file:/root/notes.md'],
      kind: 'editResend',
      text: 'Read this.'
    })
  })

  it('refuses a selection that does not match the row it landed on', () => {
    expect(parseMessageMenuAction('editResend', assistantItem())).toBeNull()
    expect(parseMessageMenuAction('regenerate', userItem())).toBeNull()
    expect(parseMessageMenuAction('regenerate', assistantItem())).toEqual({ kind: 'regenerate' })
  })
})

describe('Read aloud', () => {
  it('is offered on what a bot said and nowhere else', () => {
    expect(ids(assistantItem(), { canReadAloud: true })).toContain('readAloud')
    expect(ids(userItem(), { canReadAloud: true })).not.toContain('readAloud')
    expect(ids(assistantItem({ text: '   ' }), { canReadAloud: true })).not.toContain('readAloud')
  })

  it('is DROPPED where the platform cannot speak, not greyed', () => {
    /*
      The opposite call from `Regenerate`, and deliberately.

      A greyed line says "not now", which is true of a turn that is running and
      false of a browser with no synthesiser — there is no later in which one
      appears. A line that can never be taken should not be drawn.
    */
    expect(ids(assistantItem(), { canReadAloud: false })).not.toContain('readAloud')
  })

  it('takes no notice of a running turn, because reading is local', () => {
    expect(itemFor('readAloud', assistantItem(), { canReadAloud: true, turnRunning: true })?.disabled).toBeFalsy()
  })

  it('says Stop reading on the row that is in flight, under the same id', () => {
    const idle = itemFor('readAloud', assistantItem(), { canReadAloud: true })
    const busy = itemFor('readAloud', assistantItem(), { canReadAloud: true, reading: true })

    expect(idle?.title).toBe('Read aloud')
    expect(busy?.title).toBe('Stop reading')
    // One id for both, because it is one intention about one row; the queue
    // decides which way it goes. See `SpeechReader.toggle`.
    expect(busy?.id).toBe(idle?.id)
  })

  it('hands over the MARKDOWN, read off the item at selection time', () => {
    const grown = assistantItem({ text: 'Done. See `plain-text.ts`.' })

    expect(parseMessageMenuAction('readAloud', grown)).toEqual({
      kind: 'readAloud',
      text: 'Done. See `plain-text.ts`.'
    })
    expect(parseMessageMenuAction('readAloud', userItem())).toBeNull()
  })
})
