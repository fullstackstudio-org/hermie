/**
 * The menus, as data.
 *
 * The native menu and the fallback sheet are two drawings of ONE list of
 * intentions, and the whole reason that list is data rather than JSX is so the
 * contract between "what the menu offers" and "what a selection does" can be
 * tested without either drawing. Every case here is a round trip: build the items,
 * take an id out of them, and check the parser gives back the action that id was
 * built to mean.
 */
import { messageLinks, messageMenuItems, parseMessageMenuAction } from '../src/chat-ui/message-menu'
import { parseRowMenuAction, rowMenuItems, type RowMenuModel } from '../src/features/bots/row-menu-items'
import type { AssistantItem, BotDmOutItem, TranscriptItem } from '../src/chat-ui/types'
import { menuLeaves } from '../src/ui/menu'

const model: RowMenuModel = {
  accent: 'teal',
  archived: false,
  botName: 'researcher',
  displayName: 'Researcher',
  folders: [
    { id: null, name: 'No folder' },
    { id: 'd1', name: 'Finance' }
  ],
  unread: true
}

const assistant: AssistantItem = {
  id: 'a1',
  kind: 'assistant',
  origin: 'live',
  seq: 1,
  streaming: false,
  interim: false,
  text: 'See [the notes](https://example.com/notes) and <https://example.com/raw>.',
  version: 1
}

describe('a chat row’s menu', () => {
  it('offers every id its parser understands, and no others', () => {
    /*
      Selectable leaves only. A disabled line is drawn as a caption — UIKit
      greys it and never fires it, the fallback sheet renders it as plain text
      with nothing to press — so it carries no intention for the parser to
      understand. `Muted until 14:30` is the first such line; `Mark as read`
      is disabled some of the time and still parses, which is why the rule is
      about what can be chosen rather than about what is offered.
    */
    for (const leaf of menuLeaves(rowMenuItems(model)).filter(item => !item.disabled)) {
      expect(parseRowMenuAction(leaf.id)).not.toBeNull()
    }
  })

  it('offers every id its parser understands when the chat is muted too', () => {
    for (const leaf of menuLeaves(rowMenuItems({ ...model, mutedUntil: 0 })).filter(item => !item.disabled)) {
      expect(parseRowMenuAction(leaf.id)).not.toBeNull()
    }
  })

  it('ticks the colour the chat is on, and only that one', () => {
    const colour = rowMenuItems(model).find(item => item.id === 'colour')
    const ticked = colour?.children?.filter(child => child.selected)

    expect(ticked?.map(child => child.id)).toEqual(['accent:teal'])
    expect(parseRowMenuAction('accent:teal')).toEqual({ kind: 'accent', accent: 'teal' })
  })

  it('refuses a colour that is not one of the nine', () => {
    // An id is a string on the wire between UIKit and JavaScript, and a menu built
    // by an older binary could carry anything.
    expect(parseRowMenuAction('accent:chartreuse')).toBeNull()
  })

  it('reads the loose top level back as null rather than as a folder called top', () => {
    expect(parseRowMenuAction('folder:top')).toEqual({ kind: 'folder', folderId: null })
    expect(parseRowMenuAction('folder:d1')).toEqual({ kind: 'folder', folderId: 'd1' })
  })

  it('says Archive or Unarchive, never both, and reports a toggle either way', () => {
    const wording = (archived: boolean) =>
      rowMenuItems({ ...model, archived }).find(item => item.id === 'archive')?.title

    expect(wording(false)).toBe('Archive')
    expect(wording(true)).toBe('Unarchive')
    expect(parseRowMenuAction('archive')).toEqual({ kind: 'archiveToggle' })
  })

  it('greys out Mark as read for a row with nothing unread', () => {
    const read = rowMenuItems({ ...model, unread: false }).find(item => item.id === 'markRead')

    expect(read?.disabled).toBe(true)
    expect(rowMenuItems(model).find(item => item.id === 'markRead')?.disabled).toBe(false)
  })

  it('drops the moving lines for an archived row, where up and down mean nothing', () => {
    const ids = rowMenuItems({ ...model, archived: true, movable: false }).map(item => item.id)

    expect(ids).not.toContain('move')
    expect(ids).not.toContain('newFolder')
    expect(ids).toContain('archive')
  })

  it('never reports a submenu’s own id as an action', () => {
    expect(parseRowMenuAction('colour')).toBeNull()
    expect(parseRowMenuAction('folder')).toBeNull()
    expect(parseRowMenuAction('move')).toBeNull()
  })
})

describe('a message’s menu', () => {
  it('copies the words and the markdown as two different strings', () => {
    const text = parseMessageMenuAction('copyText', assistant)
    const markdown = parseMessageMenuAction('copyMarkdown', assistant)

    expect(markdown).toEqual({ kind: 'copyMarkdown', text: assistant.text })
    expect(text).toEqual({ kind: 'copyText', text: 'See the notes and https://example.com/raw.' })
  })

  it('offers Copy as Markdown only where the two would differ', () => {
    const plain: TranscriptItem = { ...assistant, text: 'Nothing to mark up here.' }
    const ids = messageMenuItems({ canOpenBot: false, detailsOpen: false, hasDetails: false, item: plain }).map(
      item => item.id
    )

    expect(ids).toContain('copyText')
    expect(ids).not.toContain('copyMarkdown')
  })

  it('lists each link once, in the order it was written', () => {
    expect(messageLinks(assistant.text)).toEqual(['https://example.com/notes', 'https://example.com/raw'])
    expect(messageLinks('a https://x.test b https://x.test')).toEqual(['https://x.test'])
  })

  it('resolves a link by position against the message as it is NOW', () => {
    // The menu can be open while a reply streams, so the index is re-resolved
    // rather than the href being captured when the items were built.
    expect(parseMessageMenuAction('copyLink:1', assistant)).toEqual({
      kind: 'copyLink',
      href: 'https://example.com/raw'
    })
    expect(parseMessageMenuAction('copyLink:9', assistant)).toBeNull()
  })

  it('offers the other bot’s chat for a bot-to-bot line, and only when the host can open one', () => {
    const dm: BotDmOutItem = {
      id: 't1',
      kind: 'bot_dm_out',
      origin: 'live',
      seq: 2,
      toolId: 'tool-1',
      target: '@writer',
      targetHandle: 'writer',
      message: 'Draft this please.',
      dispatch: { status: 'queued' },
      version: 1
    }

    const withHost = messageMenuItems({ canOpenBot: true, detailsOpen: false, hasDetails: false, item: dm })
    const without = messageMenuItems({ canOpenBot: false, detailsOpen: false, hasDetails: false, item: dm })

    expect(withHost.map(item => item.id)).toContain('openBot')
    expect(without.map(item => item.id)).not.toContain('openBot')
    expect(parseMessageMenuAction('openBot', dm)).toEqual({ kind: 'openBot', handle: 'writer' })
  })

  it('says Show or Hide according to the disclosure it would flip', () => {
    const line = (detailsOpen: boolean) =>
      messageMenuItems({ canOpenBot: false, detailsOpen, hasDetails: true, item: assistant }).find(
        item => item.id === 'toggleDetails'
      )?.title

    expect(line(false)).toBe('Show details')
    expect(line(true)).toBe('Hide details')
  })

  it('offers Select text only where a pointer can use it', () => {
    // The panel renders on every platform, but only where a mouse can drag
    // across it does it give a reader anything the long press does not. So the
    // line is opt-in, and `TranscriptList` opts in on a Mac.
    const withPointer = messageMenuItems({
      canOpenBot: false,
      canSelectText: true,
      detailsOpen: false,
      hasDetails: false,
      item: assistant
    }).map(item => item.id)

    const without = messageMenuItems({
      canOpenBot: false,
      detailsOpen: false,
      hasDetails: false,
      item: assistant
    }).map(item => item.id)

    expect(withPointer).toContain('selectText')
    expect(without).not.toContain('selectText')

    // Directly under the two Copy lines: same intention, different destination.
    expect(withPointer.indexOf('selectText')).toBe(withPointer.indexOf('copyMarkdown') + 1)
  })

  it('hands the panel the MARKDOWN, not the stripped words', () => {
    // The panel renders the message; a Copy strips it. Handing over the stripped
    // form would open a panel showing something the bubble never said.
    expect(parseMessageMenuAction('selectText', assistant)).toEqual({
      kind: 'selectText',
      text: assistant.text
    })
  })

  it('offers no Select text for a row with no words', () => {
    const status: TranscriptItem = {
      id: 's2',
      kind: 'status',
      origin: 'live',
      seq: 4,
      text: 'Reconnected',
      version: 1
    } as TranscriptItem

    expect(
      messageMenuItems({ canOpenBot: false, canSelectText: true, detailsOpen: false, hasDetails: false, item: status })
    ).toEqual([])
    expect(parseMessageMenuAction('selectText', status)).toBeNull()
  })

  it('offers nothing at all for a row with no words and no disclosure', () => {
    const status: TranscriptItem = {
      id: 's1',
      kind: 'status',
      origin: 'live',
      seq: 3,
      text: 'Reconnected',
      version: 1
    } as TranscriptItem

    expect(messageMenuItems({ canOpenBot: true, detailsOpen: false, hasDetails: false, item: status })).toEqual([])
  })
})
