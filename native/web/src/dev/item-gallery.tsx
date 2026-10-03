/**
 * Development only: every kind of transcript item the engine has, in every
 * presentation its selectors can hand a row (`full`, `collapsed`, `chip`,
 * `hidden-placeholder`), drawn by the real item views. To look at in a browser
 * and to run the accessibility checker over (`item-gallery.axe.test.tsx`).
 *
 * Under the items, what the views draw inside a row and around the transcript:
 * attachments as chips and as pictures (the ones "sent from this page" are tiny
 * `data:` images, as the attachment tray makes them), a file chip in each of
 * its states, diffs, and the chat's options. Every message on the page is
 * reached by the transcript's one message menu (`MessageMenuLayer`): hover one,
 * right-click it, or move to it with the arrow keys from a message and press
 * Enter. A picture opens in the image viewer.
 *
 *   npm run client:dev, then open /dev/items.html
 *
 * The items are literals: no engine, no gateway. A presentation the selectors
 * never produce for a kind is drawn anyway, because a view must not break on
 * one. Nothing under `src/` outside this directory and the tests imports this
 * file, and the build's only input is `index.html`, so none of it reaches
 * `dist/` (`markdown-fixtures.excluded.test.ts` keeps it that way; the bundle
 * gate refuses the marker below if it ever did).
 */
import type { Presentation, TranscriptItem, VisibleItem } from '@hermie/transcript'
import { useMemo, useRef, useState } from 'react'

import { ChatOptions } from '../features/chat/ChatOptions'
import { rollupDmRuns } from '../features/chat/dm-rollup'
import { ImageViewer } from '../features/chat/ImageViewer'
import { ChatItem } from '../features/chat/items/ChatItem'
import { DiffView } from '../features/chat/items/DiffView'
import { FileChip } from '../features/chat/items/FileChip'
import { ItemContext, type ItemContextValue } from '../features/chat/items/item-context'
import { DETACHED_ITEM_HOST, type ItemHost, ItemHostContext, type ViewedImage } from '../features/chat/items/item-host'
import { attachmentName } from '../features/chat/items/UserBubble'
import { MessageMenuLayer } from '../features/chat/MessageMenu'

/** The bundle gate refuses any file holding this (`scripts/web/check-bundle.mjs`). */
const DEVELOPMENT_ONLY_MARKER = 'hermie:development-only'

/** Stands in for a gateway; nothing is requested from it. */
const GALLERY_GATEWAY = 'http://gateway.example.test'

/** Unix seconds: a fixed afternoon, so the clocks on the page do not move. */
const AT = 1_759_500_000

export const PRESENTATIONS: readonly Presentation[] = ['full', 'collapsed', 'chip', 'hidden-placeholder']

let counter = 0

const base = (kind: TranscriptItem['kind'], name: string) => {
  counter += 1

  return { id: `gallery-${kind}-${name}`, seq: counter * 1000, origin: 'history' as const, version: 1, ts: AT }
}

export interface GalleryCase {
  /** What this case shows, under the kind's heading. */
  name: string
  item: TranscriptItem
}

export interface GallerySection {
  id: string
  title: string
  cases: GalleryCase[]
}

export const GALLERY_SECTIONS: readonly GallerySection[] = [
  {
    id: 'user',
    title: 'User',
    cases: [
      { name: 'plain', item: { ...base('user', 'plain'), kind: 'user', text: 'Can you look into **this**?' } },
      {
        name: 'with attachments, sending',
        item: {
          ...base('user', 'files'),
          kind: 'user',
          text: 'Here are the files.',
          attachments: ['@file:/srv/work/report.pdf', '@image:/tmp/shot.png'],
          pending: true
        }
      },
      {
        name: 'files only, one with a long name',
        item: {
          ...base('user', 'files-only'),
          kind: 'user',
          text: 'The report and the data behind it.',
          attachments: ['@file:/srv/work/quarterly-report-of-the-finance-team-final-v4.pdf', '@file:/srv/work/data.csv']
        }
      },
      {
        name: 'a picture sent from this page',
        item: {
          ...base('user', 'one-picture'),
          kind: 'user',
          text: 'One screenshot.',
          attachments: ['@image:screenshot.png']
        }
      },
      {
        name: 'three pictures and a file',
        item: {
          ...base('user', 'pictures'),
          kind: 'user',
          text: 'Three pictures and a file.',
          attachments: ['@image:first.png', '@image:second.png', '@image:third.png', '@file:/srv/work/notes.md']
        }
      }
    ]
  },
  {
    id: 'assistant',
    title: 'Assistant',
    cases: [
      {
        name: 'a reply with usage',
        item: {
          ...base('assistant', 'reply'),
          kind: 'assistant',
          text: 'Here is what I found:\n\n- one\n- two',
          streaming: false,
          interim: false,
          durationS: 12.4,
          usage: { input: 1200, output: 340, model: 'acme-large-2' } as never
        }
      },
      {
        name: 'with a thought',
        item: {
          ...base('assistant', 'thought'),
          kind: 'assistant',
          text: 'The answer is 42.',
          reasoning: 'The question asks for the answer.\nIt is well known.',
          streaming: false,
          interim: false,
          durationS: 3
        }
      },
      {
        name: 'still thinking',
        item: {
          ...base('assistant', 'thinking'),
          kind: 'assistant',
          text: '',
          reasoning: 'Weighing the options',
          streaming: true,
          interim: false
        }
      },
      {
        name: 'failed, retryable',
        item: {
          ...base('assistant', 'failed'),
          kind: 'assistant',
          text: 'Partial words that arrived',
          streaming: false,
          interim: false,
          status: 'error',
          error: { message: 'The model provider returned an error.', partial: true }
        }
      },
      {
        name: 'failed, recoverable',
        item: {
          ...base('assistant', 'recoverable'),
          kind: 'assistant',
          text: '',
          streaming: false,
          interim: false,
          status: 'error',
          error: { message: 'Connection lost.', partial: false, recoverable: true }
        }
      }
    ]
  },
  {
    id: 'tool',
    title: 'Tool',
    cases: [
      {
        name: 'complete',
        item: {
          ...base('tool', 'complete'),
          kind: 'tool',
          toolId: 'call-1',
          name: 'read_file',
          args: { path: 'README.md' },
          status: 'complete',
          resultKnown: true,
          result: { output: '# Project\n\nA readme.' },
          summary: 'read README.md',
          durationS: 0.4
        }
      },
      {
        name: 'running',
        item: {
          ...base('tool', 'running'),
          kind: 'tool',
          toolId: 'call-2',
          name: 'run_command',
          context: 'npm test',
          status: 'running',
          resultKnown: false
        }
      },
      {
        name: 'a patch',
        item: {
          ...base('tool', 'patch'),
          kind: 'tool',
          toolId: 'call-3',
          name: 'patch',
          status: 'complete',
          resultKnown: true,
          inlineDiff: '--- a/x.ts\n+++ b/x.ts\n-const a = 1\n+const a = 2',
          summary: 'edited x.ts'
        }
      },
      {
        name: 'failed, flagged output',
        item: {
          ...base('tool', 'failed'),
          kind: 'tool',
          toolId: 'call-4',
          name: 'mcp__browser__fetch',
          status: 'error',
          isError: true,
          resultKnown: true,
          result: { error: 'permission denied' },
          outputRisk: { risk: 'prompt injection', findings: ['asks to ignore rules'], redacted: true }
        }
      }
    ]
  },
  {
    id: 'bot-dm',
    title: 'Bot to bot',
    cases: [
      {
        name: 'inbound',
        item: {
          ...base('bot_dm_in', 'inbound'),
          kind: 'bot_dm_in',
          senderName: 'Writer',
          senderHandle: 'writer',
          text: 'The draft is ready. See **notes.md**.'
        }
      },
      {
        name: 'outbound, waiting',
        item: {
          ...base('bot_dm_out', 'waiting'),
          kind: 'bot_dm_out',
          toolId: 'call-5',
          target: '@writer',
          targetHandle: 'writer',
          message: 'Please draft the release notes.',
          dispatch: { status: 'queued' }
        }
      },
      {
        name: 'outbound, replied',
        item: {
          ...base('bot_dm_out', 'replied'),
          kind: 'bot_dm_out',
          toolId: 'call-6',
          target: '@builder',
          targetHandle: 'builder',
          message: 'Build the site.',
          dispatch: { status: 'queued' },
          reply: { text: 'Built. All **green**.' }
        }
      },
      {
        name: 'outbound, failed',
        item: {
          ...base('bot_dm_out', 'failed'),
          kind: 'bot_dm_out',
          toolId: 'call-7',
          target: '@ghost',
          targetHandle: 'ghost',
          message: 'Are you there?',
          dispatch: { status: 'failed', error: 'No bot is called ghost.' }
        }
      }
    ]
  },
  {
    id: 'cron',
    title: 'Cron delivery',
    cases: [
      {
        name: 'a report',
        item: {
          ...base('cron_delivery', 'report'),
          kind: 'cron_delivery',
          jobName: 'Source scan',
          body: 'Nothing new **today**.',
          shape: 'bot_chat'
        }
      },
      {
        name: 'redacted name, empty report',
        item: {
          ...base('cron_delivery', 'redacted'),
          kind: 'cron_delivery',
          jobName: '[REDACTED]',
          nameRedacted: true,
          body: '',
          shape: 'mirror'
        }
      }
    ]
  },
  {
    id: 'subagents',
    title: 'Subagent group',
    cases: [
      {
        name: 'running',
        item: {
          ...base('subagent_group', 'running'),
          kind: 'subagent_group',
          goals: ['Read the three papers and summarise each one in a paragraph', 'Check the citations'],
          rootIds: [],
          status: 'running'
        }
      },
      {
        name: 'done',
        item: {
          ...base('subagent_group', 'done'),
          kind: 'subagent_group',
          goals: ['Look it up'],
          rootIds: [],
          status: 'done',
          completion: 'All goals finished.'
        }
      }
    ]
  },
  {
    id: 'notice',
    title: 'Notice',
    cases: [
      {
        name: 'model switch (a system line)',
        item: {
          ...base('notice', 'model'),
          kind: 'notice',
          noticeKind: 'model_switch',
          title: 'Model changed',
          body: 'Now running acme-large. From this point forward, use this runtime metadata.'
        }
      },
      {
        name: 'process complete',
        item: {
          ...base('notice', 'process'),
          kind: 'notice',
          noticeKind: 'process_complete',
          title: 'Background process finished',
          body: 'exit 0'
        }
      },
      {
        name: 'command answer',
        item: {
          ...base('notice', 'command'),
          kind: 'notice',
          noticeKind: 'command',
          title: '/help',
          body: 'Commands: /model, /new'
        }
      },
      {
        name: 'error',
        item: { ...base('notice', 'error'), kind: 'notice', noticeKind: 'error', title: 'The gateway restarted' }
      }
    ]
  },
  {
    id: 'status',
    title: 'Status',
    cases: [
      {
        name: 'compaction',
        item: { ...base('status', 'compaction'), kind: 'status', statusKind: 'context.compaction', text: 'Compacting' }
      }
    ]
  },
  {
    id: 'requests',
    title: 'Requests',
    cases: [
      {
        name: 'approval',
        item: {
          ...base('approval', 'open'),
          kind: 'approval',
          requestId: 'srq-1',
          approvalId: 'a-1',
          command: 'rm -rf build',
          choices: ['once', 'deny'],
          state: 'open'
        }
      },
      {
        name: 'clarify',
        item: {
          ...base('clarify', 'open'),
          kind: 'clarify',
          requestId: 'srq-2',
          questions: [{ qid: 'q1', question: 'Which branch?', multiSelect: false }],
          answers: {},
          locked: [],
          state: 'open'
        }
      }
    ]
  }
]

/** Five asides in a row, both directions: the roll-up the screen draws for them. */
export const GALLERY_ROLLUP: VisibleItem = (() => {
  const asides = (['a', 'b', 'c', 'd', 'e'] as const).map((name, index): VisibleItem => ({
    presentation: 'collapsed',
    item:
      index % 2 === 0
        ? {
            ...base('bot_dm_out', `run-${name}`),
            kind: 'bot_dm_out',
            toolId: `call-run-${name}`,
            target: '@writer',
            targetHandle: 'writer',
            message: `Step ${index + 1}, please.`,
            dispatch: { status: 'queued' },
            ...(index < 4 ? { reply: { text: `Step ${index + 1} done.` } } : {})
          }
        : {
            ...base('bot_dm_in', `run-${name}`),
            kind: 'bot_dm_in',
            senderName: 'Writer',
            senderHandle: 'writer',
            text: `Working on step ${index}.`
          }
  }))

  return rollupDmRuns(asides)[0] as VisibleItem
})()

/** A picture the attachment tray could have made: a raster `data:` image, so nothing is requested from anywhere. */
const PICTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

/** The pictures "sent from this page", by file name (`sent-previews.ts` in the app). */
const SENT_PICTURES: Readonly<Record<string, string>> = {
  'screenshot.png': PICTURE,
  'first.png': PICTURE,
  'second.png': PICTURE,
  'third.png': PICTURE
}

const DIFF = [
  '--- a/src/greeting.ts',
  '+++ b/src/greeting.ts',
  '@@ -1,5 +1,6 @@',
  ' export function greet(name: string): string {',
  "-  return 'Hello ' + name",
  '+  const cleaned = name.trim()',
  "+  return 'Hello, ' + cleaned + '!'",
  ' }',
  ' ',
  ' export const version = 2'
].join('\n')

const LONG_DIFF = Array.from({ length: 40 }, (_, index) => `+line ${index + 1} of a long addition`).join('\n')

/** The sections under the items: what the views draw inside a row and around the transcript. */
export const MEDIA_SECTIONS = ['chips', 'diffs', 'options'] as const

/** Every item on the page by id, for the message menu. */
const GALLERY_ITEMS: ReadonlyMap<string, TranscriptItem> = new Map(
  GALLERY_SECTIONS.flatMap(section => section.cases.map(entry => [entry.item.id, entry.item] as const))
)

const CONTEXT: ItemContextValue = {
  botName: 'Researcher',
  gatewayBaseUrl: GALLERY_GATEWAY,
  ownAuthorId: undefined,
  groupChat: false
}

function Presentations({ id, item }: { id: string; item: TranscriptItem }) {
  return (
    <>
      {PRESENTATIONS.map(presentation => (
        <div className="gallery__case" key={presentation} data-presentation={presentation}>
          <h4 className="gallery__label">{presentation}</h4>
          <div className="gallery__row" id={`gallery-${id}-${presentation}`}>
            <ChatItem row={{ item, presentation }} />
          </div>
        </div>
      ))}
    </>
  )
}

export function ItemGalleryPage() {
  const stage = useRef<HTMLDivElement>(null)
  const [viewing, setViewing] = useState<{ image: ViewedImage; opener: HTMLElement | null } | null>(null)
  const [notice, setNotice] = useState('')
  const host = useMemo<ItemHost>(
    () => ({
      ...DETACHED_ITEM_HOST,
      attachmentSrc: reference => SENT_PICTURES[attachmentName(reference)],
      itemById: id => GALLERY_ITEMS.get(id),
      openImage: (image, opener) => setViewing({ image, opener }),
      announce: setNotice,
      regenerate: () => setNotice('Regenerate was asked for.'),
      regenerateTarget: () => 'gallery-assistant-reply'
    }),
    []
  )

  return (
    <ItemContext.Provider value={CONTEXT}>
      <ItemHostContext.Provider value={host}>
        <main className="gallery" data-marker={DEVELOPMENT_ONLY_MARKER}>
          <div ref={stage}>
            <h1>Transcript items</h1>
            {GALLERY_SECTIONS.map(section => (
              <section aria-labelledby={`gallery-${section.id}`} key={section.id}>
                <h2 id={`gallery-${section.id}`}>{section.title}</h2>
                {section.cases.map(entry => (
                  <section aria-label={`${section.title}: ${entry.name}`} key={entry.item.id}>
                    <h3>{entry.name}</h3>
                    <Presentations id={entry.item.id} item={entry.item} />
                  </section>
                ))}
              </section>
            ))}
            <section aria-labelledby="gallery-rollup">
              <h2 id="gallery-rollup">Roll-up of bot-to-bot asides</h2>
              <div className="gallery__row" id="gallery-rollup-row">
                <ChatItem row={GALLERY_ROLLUP} />
              </div>
            </section>

            <section aria-labelledby="gallery-chips" id="gallery-media-chips">
              <h2 id="gallery-chips">File chips</h2>
              <ul className="gallery__chips">
                <li>
                  <FileChip name="report.pdf" size={1_536_000} />
                </li>
                <li>
                  <FileChip name="a-very-long-file-name-that-has-to-give-way-in-the-middle.xlsx" size={20_480} />
                </li>
                <li>
                  <FileChip name={'\u0645\u0644\u0641-\u0639\u0631\u0628\u064a.txt'} size={12} />
                </li>
                <li>
                  <FileChip
                    name="uploading.zip"
                    status="uploading"
                    progress={0.4}
                    onRemove={() => setNotice('Removed.')}
                  />
                </li>
                <li>
                  <FileChip name="waiting.zip" status="uploading" onRemove={() => setNotice('Removed.')} />
                </li>
                <li>
                  <FileChip
                    name="huge.mov"
                    status="error"
                    error="Too large · 20 MB max"
                    onRemove={() => setNotice('Removed.')}
                  />
                </li>
                <li>
                  <FileChip name="openable.txt" size={2048} onOpen={() => setNotice('Opened.')} />
                </li>
              </ul>
            </section>

            <section aria-labelledby="gallery-diffs" id="gallery-media-diffs">
              <h2 id="gallery-diffs">Diffs</h2>
              <DiffView diff={DIFF} />
              <DiffView diff={LONG_DIFF} maxLines={12} />
            </section>

            <section aria-labelledby="gallery-options" id="gallery-media-options">
              <h2 id="gallery-options">Chat options</h2>
              <ChatOptions bot="gallery" />
            </section>

            <MessageMenuLayer container={stage} host={host} />
          </div>
          <p role="status" className="hm-sr">
            {notice}
          </p>
        </main>

        {viewing ? (
          <ImageViewer
            image={viewing.image}
            opener={viewing.opener}
            gatewayBaseUrl={GALLERY_GATEWAY}
            onClose={() => setViewing(null)}
          />
        ) : null}
      </ItemHostContext.Provider>
    </ItemContext.Provider>
  )
}
