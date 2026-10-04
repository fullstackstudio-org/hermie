/**
 * The files a bot shares, in the transcript (`contract/outbox/`): the strict reader of one attachment, and where it
 * lands: the reply's `message.complete`, a history row, and a history reload over a live reply.
 *
 * The valid and invalid attachments, the `message.complete` payload and the history row are the contract's own
 * examples (`contract/outbox/examples.json`, normative); the cases beyond them are the ones a hostile sender writes.
 */
import {
  type AssistantItem,
  applyEvent,
  createChatState,
  OUTBOX_MAX_COUNT,
  type OutboxAttachment,
  parseOutboxAttachment,
  parseOutboxAttachments,
  reconcile,
  rowsToItems,
  type TranscriptRow,
  visibleItems
} from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../contract/outbox/examples.json?raw'

interface Examples {
  attachments: { valid: Record<string, unknown>[]; invalid: { why: string; value: unknown }[] }
  message_complete: Record<string, unknown>
  history_row: TranscriptRow
}

const examples = JSON.parse(examplesSource) as Examples
const [audio, html] = examples.attachments.valid as [Record<string, unknown>, Record<string, unknown>]
const NOW = 1_790_000_000_000
const ROUTE = `/api/files/outbox/${audio.id as string}`

/** A valid attachment with one field changed. */
const mutate = (over: Record<string, unknown>): Record<string, unknown> => ({ ...audio, ...over })

describe('parseOutboxAttachment, by the contract’s examples', () => {
  it('reads the valid attachments, camel-cased, and keeps what they say', () => {
    expect(parseOutboxAttachment(audio)).toEqual({
      id: 'q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe',
      name: 'tts_20261004_225730_989324.mp3',
      mime: 'audio/mpeg',
      kind: 'audio',
      size: 48213,
      sha256: 'a3f1c2e4b5d6978812ab34cd56ef7890a1b2c3d4e5f60718293a4b5c6d7e8f90',
      createdAt: 1791148287.08,
      url: '/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/tts_20261004_225730_989324.mp3'
    })
    // A name with a space and an `html` type is a file: a download, whatever its name looks like.
    expect(parseOutboxAttachment(html)).toMatchObject({ name: 'Q3 report.html', kind: 'file', mime: 'text/html' })
  })

  it('drops every invalid example except an unknown kind, which is shown as a file', () => {
    for (const { why, value } of examples.attachments.invalid) {
      const parsed = parseOutboxAttachment(value)

      if (why === 'unknown kind') {
        // The contract lets a client show what it does not know as a file: a download the person opens deliberately.
        expect(parsed, why).toMatchObject({ kind: 'file', name: 'tts_20261004_225730_989324.mp3' })
      } else {
        expect(parsed, why).toBeNull()
      }
    }
  })

  it('keeps the five kinds as they are and reads any other string as a file', () => {
    for (const kind of ['image', 'video', 'audio', 'pdf', 'file']) {
      expect(parseOutboxAttachment(mutate({ kind }))?.kind).toBe(kind)
    }

    expect(parseOutboxAttachment(mutate({ kind: 'hologram' }))?.kind).toBe('file')
    expect(parseOutboxAttachment(mutate({ kind: 'AUDIO' }))?.kind).toBe('file')
    // Not a kind at all, rather than an unknown one.
    expect(parseOutboxAttachment(mutate({ kind: 3 }))).toBeNull()
    expect(parseOutboxAttachment(mutate({ kind: null }))).toBeNull()
  })

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['a list', [audio]],
    ['a key the contract does not have', mutate({ path: '/etc/passwd' })],
    ['an id of 31 characters', mutate({ id: 'q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cN' })],
    ['an id with a character outside the alphabet', mutate({ id: 'q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8c.e' })],
    ['a name that is empty', mutate({ name: '' })],
    ['a name of 181 characters', mutate({ name: 'a'.repeat(181) })],
    ['a name with a slash', mutate({ name: 'a/b.mp3' })],
    ['a name with a backslash', mutate({ name: 'a\\b.mp3' })],
    ['a name with a control character', mutate({ name: 'a\u0007b.mp3' })],
    ['a name with a newline', mutate({ name: 'a\nb.mp3' })],
    ['a name that is a dot segment', mutate({ name: '..' })],
    ['a size that is negative', mutate({ size: -1 })],
    ['a size with a fraction', mutate({ size: 1.5 })],
    ['a size as text', mutate({ size: '48213' })],
    ['a sha256 in capitals', mutate({ sha256: 'A3F1C2E4B5D6978812AB34CD56EF7890A1B2C3D4E5F60718293A4B5C6D7E8F90' })],
    ['a created_at that is not a number', mutate({ created_at: 'yesterday' })],
    ['a created_at that is not finite', mutate({ created_at: Infinity })],
    ['a mime that is not text', mutate({ mime: 5 })],
    [
      'a url of another host',
      mutate({
        url: 'https://evil.test/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/tts_20261004_225730_989324.mp3'
      })
    ],
    [
      'a url with the wrong id',
      mutate({ url: '/api/files/outbox/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/tts_20261004_225730_989324.mp3' })
    ],
    ['a url with the wrong name', mutate({ url: '/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/other.mp3' })],
    ['a url with a query', mutate({ url: `${audio.url as string}?token=x` })],
    ['a url that climbs', mutate({ url: '/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/../x' })],
    [
      'a url whose name is encoded wrongly',
      mutate({ url: '/api/files/outbox/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/%E0%A4%A' })
    ],
    [
      'a url that is another route',
      mutate({ url: '/api/files/download/q3Wm0B2v7yXk4Lr9TzPa1sDf6GhJ8cNe/tts_20261004_225730_989324.mp3' })
    ],
    ['a name that is a dot segment written %2e%2e', mutate({ name: '..', url: `${ROUTE}/%2e%2e` })],
    ['a name that is %2e%2e as a decoding the name does not have', mutate({ name: 'x.mp3', url: `${ROUTE}/%2e%2e` })],
    ['a name with a slash written %2F', mutate({ name: 'a/b.mp3', url: `${ROUTE}/a%2Fb.mp3` })],
    ['a url whose %2F is not what the name says', mutate({ name: 'a%2Fb.mp3', url: `${ROUTE}/a%2Fb.mp3` })],
    ['a name with a backslash written %5C', mutate({ name: 'a\\b.mp3', url: `${ROUTE}/a%5Cb.mp3` })],
    ['a url whose %5C is not what the name says', mutate({ name: 'a%5Cb.mp3', url: `${ROUTE}/a%5Cb.mp3` })],
    ['a url that is protocol-relative', mutate({ url: `//evil.test${audio.url as string}` })],
    ['a url with a fragment', mutate({ url: `${audio.url as string}#frag` })],
    [
      'a url with a raw .. segment before the id',
      mutate({ url: `/api/files/outbox/../${audio.id as string}/${audio.name as string}` })
    ],
    ['a url with a raw .. segment as the name', mutate({ name: 'x.mp3', url: `${ROUTE}/..` })],
    ['a url with a . segment between id and name', mutate({ url: `${ROUTE}/./${audio.name as string}` })]
  ])('drops an attachment with %s', (_what, value) => {
    expect(parseOutboxAttachment(value)).toBeNull()
  })

  it('reads a name with markup as the text it is, and a name that needs percent-encoding by what it decodes to', () => {
    const name = '<img src=x onerror=alert(1)>.png'
    const encoded = encodeURIComponent(name)
    const parsed = parseOutboxAttachment(
      mutate({ name, kind: 'image', mime: 'image/png', url: `/api/files/outbox/${audio.id as string}/${encoded}` })
    )

    expect(parsed?.name).toBe(name)
    expect(parsed?.url).toContain('%3Cimg')
  })

  it('reads a name that has a literal percent sign by what its url decodes to', () => {
    const parsed = parseOutboxAttachment(mutate({ name: 'a%2Fb.mp3', url: `${ROUTE}/a%252Fb.mp3` }))

    expect(parsed?.name).toBe('a%2Fb.mp3')
  })

  it('counts a name by characters, not by UTF-16 units: 180 emoji are 180', () => {
    const name = '😀'.repeat(180)
    const url = `/api/files/outbox/${audio.id as string}/${encodeURIComponent(name)}`

    expect(parseOutboxAttachment(mutate({ name, url }))?.name).toBe(name)
    expect(parseOutboxAttachment(mutate({ name: `${name}😀`, url: `${url}${encodeURIComponent('😀')}` }))).toBeNull()
  })
})

describe('parseOutboxAttachments', () => {
  it('keeps the valid ones in order, each token once, and drops the rest', () => {
    const second = { ...html }
    const parsed = parseOutboxAttachments([audio, { nonsense: true }, second, audio, null])

    expect(parsed.map(file => file.id)).toEqual([audio.id, html.id])
  })

  it.each([undefined, null, 'x', 5, {}, []])('reads %j as no attachments', value => {
    expect(parseOutboxAttachments(value)).toEqual([])
  })

  it('keeps at most as many as one reply may hold', () => {
    const many = Array.from({ length: OUTBOX_MAX_COUNT + 20 }, (_, index) => {
      const id = `${String(index).padStart(3, '0')}${'x'.repeat(29)}`

      return mutate({ id, url: `/api/files/outbox/${id}/${audio.name as string}` })
    })

    expect(parseOutboxAttachments(many)).toHaveLength(OUTBOX_MAX_COUNT)
  })
})

const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')
const assistants = (state: ReturnType<typeof fresh>): AssistantItem[] =>
  state.order.map(id => state.items[id]!).filter((item): item is AssistantItem => item.kind === 'assistant')

describe('a reply that shares files, live', () => {
  it('puts them on the reply that message.complete settles, beside its text', () => {
    let state = fresh()

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(state, { type: 'message.delta', seq: 2, payload: { text: 'Here is the' } }, NOW)
    state = applyEvent(state, { type: 'message.complete', seq: 3, payload: examples.message_complete }, NOW)

    const [reply] = assistants(state)

    expect(assistants(state)).toHaveLength(1)
    expect(reply?.text).toBe('Here is the recording.')
    expect(reply?.outbox?.map(file => file.name)).toEqual(['tts_20261004_225730_989324.mp3'])
    expect(reply?.rowId).toBe(42)
  })

  it('opens a reply for a turn whose only answer is a file (no text)', () => {
    let state = fresh()

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(
      state,
      { type: 'message.complete', seq: 2, payload: { text: '', status: 'complete', attachments: [audio] } },
      NOW
    )

    expect(assistants(state)).toHaveLength(1)
    expect(assistants(state)[0]?.outbox).toHaveLength(1)
    expect(
      visibleItems(state, { level: 'normal', showBotToBot: true, showThinking: true }).map(row => row.item.kind)
    ).toContain('assistant')
  })

  it('keeps the reply a row already holds, and shows the files on it', () => {
    let state = reconcile(
      fresh(),
      rowsToItems([{ role: 'assistant', row_id: 42, text: 'Here is the recording.' }], 'rpc')
    )

    state = applyEvent(state, { type: 'message.complete', seq: 1, payload: examples.message_complete }, NOW)

    expect(assistants(state)).toHaveLength(1)
    expect(assistants(state)[0]?.outbox).toHaveLength(1)
  })

  it('reads a completion with no attachments, and one with [] or a bad list, as none', () => {
    for (const attachments of [undefined, [], 'x', [{ id: 'nope' }]]) {
      let state = fresh()

      state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
      state = applyEvent(
        state,
        {
          type: 'message.complete',
          seq: 2,
          payload: { text: 'Done.', status: 'complete', ...(attachments === undefined ? {} : { attachments }) }
        },
        NOW
      )

      expect(assistants(state)[0]?.outbox).toBeUndefined()
    }
  })

  it('shows the note about a file that could not be shared as the text it is', () => {
    let state = fresh()

    state = applyEvent(state, { type: 'message.start', seq: 1 }, NOW)
    state = applyEvent(
      state,
      {
        type: 'message.complete',
        seq: 2,
        payload: { text: 'Here.\n\n(1 file could not be shared.)', status: 'complete', attachments: [] }
      },
      NOW
    )

    expect(assistants(state)[0]?.text).toBe('Here.\n\n(1 file could not be shared.)')
    expect(assistants(state)[0]?.outbox).toBeUndefined()
  })
})

describe('a reply that shares files, from history', () => {
  it('carries them from a session.history row, and from the REST row the same way', () => {
    const rpc = rowsToItems([examples.history_row], 'rpc')
    const { text, row_id: rowId, ...rest } = examples.history_row as TranscriptRow & { text: string; row_id: number }
    const rest2 = rowsToItems([{ ...rest, content: text, id: rowId }], 'rest')

    for (const items of [rpc, rest2]) {
      const [reply] = items as AssistantItem[]

      expect(reply?.kind).toBe('assistant')
      expect(reply?.text).toBe('Here is the recording.')
      expect(reply?.outbox?.[0]).toMatchObject({ id: audio.id, kind: 'audio', createdAt: 1791148287.08 })
    }
  })

  it('keeps a row that says nothing but carries a file, and drops one that carries nothing', () => {
    const rows: TranscriptRow[] = [
      { role: 'assistant', row_id: 1, text: '', attachments: [audio] },
      { role: 'assistant', row_id: 2, text: '', attachments: [] }
    ]

    const items = rowsToItems(rows, 'rpc') as AssistantItem[]

    expect(items).toHaveLength(1)
    expect(items[0]?.outbox).toHaveLength(1)
  })

  it('leaves out an invalid attachment of a row and keeps the row', () => {
    const [reply] = rowsToItems(
      [{ role: 'assistant', row_id: 1, text: 'Two.', attachments: [{ ...audio, path: '/etc/passwd' }, html] }],
      'rpc'
    ) as AssistantItem[]

    expect(reply?.outbox?.map(file => file.id)).toEqual([html.id])
  })

  it('survives a reload: the live reply keeps its files when the same row comes back, with or without them', () => {
    let live = fresh()

    live = applyEvent(live, { type: 'message.start', seq: 1 }, NOW)
    live = applyEvent(live, { type: 'message.complete', seq: 2, payload: examples.message_complete }, NOW)

    const reloaded = reconcile(live, rowsToItems([examples.history_row], 'rpc'))
    const bare = reconcile(live, rowsToItems([{ ...examples.history_row, attachments: undefined }], 'rpc'))

    for (const state of [reloaded, bare]) {
      expect(assistants(state)).toHaveLength(1)
      expect((assistants(state)[0]?.outbox as OutboxAttachment[]).map(file => file.id)).toEqual([audio.id])
    }
  })
})
