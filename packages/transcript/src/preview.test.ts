/**
 * What a chat-list row says the conversation is about.
 *
 * The bug this exists for: a row read `[System: The active model for th…`,
 * because the gateway's `preview` is the raw text of the last row and the last
 * row was a marker addressed to the model. So the two halves are tested
 * separately — a real message must win over anything the machine wrote, and a
 * string that has no real message behind it must at least lose its wrapper.
 */
import { describe, expect, it } from 'vitest'

import { chatRowPreview, previewFromChat, previewFromGatewayText, type ChatPreviewOptions } from './preview'
import { reconcile } from './reconcile'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { cronBotChatText, delegationBatchText, modelSwitchMarkerText } from './__fixtures__/rows'
import { type ChatState, createChatState, type MessageAuthor } from './types'

const chatOf = (rows: readonly TranscriptRow[]): ChatState =>
  reconcile(createChatState('researcher', 'stored-1', 'resolved-1'), rowsToItems(rows, 'rpc'))

describe('the preview a transcript can answer for itself', () => {
  it('takes the last real message, walking past everything the machine wrote', () => {
    const chat = chatOf([
      { role: 'user', row_id: 1, text: 'how did the deploy go?' },
      { role: 'assistant', row_id: 2, text: 'Three services, all green.' },
      { role: 'user', row_id: 3, text: modelSwitchMarkerText, display_kind: 'model_switch' },
      { role: 'tool', row_id: 4, name: 'read_file', tool_id: 'call_1' }
    ])

    expect(previewFromChat(chat)).toEqual({ text: 'Three services, all green.', system: false })
  })

  it('counts the owner’s own turn, because a messenger shows what you last said', () => {
    // Deliberately NOT `countsAsMessage` from the selectors: that one answers
    // "is this unread mail", and your own message never is.
    const chat = chatOf([
      { role: 'assistant', row_id: 1, text: 'Ready when you are.' },
      { role: 'user', row_id: 2, text: 'ship it' }
    ])

    expect(previewFromChat(chat)?.text).toBe('ship it')
  })

  it('names the teammate whose DM it is, so the row can prefix the handle', () => {
    const chat = chatOf([{ role: 'user', row_id: 1, text: 'Message from 🤖 Writer (@writer): draft is ready' }])

    expect(previewFromChat(chat)).toEqual({ text: 'draft is ready', fromHandle: 'writer', system: false })
  })

  it('previews a cron report by its body, never by its header', () => {
    const chat = chatOf([{ role: 'user', row_id: 1, text: cronBotChatText }])

    expect(previewFromChat(chat)?.text.startsWith('## Inbox scan')).toBe(true)
  })

  it('answers nothing for a chat holding only scaffolding, so the caller can fall back', () => {
    const chat = chatOf([{ role: 'user', row_id: 1, text: delegationBatchText }])

    expect(previewFromChat(chat)).toBeNull()
    expect(previewFromChat(undefined)).toBeNull()
  })

  it('walks past a bubble with nothing in it — an empty turn is not a message', () => {
    const chat = chatOf([
      { role: 'assistant', row_id: 1, text: 'Earlier answer.' },
      { role: 'user', row_id: 2, text: '   ' }
    ])

    expect(previewFromChat(chat)?.text).toBe('Earlier answer.')
  })
})

describe('the preview when only the gateway’s string is available', () => {
  it('shows the note without its wrapper, and marks it as the machine’s', () => {
    expect(previewFromGatewayText(modelSwitchMarkerText)).toEqual({
      text: 'The active model for this chat has changed to k3 via provider moonshot.',
      system: true
    })
  })

  it('never lets the raw wrapper through', () => {
    expect(previewFromGatewayText(modelSwitchMarkerText)?.text).not.toContain('[System:')
  })

  it('shows a report’s header rather than its whole body, which is pages long', () => {
    expect(previewFromGatewayText(delegationBatchText)).toEqual({
      text: 'ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada',
      system: true
    })
  })

  it('leaves an ordinary message exactly as it arrived', () => {
    expect(previewFromGatewayText('can you check this')).toEqual({ text: 'can you check this', system: false })
  })

  it('answers nothing for nothing', () => {
    expect(previewFromGatewayText('')).toBeNull()
    expect(previewFromGatewayText('   ')).toBeNull()
    expect(previewFromGatewayText(undefined)).toBeNull()
  })
})

describe('choosing between the two', () => {
  it('prefers a real message the transcript holds over a marker the string carries', () => {
    /*
      The string is newer — it is the row the marker was written as — and it
      still loses. A preview stale by one row that says what somebody said beats
      a fresh one that says what nobody did.
    */
    const chat = chatOf([
      { role: 'assistant', row_id: 1, text: 'Three services, all green.' },
      { role: 'user', row_id: 2, text: modelSwitchMarkerText, display_kind: 'model_switch' }
    ])

    expect(chatRowPreview(chat, modelSwitchMarkerText)).toEqual({
      text: 'Three services, all green.',
      system: false
    })
  })

  it('falls back to the unwrapped string when the transcript has no message in it', () => {
    expect(chatRowPreview(chatOf([]), modelSwitchMarkerText)).toMatchObject({ system: true })
    expect(chatRowPreview(undefined, modelSwitchMarkerText)).toMatchObject({ system: true })
  })
})

describe('previewFromGatewayText on a row the gateway cut for the list', () => {
  const processFull =
    '[IMPORTANT: Background process proc_38ad4d983751 completed normally (exit code 0). Command: /usr/local/lib/tool --flag]'
  const processCut =
    '[IMPORTANT: Background process proc_38ad4d983751 completed normally (exit code 0). Command: /usr/local/lib/too...'
  const systemCut =
    '[System: The active model for this chat has changed to gpt-6-astra via /model. Sessions that were open keep t...'

  it('reads a single-line background-process wrapper as a system line', () => {
    expect(previewFromGatewayText(processFull)).toEqual({
      text: 'Background process proc_38ad4d983751 completed normally (exit code 0)',
      system: true
    })
  })

  it('reads the same wrapper after the gateway cut its bracket off', () => {
    expect(previewFromGatewayText(processCut)).toEqual({
      text: 'Background process proc_38ad4d983751 completed normally (exit code 0)',
      system: true
    })
  })

  it('reads a cut model-switch note down to its first sentence', () => {
    expect(previewFromGatewayText(systemCut)).toEqual({
      text: 'The active model for this chat has changed to gpt-6-astra via /model',
      system: true
    })
  })

  it('leaves a message that merely starts with a bracket alone', () => {
    expect(previewFromGatewayText('[the plan](https://example.test) is ready')).toEqual({
      text: '[the plan](https://example.test) is ready',
      system: false
    })
  })
})

describe('who a group-chat row’s preview leads with (HERM-83, Task 5)', () => {
  const ME = 'authentik:me'
  const WRITER: MessageAuthor = { id: 'authentik:writer', name: 'Robin' }

  // A stand-in for `fallbackSenderName` (chat-ui/format.ts): the engine
  // cannot import the chat kit, so the resolver is always the caller's, the
  // same shape `TranscriptContext.resolveSenderName` and `entryFor`
  // (`export.ts`) already take.
  const resolveSenderName = (author: MessageAuthor): string => author.name ?? author.id

  const GROUP_OPTIONS: ChatPreviewOptions = { groupChat: true, ownAuthorId: ME, resolveSenderName }

  const authoredRowOf = (author: MessageAuthor): TranscriptRow => ({
    role: 'user',
    row_id: 1,
    text: 'draft is ready',
    display_metadata: { author }
  })

  it('leads with the resolved name for somebody else’s row', () => {
    const chat = chatOf([authoredRowOf(WRITER)])

    expect(previewFromChat(chat, GROUP_OPTIONS)).toEqual({ text: 'draft is ready', senderName: 'Robin', system: false })
  })

  it('never names the reader’s own attributed row', () => {
    const chat = chatOf([authoredRowOf({ id: ME, name: 'Me' })])

    expect(previewFromChat(chat, GROUP_OPTIONS)?.senderName).toBeUndefined()
  })

  it('never names anybody outside the group chat, even with everything else known', () => {
    const chat = chatOf([authoredRowOf(WRITER)])

    expect(previewFromChat(chat, { ...GROUP_OPTIONS, groupChat: false })?.senderName).toBeUndefined()
  })

  it('never names anybody before the reader’s own identity is known', () => {
    const chat = chatOf([authoredRowOf(WRITER)])

    expect(previewFromChat(chat, { groupChat: true, resolveSenderName })?.senderName).toBeUndefined()
  })

  it('never names an unattributed row', () => {
    const chat = chatOf([{ role: 'user', row_id: 1, text: 'no stamp on this one' }])

    expect(previewFromChat(chat, GROUP_OPTIONS)?.senderName).toBeUndefined()
  })

  it('leaves every row unattributed when the caller has no resolver to name one with', () => {
    const chat = chatOf([authoredRowOf(WRITER)])

    expect(previewFromChat(chat, { groupChat: true, ownAuthorId: ME })?.senderName).toBeUndefined()
  })

  it('threads the same options through `chatRowPreview`', () => {
    const chat = chatOf([authoredRowOf(WRITER)])

    expect(chatRowPreview(chat, '', GROUP_OPTIONS)?.senderName).toBe('Robin')
  })

  it('leaves an absent options argument exactly as it behaved before `author` existed', () => {
    const chat = chatOf([authoredRowOf(WRITER)])

    expect(previewFromChat(chat)).toEqual({ text: 'draft is ready', system: false })
  })

  describe('a row an agent sent on somebody’s behalf', () => {
    const VIA = { kind: 'mcp', client: 'Claude Code' }
    const viaRowOf = (author: MessageAuthor): TranscriptRow => ({
      role: 'user',
      row_id: 1,
      text: 'draft is ready',
      display_metadata: { author: { ...author, via: VIA } }
    })

    it('leads with `<name> via <client>` for a colleague’s row', () => {
      expect(previewFromChat(chatOf([viaRowOf(WRITER)]), GROUP_OPTIONS)?.senderName).toBe('Robin via Claude Code')
    })

    it('labels the reader’s own agent row too: it is never drawn as the reader typing', () => {
      expect(previewFromChat(chatOf([viaRowOf({ id: ME, name: 'Me' })]), GROUP_OPTIONS)?.senderName).toBe(
        'Me via Claude Code'
      )
    })

    it('labels it outside the group chat as well', () => {
      expect(
        previewFromChat(chatOf([viaRowOf({ id: ME, name: 'Me' })]), { resolveSenderName, ownAuthorId: ME })?.senderName
      ).toBe('Me via Claude Code')
    })

    it('stays unattributed when the caller has no resolver to name the person with', () => {
      expect(
        previewFromChat(chatOf([viaRowOf(WRITER)]), { groupChat: true, ownAuthorId: ME })?.senderName
      ).toBeUndefined()
    })
  })
})
