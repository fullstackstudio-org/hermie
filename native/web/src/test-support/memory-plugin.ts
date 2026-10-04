/**
 * The Hermie plugin's memory routes in memory, for the Memory page's tests: one set of files per profile, and the
 * four routes the page uses (`/api/plugins/hermie/memory/{list,search,raw,edit}`), in the shapes the plugin and
 * `packages/fake-gateway` serve.
 */
import { aManageTransport, httpFailure } from './manage-transport'

export const MEMORY_BASE = '/api/plugins/hermie/memory'

export type Files = Record<'memory' | 'user', string[]>

/** A plugin that holds one set of files per profile and answers the routes the page uses. */
export function aMemoryPlugin(initial: Record<string, Files> = {}) {
  const files: Record<string, Files> = {
    researcher: { memory: ['Northwind invoices monthly.', 'Prefers footnotes.'], user: ['Robin lives in Lisbon.'] },
    writer: { memory: ['Drafts open with the verb.'], user: [] },
    ...initial
  }
  let refuse: string | null = null
  let rawStatus = 200

  const rows = (profile: string, target: 'memory' | 'user') =>
    files[profile]![target].map((text, index) => ({
      id: `${target}:${index}`,
      target,
      index,
      text,
      chars: text.length
    }))

  const transport = aManageTransport({
    [`GET ${MEMORY_BASE}/list`]: ({ query }) => {
      const profile = query.get('profile') ?? ''

      return {
        profile,
        targets: (['memory', 'user'] as const).map(target => ({
          target,
          entries: rows(profile, target),
          chars: files[profile]![target].join('\n§\n').length,
          limit: 2200,
          percent: 10
        })),
        providers: [
          { name: 'builtin', description: 'MEMORY.md and USER.md', available: true, enumerable: true },
          { name: 'mem0', description: 'mem0 (cloud)', available: true, enumerable: false }
        ]
      }
    },
    [`GET ${MEMORY_BASE}/search`]: ({ query }) => {
      const profile = query.get('profile') ?? ''
      const words = (query.get('q') ?? '').toLowerCase().split(/\s+/u)
      const results = (['memory', 'user'] as const)
        .flatMap(target => rows(profile, target))
        .filter(row => words.every(word => row.text.toLowerCase().includes(word)))

      return { query: query.get('q'), count: results.length, results }
    },
    [`GET ${MEMORY_BASE}/raw`]: ({ query }) => {
      if (rawStatus !== 200) {
        throw httpFailure(rawStatus)
      }

      const profile = query.get('profile') ?? ''

      return {
        profile,
        backends: [
          {
            name: 'builtin',
            label: 'MEMORY.md and USER.md',
            available: true,
            editable: true,
            note: null,
            documents: [
              {
                id: 'memory',
                label: 'MEMORY.md',
                content: files[profile]!.memory.join('\n§\n'),
                chars: 10,
                truncated: false
              },
              { id: 'user', label: 'USER.md', content: '', chars: 0, truncated: false }
            ]
          },
          {
            name: 'mem0',
            label: 'mem0 (cloud)',
            available: true,
            editable: false,
            documents: [],
            note: 'mem0 lists nothing.'
          }
        ]
      }
    },
    [`POST ${MEMORY_BASE}/edit`]: ({ body }) => {
      const write = body as {
        profile: string
        target: 'memory' | 'user'
        op: string
        content?: string
        old_text?: string
      }

      if (refuse) {
        return { success: false, error: refuse }
      }

      const list = files[write.profile]![write.target]

      if (write.op === 'add') {
        list.push(write.content ?? '')
      } else if (write.op === 'replace') {
        list[list.indexOf(write.old_text ?? '')] = write.content ?? ''
      } else {
        list.splice(list.indexOf(write.old_text ?? ''), 1)
      }

      return { success: true }
    }
  })

  return {
    ...transport,
    files,
    refuseWith: (text: string) => {
      refuse = text
    },
    rawAnswers: (status: number) => {
      rawStatus = status
    }
  }
}
