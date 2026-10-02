/**
 * Finding the row a search hit is about.
 *
 * The gateway names a conversation and never a message, so this is the half of
 * the feature that has to agree with FTS5 well enough to land on the row the
 * gateway matched — from nothing but the words the reader typed.
 */
import type { VisibleItem } from '@hermie/transcript'

import { findMatchingItem, itemText, searchTerms, textMatches } from '../src/features/search'

const say = (id: string, text: string, kind: 'user' | 'assistant' = 'assistant'): VisibleItem =>
  ({
    item: { id, kind, text, seq: 0, at: 0, origin: 'rest', version: 1, streaming: false, interim: false },
    presentation: 'full'
  }) as unknown as VisibleItem

describe('searchTerms', () => {
  it('drops a trailing wildcard, because a bare term already implies one', () => {
    expect(searchTerms('nimb*')).toEqual([{ needle: 'nimb', phrase: false }])
  })

  it('keeps a quoted phrase whole', () => {
    expect(searchTerms('"deploy pipeline" fails')).toEqual([
      { needle: 'deploy pipeline', phrase: true },
      { needle: 'fails', phrase: false }
    ])
  })
})

describe('textMatches', () => {
  it('matches a word by its start, the way a prefix term does', () => {
    expect(textMatches('the invoice service', searchTerms('invo'))).toBe(true)
  })

  it('does not match the middle of a word', () => {
    // FTS5 tokenises; `voice` is not a prefix of `invoice`, and pretending it is
    // would highlight rows the gateway never matched.
    expect(textMatches('the invoice service', searchTerms('voice'))).toBe(false)
  })

  it('needs every term in the same row', () => {
    expect(textMatches('the invoice service', searchTerms('invoice service'))).toBe(true)
    expect(textMatches('the invoice service', searchTerms('invoice nightly'))).toBe(false)
  })

  it('matches a quoted phrase as a substring, punctuation and all', () => {
    expect(textMatches('it failed: deploy-pipeline', searchTerms('"deploy-pipeline"'))).toBe(true)
  })

  it('never matches on an empty query', () => {
    expect(textMatches('anything', searchTerms('  '))).toBe(false)
  })
})

describe('itemText', () => {
  it('reads both halves of a bot-to-bot exchange', () => {
    const dm = {
      kind: 'bot_dm_out',
      targetHandle: 'writer',
      message: 'Can you draft the announcement?',
      reply: { text: 'Done, it is in the doc.' }
    }

    expect(itemText(dm as never)).toContain('writer')
    expect(itemText(dm as never)).toContain('Done, it is in the doc.')
  })

  it('has nothing to say about a row that is not speech', () => {
    expect(itemText({ kind: 'tool', name: 'read_file' } as never)).toBe('')
  })
})

describe('findMatchingItem', () => {
  it('answers the NEWEST match, which is the one the least history has to reach', () => {
    expect(
      findMatchingItem([say('a', 'the invoice again'), say('b', 'nothing'), say('c', 'invoices, still')], 'invoice')
    ).toBe('c')
  })

  it('answers nothing when the words are not in what is loaded', () => {
    expect(findMatchingItem([say('a', 'nothing here')], 'invoice')).toBeUndefined()
  })
})
