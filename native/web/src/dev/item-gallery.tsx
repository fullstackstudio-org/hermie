/**
 * Development only: every kind of transcript item the engine has, in every
 * presentation its selectors can hand a row (`full`, `collapsed`, `chip`,
 * `hidden-placeholder`), drawn by the real item views. To look at in a browser
 * and to run the accessibility checker over (`item-gallery.axe.test.tsx`).
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

import { rollupDmRuns } from '../features/chat/dm-rollup'
import { ChatItem } from '../features/chat/items/ChatItem'
import { ItemContext, type ItemContextValue } from '../features/chat/items/item-context'

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
  return (
    <ItemContext.Provider value={CONTEXT}>
      <main className="gallery" data-marker={DEVELOPMENT_ONLY_MARKER}>
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
      </main>
    </ItemContext.Provider>
  )
}
