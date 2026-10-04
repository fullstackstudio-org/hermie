/**
 * What a message's menu offers, as data (`message-menu.ts`): the lines per kind
 * of message, when they are disabled or absent, and what a chosen line stands
 * for read against the message as it is now.
 */
import { describe, expect, it } from 'vitest'

import {
  assistantItem,
  botDmInItem,
  cronDeliveryItem,
  noticeItem,
  toolItem,
  userItem
} from '../../test-support/chat-fixtures'
import {
  MAX_LINK_ITEMS,
  messageLinks,
  type MessageMenuId,
  messageMenuAction,
  messageMenuEntries,
  type MessageMenuModel
} from './message-menu'

const model = (over: Partial<MessageMenuModel> & Pick<MessageMenuModel, 'item'>): MessageMenuModel => ({
  canRegenerate: false,
  turnActive: false,
  ...over
})

const ids = (over: Parameters<typeof model>[0]): MessageMenuId[] =>
  messageMenuEntries(model(over)).map(entry => entry.id)

describe('the lines per message', () => {
  it('offers nothing beyond the copies where the host allows nothing, and nothing at all to a structural row', () => {
    expect(ids({ item: userItem('plain words') })).toEqual(['copyText'])
    expect(ids({ item: assistantItem('some **bold**') })).toEqual(['copyText', 'copyMarkdown'])
    expect(ids({ item: toolItem('web_search'), canBranch: true, canEditResend: true })).toEqual([])
    expect(ids({ item: noticeItem('Heads up'), canBranch: true })).toEqual([])
  })

  it('offers Edit and resend on the turn the host names, with words in it, and not on a reply', () => {
    expect(ids({ item: userItem('again please'), canEditResend: true })).toEqual(['copyText', 'editResend'])
    expect(ids({ item: userItem('   '), canEditResend: true })).toEqual([])
    expect(ids({ item: assistantItem('an answer'), canEditResend: true })).toEqual(['copyText'])
  })

  it('draws Edit and resend and Regenerate disabled while a turn runs, and Branch enabled', () => {
    expect(
      messageMenuEntries(model({ item: userItem('hi'), canEditResend: true, canBranch: true, turnActive: true }))
    ).toEqual([
      { id: 'copyText', disabled: false },
      { id: 'editResend', disabled: true },
      { id: 'branch', disabled: false }
    ])
    expect(
      messageMenuEntries(model({ item: assistantItem('done'), canRegenerate: true, canBranch: true, turnActive: true }))
    ).toEqual([
      { id: 'copyText', disabled: false },
      { id: 'regenerate', disabled: true },
      { id: 'branch', disabled: false }
    ])
  })

  it('offers Branch from here on a turn and a reply, and on no other kind of row', () => {
    expect(ids({ item: userItem('q'), canBranch: true })).toContain('branch')
    expect(ids({ item: assistantItem('a'), canBranch: true })).toContain('branch')
    expect(ids({ item: botDmInItem('hello from another bot'), canBranch: true })).not.toContain('branch')
    expect(ids({ item: cronDeliveryItem('all quiet'), canBranch: true })).not.toContain('branch')
    expect(ids({ item: userItem('q'), canBranch: false })).not.toContain('branch')
  })

  it('puts the lines in one order: copies, then the turn lines, then branch, then the links', () => {
    expect(
      ids({
        item: assistantItem('some **bold** at https://a.example and https://b.example'),
        canRegenerate: true,
        canBranch: true
      })
    ).toEqual(['copyText', 'copyMarkdown', 'regenerate', 'branch', 'copyLinks'])
  })

  it('makes one link a line of its own and several a submenu of them', () => {
    expect(messageMenuEntries(model({ item: assistantItem('go to https://a.example now') }))).toContainEqual({
      id: 'copyLink:0',
      disabled: false
    })

    const several = messageMenuEntries(model({ item: assistantItem('https://a.example and https://b.example') }))
    const group = several.find(entry => entry.id === 'copyLinks')

    expect(group?.links).toEqual([
      { id: 'copyLink:0', href: 'https://a.example' },
      { id: 'copyLink:1', href: 'https://b.example' }
    ])
    expect(several.map(entry => entry.id)).not.toContain('copyLink:0')
  })
})

describe('Read aloud', () => {
  it('is under the copies of what a bot said, and absent where the browser cannot speak', () => {
    expect(ids({ item: assistantItem('some **bold**'), canReadAloud: true })).toEqual([
      'copyText',
      'copyMarkdown',
      'readAloud'
    ])
    expect(ids({ item: botDmInItem('hello from another bot'), canReadAloud: true })).toEqual(['copyText', 'readAloud'])
    // Dropped, not disabled: there is no later in which a browser without a synthesiser gets one.
    expect(ids({ item: assistantItem('words') })).toEqual(['copyText'])
  })

  it('is the bot’s words only: not the reader’s turn, a card, or a reply with none', () => {
    expect(ids({ item: userItem('my own words'), canReadAloud: true })).toEqual(['copyText'])
    expect(ids({ item: cronDeliveryItem('all quiet'), canReadAloud: true })).toEqual(['copyText'])
    expect(ids({ item: toolItem('web_search'), canReadAloud: true })).toEqual([])
    expect(ids({ item: assistantItem('   '), canReadAloud: true })).toEqual([])
  })

  it('says Stop reading for a row that is being read or waits its turn, and is never disabled by a running turn', () => {
    expect(ids({ item: assistantItem('words'), canReadAloud: true, reading: true })).toEqual([
      'copyText',
      'stopReading'
    ])
    expect(
      messageMenuEntries(model({ item: assistantItem('words'), canReadAloud: true, turnActive: true }))
    ).toContainEqual({ id: 'readAloud', disabled: false })
  })

  it('sits before the turn lines and the links, in the one order', () => {
    expect(
      ids({
        item: assistantItem('some **bold** at https://a.example'),
        canReadAloud: true,
        canRegenerate: true,
        canBranch: true
      })
    ).toEqual(['copyText', 'copyMarkdown', 'readAloud', 'regenerate', 'branch', 'copyLink:0'])
  })

  it('is read off the reply as it is now, and the same line serves both labels', () => {
    expect(messageMenuAction('readAloud', assistantItem('**now** longer'))).toEqual({
      kind: 'readAloud',
      text: '**now** longer'
    })
    expect(messageMenuAction('stopReading', assistantItem('words'))).toEqual({ kind: 'readAloud', text: 'words' })
    expect(messageMenuAction('readAloud', userItem('mine'))).toBeNull()
    expect(messageMenuAction('readAloud', assistantItem(' '))).toBeNull()
  })
})

describe('the links of a message', () => {
  it('finds Markdown links, angle links and bare addresses, in the order they appear, once each', () => {
    expect(
      messageLinks(
        'see https://a.example, then [b](https://b.example "title") and <mailto:c@example.org> and https://a.example.'
      )
    ).toEqual(['https://a.example', 'https://b.example', 'mailto:c@example.org'])
  })

  it('keeps only addresses a browser may open, and not a sentence’s full stop', () => {
    expect(
      messageLinks('[x](javascript:alert(1)) [y](/relative/path) [z](ftp://files.example) https://ok.example.')
    ).toEqual(['https://ok.example'])
    expect(messageLinks('')).toEqual([])
    expect(messageLinks('no links here')).toEqual([])
  })

  it('stops at the cap, which is what keeps a menu shorter than the window', () => {
    const many = Array.from({ length: MAX_LINK_ITEMS + 5 }, (_, index) => `https://site${index}.example`).join(' ')

    expect(messageLinks(many)).toHaveLength(MAX_LINK_ITEMS)
  })
})

describe('what a chosen line stands for', () => {
  it('reads Edit and resend off the turn, with its attachment references', () => {
    expect(
      messageMenuAction('editResend', userItem('reword me', { attachments: ['@file:a.txt', '/tmp/b.png'] }))
    ).toEqual({ kind: 'editResend', text: 'reword me', attachments: ['@file:a.txt', '/tmp/b.png'] })
    expect(messageMenuAction('editResend', userItem('plain'))).toEqual({
      kind: 'editResend',
      text: 'plain',
      attachments: []
    })
    expect(messageMenuAction('editResend', userItem('  '))).toBeNull()
    expect(messageMenuAction('editResend', assistantItem('not a turn'))).toBeNull()
  })

  it('reads Branch off the words as they are now, from a turn or a reply only', () => {
    expect(messageMenuAction('branch', assistantItem('half a sentence and the rest'))).toEqual({
      kind: 'branch',
      text: 'half a sentence and the rest'
    })
    expect(messageMenuAction('branch', userItem('which way?'))).toEqual({ kind: 'branch', text: 'which way?' })
    expect(messageMenuAction('branch', toolItem('web_search'))).toBeNull()
  })

  it('reads a link off the message as it is now, by its place in the list', () => {
    const reply = assistantItem('first https://a.example then https://b.example')

    expect(messageMenuAction('copyLink:1', reply)).toEqual({ kind: 'copyLink', href: 'https://b.example' })
    expect(messageMenuAction('copyLink:5', reply)).toBeNull()
    expect(messageMenuAction('copyLinks', reply)).toBeNull()
  })
})
