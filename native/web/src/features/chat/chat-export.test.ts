import type { VisibleItem } from '@hermie/transcript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { assistantItem, noticeItem, toolItem, userItem } from '../../test-support/chat-fixtures'
import { conversationFile, downloadFile, exportConversation } from './chat-export'

const NOW = new Date('2026-10-04T09:30:00Z')

const rows = (...items: VisibleItem['item'][]): VisibleItem[] =>
  items.map(item => ({ item, presentation: 'normal' }) as unknown as VisibleItem)

const conversation = rows(
  userItem('What is **new**?', { ts: 1_700_000_000 }),
  assistantItem('Mostly *fixes*.\n\n- one\n- two', { ts: 1_700_000_060 }),
  toolItem('web_search', { summary: 'three results' }),
  noticeItem('Switched model')
)

beforeEach(() => resetActiveLocale())

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the conversation as a file', () => {
  it('writes Markdown with bold speakers, the reply’s own Markdown kept, and a name safe to save under', () => {
    const file = conversationFile({
      items: conversation,
      botName: 'Dr. Researcher',
      groupChat: false,
      format: 'md',
      now: NOW
    })

    expect(file.name).toBe('Dr-Researcher-2026-10-04.md')
    expect(file.mime).toBe('text/markdown;charset=utf-8')
    expect(file.content).toContain('**You**')
    expect(file.content).toContain('**Dr. Researcher**')
    expect(file.content).toContain('What is **new**?')
    expect(file.content).toContain('Mostly *fixes*.')
    expect(file.content).toContain('- one\n- two')
    expect(file.content).toContain('web_search')
  })

  it('writes plain text with the same rows and no bold on the speakers', () => {
    const file = conversationFile({
      items: conversation,
      botName: 'Dr. Researcher',
      groupChat: false,
      format: 'txt',
      now: NOW
    })

    expect(file.name).toBe('Dr-Researcher-2026-10-04.txt')
    expect(file.mime).toBe('text/plain;charset=utf-8')
    expect(file.content).not.toContain('**You**')
    expect(file.content).toContain('You')
    expect(file.content).toContain('Dr. Researcher')
    expect(file.content).toContain('Mostly *fixes*.')
  })

  it('exports every row it is given, in order, and no row it is not', () => {
    const file = conversationFile({
      items: conversation.slice(0, 2),
      botName: 'Bot',
      groupChat: false,
      format: 'txt',
      now: NOW
    })

    expect(file.content).not.toContain('web_search')
    expect(file.content.indexOf('What is')).toBeLessThan(file.content.indexOf('Mostly'))
  })

  it('is the same text for the same rows and the same moment', () => {
    const input = { items: conversation, botName: 'Bot', groupChat: false, format: 'md' as const, now: NOW }

    expect(conversationFile(input).content).toBe(conversationFile(input).content)
  })

  it('names somebody else’s turn in the group chat, and nobody in a chat of the reader’s own', () => {
    const foreign = userItem('Hi all', { author: { id: 'person-2', name: 'Lloyd' } as never })
    const group = conversationFile({
      items: rows(foreign),
      botName: 'Bot',
      groupChat: true,
      ownAuthorId: 'person-1',
      format: 'txt',
      now: NOW
    })
    const own = conversationFile({ items: rows(foreign), botName: 'Bot', groupChat: false, format: 'txt', now: NOW })

    expect(group.content).toContain('Lloyd')
    expect(own.content).not.toContain('Lloyd')
  })

  it('is an empty conversation’s header and nothing else, without throwing', () => {
    const file = conversationFile({ items: [], botName: 'Bot', groupChat: false, format: 'md', now: NOW })

    expect(file.content).toContain('Bot')
  })
})

describe('the download', () => {
  it('gives the browser a link to a Blob of the text, named as the file is, and clears it up', () => {
    vi.useFakeTimers()

    const created: Blob[] = []
    const create = vi.fn((blob: Blob) => {
      created.push(blob)

      return 'blob:hermie-test'
    })
    const revoke = vi.fn()

    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))

    const clicked: { href: string; download: string; connected: boolean }[] = []

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, connected: this.isConnected })
    })

    downloadFile({ name: 'bot-2026-10-04.md', mime: 'text/markdown;charset=utf-8', content: '# Hello' })

    expect(clicked).toEqual([{ href: 'blob:hermie-test', download: 'bot-2026-10-04.md', connected: true }])
    expect(created[0]?.type).toBe('text/markdown;charset=utf-8')
    // Nothing is left in the page, and the URL is let go of later, once the save has started.
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(revoke).toHaveBeenCalledWith('blob:hermie-test')
  })

  it('exports in one call and answers the file', () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    const file = exportConversation({ items: conversation, botName: 'Bot', groupChat: false, format: 'md', now: NOW })

    expect(file.name).toBe('Bot-2026-10-04.md')
  })
})
