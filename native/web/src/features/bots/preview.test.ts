import { createChatState, type ChatState } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import { clipInline, formatChatPreview, rowPreview, senderName } from './preview'

const opts = { groupChat: false, ownAuthorId: undefined }

/** A chat holding the given rows, newest last. */
function chatWith(items: Record<string, unknown>[]): ChatState {
  const state = createChatState('researcher', 'stored-1', 'stored-1')

  for (const item of items) {
    const id = String(item.id)

    state.items[id] = item as never
    state.order.push(id)
  }

  return state
}

describe('clipInline', () => {
  it('collapses whitespace and cuts with an ellipsis', () => {
    expect(clipInline('a\n  b\t c')).toBe('a b c')
    expect(clipInline('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('cuts by character, not by UTF-16 unit', () => {
    expect(clipInline('\u{1F600}'.repeat(5), 3)).toBe(`\u{1F600}\u{1F600}…`)
  })
})

describe('senderName', () => {
  it('is the stamped name, cleaned', () => {
    expect(senderName({ id: 'p:1', name: '  Ann‮  Lee ' })).toBe('Ann Lee')
  })

  it('falls back to the identity without its provider prefix, never prettified', () => {
    expect(senderName({ id: 'authentik:7f3a' })).toBe('7f3a')
    expect(senderName({ id: 'https://issuer.example/sub' })).toBe('https://issuer.example/sub')
    // A name that shows nothing is not a name.
    expect(senderName({ id: 'p:42', name: 'ㅤᅟ' })).toBe('42')
  })
})

describe('formatChatPreview', () => {
  it('is empty for no preview', () => {
    expect(formatChatPreview(null)).toBe('')
  })

  it('takes the markdown off one line of text', () => {
    expect(formatChatPreview({ text: '## Heading\n\nSome **bold** text', system: false })).toBe(
      'Heading Some bold text'
    )
  })

  it('leads a teammate’s message with the handle, the way the DM bubble does', () => {
    expect(formatChatPreview({ text: 'Done.', fromHandle: 'writer', system: false })).toBe('\u{1F916} @writer: Done.')
  })

  it('folds a raw "Message from" row to the same shape', () => {
    expect(formatChatPreview({ text: 'Message from \u{1F916} Writer (@writer): Hello there', system: false })).toBe(
      '\u{1F916} @writer: Hello there'
    )
  })

  it('leads another person’s turn in the group chat with their name, isolated from the text after it', () => {
    expect(formatChatPreview({ text: '1 + 1?', senderName: 'Ann', system: false })).toBe('⁨Ann⁩: 1 + 1?')
  })
})

describe('rowPreview', () => {
  it('uses the gateway’s string when there is no transcript', () => {
    expect(rowPreview(undefined, 'Hello', opts)).toEqual({ text: 'Hello', system: false })
  })

  it('prefers the last real message of the transcript, and walks past scaffolding', () => {
    const chat = chatWith([
      { id: 'a', kind: 'assistant', text: 'The answer.', streaming: false },
      { id: 'b', kind: 'notice', text: 'Switched model' }
    ])

    expect(rowPreview(chat, 'older gateway text', opts)).toEqual({ text: 'The answer.', system: false })
  })

  it('names another author only in the group chat, and never the reader', () => {
    const user = (author: { id: string; name: string }) =>
      chatWith([{ id: 'u', kind: 'user', text: 'Hi', author, attachments: [] }])

    expect(rowPreview(user({ id: 'p:2', name: 'Ann' }), '', { groupChat: true, ownAuthorId: 'p:1' }).text).toBe(
      '⁨Ann⁩: Hi'
    )
    expect(rowPreview(user({ id: 'p:1', name: 'Me' }), '', { groupChat: true, ownAuthorId: 'p:1' }).text).toBe('Hi')
    expect(rowPreview(user({ id: 'p:2', name: 'Ann' }), '', { groupChat: false, ownAuthorId: 'p:1' }).text).toBe('Hi')
  })

  it('shows a gateway wrapper as the scaffolding’s own words, marked quiet', () => {
    expect(rowPreview(undefined, '[System: The active model changed. Continue.]', opts)).toMatchObject({
      system: true
    })
  })
})
