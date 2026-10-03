import { describe, expect, it } from 'vitest'

import { exportTranscript, transcriptFileName } from './export'
import type { MessageAuthor, TranscriptItem } from './types'

let seq = 0

const base = (ts?: number) => ({
  id: `i${(seq += 1)}`,
  origin: 'history' as const,
  seq,
  version: 1,
  ...(ts === undefined ? {} : { ts })
})

const clock = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(11, 16)

const OPTIONS = { botName: 'Researcher', formatTime: clock, selfName: 'You' }

describe('serializing a conversation', () => {
  it('writes the two speakers, in order, in both formats', () => {
    const items: TranscriptItem[] = [
      { ...base(60), kind: 'user', text: 'Introduce yourself.' },
      { ...base(120), interim: false, kind: 'assistant', streaming: false, text: '# Hello\n\nI am **researcher**.' }
    ]

    const { markdown, text } = exportTranscript(items, OPTIONS)

    expect(markdown).toBe(
      [
        '# Researcher',
        '',
        '**You** · 00:01',
        '',
        'Introduce yourself.',
        '',
        '**Researcher** · 00:02',
        '',
        '# Hello',
        '',
        'I am **researcher**.',
        ''
      ].join('\n')
    )
    expect(text).toContain('00:01 · You:')
    expect(text).toContain('00:02 · Researcher:')
    // The reply's own markdown survives into the .txt file: those are the
    // author's characters, and an export must not edit what it preserves.
    expect(text).toContain('I am **researcher**.')
  })

  it('writes the rows that are about the conversation as asides', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        kind: 'tool',
        name: 'terminal',
        context: 'ls -la',
        resultKnown: true,
        status: 'complete',
        toolId: 't1'
      },
      { ...base(70), kind: 'notice', noticeKind: 'model_switch', title: 'Switched model', body: 'to example-large' },
      {
        ...base(80),
        approvalId: 'a1',
        choices: ['allow', 'deny'],
        command: 'rm -rf ./build',
        kind: 'approval',
        requestId: 'srq-1',
        state: 'answered',
        answer: 'allow'
      }
    ]

    const { markdown, text } = exportTranscript(items, OPTIONS)

    expect(markdown).toContain('> 00:01 · terminal: ls -la')
    expect(markdown).toContain('> 00:01 · Switched model — to example-large')
    expect(markdown).toContain('> 00:01 · Permission request — rm -rf ./build (answered allow)')
    expect(text).toContain('  · 00:01 · terminal: ls -la')
    // An aside is never attributed to a speaker in either format.
    expect(markdown).not.toContain('**terminal**')
  })

  it('carries a turn’s attachments by the reference the turn holds', () => {
    const items: TranscriptItem[] = [
      { ...base(60), attachments: ['@file:/root/notes.md'], kind: 'user', text: 'Read this.' }
    ]

    expect(exportTranscript(items, OPTIONS).markdown).toContain('[@file:/root/notes.md]')
  })

  it('keeps a failed turn for its error and drops one that said nothing at all', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        error: { message: 'the worker died', partial: false },
        interim: false,
        kind: 'assistant',
        streaming: false,
        text: ''
      },
      { ...base(70), interim: false, kind: 'assistant', streaming: false, text: '   ' }
    ]

    const { markdown } = exportTranscript(items, OPTIONS)

    expect(markdown).toContain('(the worker died)')
    expect(markdown.match(/\*\*Researcher\*\*/gu)).toHaveLength(1)
  })

  it('drops the rows that are gone from the screen a second later', () => {
    const items: TranscriptItem[] = [
      { ...base(60), kind: 'status', statusKind: 'compaction', text: 'Compacting…' },
      { ...base(70), kind: 'user', text: 'Still here.' }
    ]

    const { markdown } = exportTranscript(items, OPTIONS)

    // A file of transient one-liners is a file of things that are no longer
    // true.
    expect(markdown).not.toContain('Compacting')
    expect(markdown).toContain('Still here.')
  })

  it('exports exactly the items it was handed, hidden rows included or not', () => {
    // The contract this package cannot check for itself, stated here so the
    // caller cannot quietly change it: the input is the VISIBLE list, so a chat
    // filtered to Quiet exports the quiet conversation.
    const visible: TranscriptItem[] = [{ ...base(60), kind: 'user', text: 'Only me.' }]

    expect(exportTranscript(visible, OPTIONS).markdown).toContain('Only me.')
    expect(exportTranscript([], OPTIONS).markdown).toBe('# Researcher\n')
  })

  it('names the bot-to-bot lines without making either bot the speaker', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        dispatch: { status: 'queued' },
        kind: 'bot_dm_out',
        message: 'Draft the summary.',
        reply: { text: 'Done.' },
        target: '@writer',
        targetHandle: 'writer',
        toolId: 'd1'
      },
      { ...base(70), kind: 'bot_dm_in', senderName: 'Writer', senderHandle: 'writer', text: 'Anything else?' }
    ]

    const { markdown } = exportTranscript(items, OPTIONS)

    expect(markdown).toContain('> 00:01 · Message to @writer: Draft the summary.')
    expect(markdown).toContain('> Reply: Done.')
    // An inbound message IS speech, and it is attributed to whoever sent it.
    expect(markdown).toContain('**Writer**')
  })

  it('stamps nothing when the caller has no clock to lend', () => {
    const items: TranscriptItem[] = [{ ...base(60), kind: 'user', text: 'Hello.' }]

    expect(exportTranscript(items, { botName: 'Researcher' }).markdown).toBe('# Researcher\n\n**You**\n\nHello.\n')
  })

  it('heads the file with the bot and, when it knows, when it was taken', () => {
    const { markdown, text } = exportTranscript([], { ...OPTIONS, exportedAt: 3_600 })

    expect(markdown).toContain('_Exported 01:00_')
    expect(text).toContain('Exported 01:00')
  })
})

describe('who a `user` row is exported under (HERM-83, Task 5)', () => {
  const ME = 'authentik:me'
  const WRITER: MessageAuthor = { id: 'authentik:writer', name: 'Robin' }
  const RESEARCHER_AUTHOR: MessageAuthor = { id: 'authentik:researcher-person', name: 'Sam' }

  // A stand-in for `fallbackSenderName` (chat-ui/format.ts): this package
  // cannot import the chat kit, so the resolver is always the caller's — the
  // same shape `TranscriptContext.resolveSenderName` and `preview.ts`'s
  // `ChatPreviewOptions.resolveSenderName` already take.
  const resolveSenderName = (author: MessageAuthor): string => author.name ?? author.id

  const GROUP_OPTIONS = { ...OPTIONS, groupChat: true, ownAuthorId: ME, resolveSenderName }

  it('carries both names when two people share the group chat', () => {
    const items: TranscriptItem[] = [
      { ...base(60), author: WRITER, kind: 'user', text: 'Draft the summary.' },
      { ...base(120), author: RESEARCHER_AUTHOR, kind: 'user', text: 'Already on it.' }
    ]

    const { markdown, text } = exportTranscript(items, GROUP_OPTIONS)

    expect(markdown).toContain('**Robin**')
    expect(markdown).toContain('Draft the summary.')
    expect(markdown).toContain('**Sam**')
    expect(markdown).toContain('Already on it.')
    expect(text).toContain('Robin:')
    expect(text).toContain('Sam:')
  })

  it('keeps the reader’s own attributed row under `selfName`', () => {
    const items: TranscriptItem[] = [{ ...base(60), author: { id: ME, name: 'Me' }, kind: 'user', text: 'ship it' }]

    expect(exportTranscript(items, GROUP_OPTIONS).markdown).toContain('**You**')
  })

  it('keeps an unattributed row under `selfName`, even in the group chat', () => {
    const items: TranscriptItem[] = [{ ...base(60), kind: 'user', text: 'from before the stamp existed' }]

    expect(exportTranscript(items, GROUP_OPTIONS).markdown).toContain('**You**')
  })

  it('never names anybody outside the group chat, even with everything else known', () => {
    const items: TranscriptItem[] = [{ ...base(60), author: WRITER, kind: 'user', text: 'Draft the summary.' }]

    const { markdown } = exportTranscript(items, { ...GROUP_OPTIONS, groupChat: false })

    expect(markdown).not.toContain('**Robin**')
    expect(markdown).toContain('**You**')
  })

  it('leaves every row under `selfName` when the caller has no resolver to name one with', () => {
    const items: TranscriptItem[] = [{ ...base(60), author: WRITER, kind: 'user', text: 'Draft the summary.' }]

    const { markdown } = exportTranscript(items, { ...OPTIONS, groupChat: true, ownAuthorId: ME })

    expect(markdown).not.toContain('**Robin**')
    expect(markdown).toContain('**You**')
  })

  it('exports exactly as before when the caller passes none of the new options', () => {
    const items: TranscriptItem[] = [{ ...base(60), author: WRITER, kind: 'user', text: 'Draft the summary.' }]

    expect(exportTranscript(items, OPTIONS).markdown).toContain('**You**')
  })

  describe('a row an agent sent on somebody’s behalf', () => {
    const VIA = { kind: 'mcp', client: 'Claude Code' }

    it('carries the marker on the reader’s own row: `You via Claude Code`', () => {
      const items: TranscriptItem[] = [
        {
          ...base(60),
          author: { id: ME, name: 'Me', via: VIA },
          kind: 'user',
          text: 'summarise the open pull requests'
        }
      ]

      const { markdown, text } = exportTranscript(items, GROUP_OPTIONS)

      expect(markdown).toContain('**You via Claude Code**')
      expect(text).toContain('You via Claude Code:')
    })

    it('carries the marker outside the group chat, where every row is the reader’s', () => {
      const items: TranscriptItem[] = [
        {
          ...base(60),
          author: { id: ME, name: 'Me', via: VIA },
          kind: 'user',
          text: 'summarise the open pull requests'
        }
      ]

      expect(exportTranscript(items, OPTIONS).markdown).toContain('**You via Claude Code**')
    })

    it('names a colleague’s agent row `<name> via <client>` in the group chat', () => {
      const items: TranscriptItem[] = [
        { ...base(60), author: { ...WRITER, via: VIA }, kind: 'user', text: 'Draft the summary.' }
      ]

      expect(exportTranscript(items, GROUP_OPTIONS).markdown).toContain('**Robin via Claude Code**')
    })

    it('escapes the client like any other person’s text, and keeps `via` plain', () => {
      const items: TranscriptItem[] = [
        { ...base(60), author: { id: ME, via: { kind: 'mcp', client: 'My_*Agent*' } }, kind: 'user', text: 'hi' }
      ]

      const { markdown, text } = exportTranscript(items, GROUP_OPTIONS)

      expect(markdown).toContain('**You via My\\_\\*Agent\\***')
      expect(text).toContain('You via My_*Agent*:')
    })
  })
})

/*
  A name is somebody else's text, and in the `.md` file it sits inside
  `**…**`. Unescaped, a `*` closes the bold early, a `[x](y)` becomes a link,
  and a `<b>` becomes markup in any renderer that allows HTML. The `.txt` file
  is plain text and keeps the name exactly as shown in the app.
*/
describe('a sender name in the Markdown export', () => {
  const ME = 'authentik:me'
  const resolveSenderName = (author: MessageAuthor): string => author.name ?? author.id
  const GROUP_OPTIONS = { ...OPTIONS, groupChat: true, ownAuthorId: ME, resolveSenderName }

  it('escapes Markdown in a person’s name', () => {
    const items: TranscriptItem[] = [
      {
        ...base(60),
        author: { id: 'authentik:x', name: '*Robin_[site](https://example.test)` <b>#1' },
        kind: 'user',
        text: 'hi'
      }
    ]

    const { markdown, text } = exportTranscript(items, GROUP_OPTIONS)

    expect(markdown).toContain('**\\*Robin\\_\\[site\\]\\(https://example.test\\)\\` \\<b\\>\\#1**')
    expect(text).toContain('*Robin_[site](https://example.test)` <b>#1:')
  })

  it('escapes Markdown in a bot’s name too', () => {
    const items: TranscriptItem[] = [{ ...base(60), kind: 'assistant', text: 'done' } as TranscriptItem]

    const { markdown } = exportTranscript(items, { ...OPTIONS, botName: 'ops_*bot*' })

    expect(markdown).toContain('**ops\\_\\*bot\\***')
  })

  it('leaves an ordinary name exactly as it was', () => {
    const items: TranscriptItem[] = [
      { ...base(60), author: { id: 'authentik:x', name: 'Robin Vale' }, kind: 'user', text: 'hi' }
    ]

    expect(exportTranscript(items, GROUP_OPTIONS).markdown).toContain('**Robin Vale**')
  })
})

describe('naming the file', () => {
  it('reduces a bot name to something a file system will take', () => {
    expect(transcriptFileName('Researcher', 'md', '2026-09-22')).toBe('Researcher-2026-09-22.md')
    // A name with a slash in it would otherwise be a path.
    expect(transcriptFileName('ops/deploy', 'txt', '2026-09-22')).toBe('ops-deploy-2026-09-22.txt')
    expect(transcriptFileName('  ', 'md', '2026-09-22')).toBe('chat-2026-09-22.md')
    expect(transcriptFileName('日本語', 'md', '2026-09-22')).toBe('chat-2026-09-22.md')
  })
})
