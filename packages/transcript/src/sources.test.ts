/**
 * The pages a reply used (`contract/sources/`): the strict reader, and where its result lands on an item, live on
 * `message.complete` and after a reload on the row's `display_metadata`.
 *
 * The valid and invalid entries are the contract's own examples (`contract/sources/examples.json`, normative).
 */
import { describe, expect, it } from 'vitest'

import examples from '../../../contract/sources/examples.json'
import { reconcile } from './reconcile'
import { applyEvent } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { parseSource, parseSources, SOURCES_MAX_COUNT, sourcesOfMetadata } from './sources'
import { type AssistantItem, type ChatState, createChatState } from './types'

const NOW = 1_700_000_000_000

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)

const READ = { url: 'https://example.org/guide/install', title: 'Installing the gateway', via: 'read' }
const FOUND = { url: 'https://docs.example.com/a?b=c#d', title: '', via: 'found' }

describe('parseSource, by the contract’s examples', () => {
  it.each(examples.entries.valid.map(entry => [entry.url, entry] as const))('keeps %s', (_url, entry) => {
    expect(parseSource(entry)).toEqual(entry)
  })

  it.each(examples.entries.invalid.map(entry => [entry.why, entry.value] as const))('drops: %s', (_why, value) => {
    expect(parseSource(value)).toBeNull()
  })

  it('drops what is not an object at all', () => {
    for (const value of [null, undefined, 'https://example.org/', 7, ['https://example.org/'], true]) {
      expect(parseSource(value)).toBeNull()
    }
  })

  it('reads a title at the cap and drops one a character over', () => {
    expect(parseSource({ ...READ, title: 'x'.repeat(160) })).not.toBeNull()
    expect(parseSource({ ...READ, title: 'x'.repeat(161) })).toBeNull()
  })

  it('counts characters the way the schema does, not UTF-16 units', () => {
    // 160 emoji are 320 UTF-16 units and 160 characters.
    expect(parseSource({ ...READ, title: '\u{1F600}'.repeat(160) })).not.toBeNull()
    expect(parseSource({ ...READ, title: '\u{1F600}'.repeat(161) })).toBeNull()
  })

  it('reads an address at the cap and drops one over it', () => {
    const base = 'https://example.org/'

    expect(parseSource({ ...READ, url: base + 'a'.repeat(2048 - base.length) })).not.toBeNull()
    expect(parseSource({ ...READ, url: base + 'a'.repeat(2049 - base.length) })).toBeNull()
  })

  it('takes only what the gateway stores: the scheme and the host in lower case, ASCII', () => {
    expect(parseSource({ ...READ, url: 'https://example.org/Page?Q=1#Frag' })).not.toBeNull()
    expect(parseSource({ ...READ, url: 'HTTPS://example.org/' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://Example.org/' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://b\u00fccher.example/' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://xn--bcher-kva.example/K\u00fcche' })).not.toBeNull()
    expect(parseSource({ ...READ, url: 'data:text/html,<p>x</p>' })).toBeNull()
    expect(parseSource({ ...READ, url: '//example.org/' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://example.org/\n' })).toBeNull()
  })

  it('takes a port only as a number from 0 to 65535', () => {
    expect(parseSource({ ...READ, url: 'https://example.org:65535/' })).not.toBeNull()
    expect(parseSource({ ...READ, url: 'https://example.org:0/' })).not.toBeNull()
    expect(parseSource({ ...READ, url: 'https://[2001:db8::1]:8443/p' })).not.toBeNull()
    expect(parseSource({ ...READ, url: 'https://example.org:65536/' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://example.org:70000/x' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://example.org:http/' })).toBeNull()
    expect(parseSource({ ...READ, url: 'https://example.org:/' })).toBeNull()
  })

  it('refuses an address with an invisible or control character anywhere in it', () => {
    for (const bad of [
      '\u202e',
      '\u200b',
      '\u0085',
      '\u00ad',
      '\u2066',
      '\ufeff',
      '\u{e0041}',
      '\u0000',
      '\u007f',
      '\ud800'
    ]) {
      expect(parseSource({ ...READ, url: `https://example.org/a${bad}b` }), JSON.stringify(bad)).toBeNull()
    }

    expect(parseSource({ ...READ, url: 'https://example.org/a%E2%80%AEb' })).not.toBeNull()
  })

  it('does not coerce: a title that is not text is not an entry', () => {
    expect(parseSource({ ...READ, title: 7 })).toBeNull()
    expect(parseSource({ ...READ, title: null })).toBeNull()
    expect(parseSource({ ...READ, via: 'READ' })).toBeNull()
  })
})

describe('parseSources', () => {
  it('keeps the valid entries in order and drops the rest, without repairing them', () => {
    const bad = { ...READ, url: 'ftp://example.org/x' }

    expect(parseSources([FOUND, bad, READ, 'nope', null])).toEqual([FOUND, READ])
  })

  it('keeps the first of an address that comes twice', () => {
    const again = { ...FOUND, title: 'Again', via: 'read' }

    expect(parseSources([FOUND, again])).toEqual([FOUND])
  })

  it('keeps at most 24, even when the gateway sent more', () => {
    const many = Array.from({ length: SOURCES_MAX_COUNT + 6 }, (_, index) => ({
      url: `https://example.org/${index}`,
      title: `Page ${index}`,
      via: 'found'
    }))

    const kept = parseSources(many)

    expect(kept).toHaveLength(SOURCES_MAX_COUNT)
    expect(kept[0]?.url).toBe('https://example.org/0')
    expect(kept.at(-1)?.url).toBe(`https://example.org/${SOURCES_MAX_COUNT - 1}`)
  })

  it('reads anything that is not a list as no sources', () => {
    for (const value of [undefined, null, {}, 'a', 3, [], { 0: READ }]) {
      expect(parseSources(value)).toEqual([])
    }
  })
})

describe('sourcesOfMetadata', () => {
  it('reads the list off an object or off the JSON text of one', () => {
    expect(sourcesOfMetadata({ sources: [READ, FOUND] })).toEqual([READ, FOUND])
    expect(sourcesOfMetadata(JSON.stringify({ sources: [READ, FOUND] }))).toEqual([READ, FOUND])
  })

  it('reads anything else as none', () => {
    for (const value of [undefined, null, 'not json', '[]', [READ], { sources: 'x' }, { other: [READ] }]) {
      expect(sourcesOfMetadata(value)).toEqual([])
    }
  })
})

describe('a reply’s sources, live', () => {
  const complete = (payload: Record<string, unknown>) =>
    applyEvent(
      applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW),
      { type: 'message.complete', seq: 2, payload },
      NOW
    )

  const reply = (state: ChatState) => list(state).find(item => item.kind === 'assistant') as AssistantItem

  it('puts the contract’s message.complete example on the reply', () => {
    expect(reply(complete(examples.message_complete)).sources).toEqual(examples.message_complete.sources)
  })

  it('leaves the key off a reply with none, and off one whose list held nothing valid', () => {
    expect('sources' in reply(complete({ text: 'plain' }))).toBe(false)
    expect(
      'sources' in
        reply(complete({ text: 'plain', sources: [{ url: 'javascript:alert(1)', title: 'x', via: 'read' }] }))
    ).toBe(false)
  })

  it('still reads a frame with keys it does not know', () => {
    const state = complete({ text: 'plain', future_key: { a: 1 }, sources: [READ], other: [1, 2] })

    expect(reply(state)).toMatchObject({ text: 'plain', status: 'complete', sources: [READ] })
  })
})

describe('a reply’s sources, after a reload', () => {
  const row = (extra: Partial<TranscriptRow> = {}): TranscriptRow => ({ ...examples.history_row, ...extra })

  it('reads them off the row’s display_metadata, as an object or as JSON text', () => {
    const asObject = rowsToItems([row()], 'rpc')[0] as AssistantItem
    const asText = rowsToItems(
      [row({ display_metadata: JSON.stringify(examples.history_row.display_metadata) })],
      'rpc'
    )[0] as AssistantItem

    expect(asObject.sources).toEqual(examples.history_row.display_metadata.sources)
    expect(asText.sources).toEqual(examples.history_row.display_metadata.sources)
  })

  it('reads them off a row of the other transport too', () => {
    const { text, row_id: id, ...rest } = row()
    const item = rowsToItems([{ ...rest, content: text, id }], 'rest')[0] as AssistantItem

    expect(item.sources).toEqual(examples.history_row.display_metadata.sources)
  })

  it('leaves the key off a row with none', () => {
    const item = rowsToItems([row({ display_metadata: { turn_id: 't-1' } })], 'rpc')[0] as AssistantItem

    expect('sources' in item).toBe(false)
  })

  it('keeps the live reply’s sources when the history that arrives has none', () => {
    const live = applyEvent(
      applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW),
      { type: 'message.complete', seq: 2, payload: { text: 'plain', sources: [READ] } },
      NOW
    )
    const merged = reconcile(live, rowsToItems([{ role: 'assistant', text: 'plain', row_id: 5 }], 'rpc'))
    const reply = list(merged).find(item => item.kind === 'assistant') as AssistantItem

    expect(reply.sources).toEqual([READ])
  })
})
