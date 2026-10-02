/**
 * The memory browser: what it draws, what it sends, and what it refuses to do.
 *
 * The page is over a PLUGIN's routes rather than core's, so "connected" does
 * not imply "browsable" and the three states before there is a page at all are
 * as much the feature as the list is. They are asserted first, because getting
 * them wrong is the failure that sends somebody to install a plugin they
 * already have.
 *
 * The write assertions all come down to one line in `memory-controller.ts`: an
 * entry is named by its TEXT and not by its positional id. A memory file has no
 * ids — entries are `"\n§\n"`-joined text — so `memory:3` goes stale the moment
 * one above it is removed, and a write addressed by index would eventually
 * delete the entry that moved into that place.
 */
import { PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { MemoryScreen } from '../src/features/memory'
import { usePluginStore } from '../src/store/plugin'
import { useMemoryStore } from '../src/store/memory'
import { renderScreen } from './support/render'

/** Every REST call the page makes, and what the fake answers. */
const calls: { method: string; path: string; body?: unknown }[] = []
let listing: Record<string, unknown>
let searchAnswer: Record<string, unknown>
let editAnswer: Record<string, unknown> | (() => never)

const http = {
  get: jest.fn(async (path: string) => {
    calls.push({ method: 'GET', path })

    return path.includes('/search') ? searchAnswer : listing
  }),
  post: jest.fn(async (path: string, body: unknown) => {
    calls.push({ method: 'POST', path, body })

    if (typeof editAnswer === 'function') {
      return editAnswer()
    }

    return editAnswer
  })
}

jest.mock('../src/gateway', () => {
  const frozen = { http: null as unknown }

  return { useGateway: () => frozen, __setHttp: (value: unknown) => (frozen.http = value) }
})

function freshListing(): Record<string, unknown> {
  return {
    profile: 'researcher',
    targets: [
      {
        target: 'memory',
        entries: [
          { id: 'memory:0', target: 'memory', index: 0, text: 'Invoices go out on the first.', chars: 29, topics: [] },
          { id: 'memory:1', target: 'memory', index: 1, text: 'Prefers footnotes.', chars: 18, topics: [] }
        ],
        chars: 50,
        limit: 2200,
        percent: 2
      },
      {
        target: 'user',
        entries: [{ id: 'user:0', target: 'user', index: 0, text: 'Works from Utrecht.', chars: 19, topics: [] }],
        chars: 19,
        limit: 1375,
        percent: 1
      }
    ],
    providers: [
      { name: 'builtin', description: 'MEMORY.md and USER.md', available: true, enumerable: true },
      { name: 'mem0', description: 'mem0 (cloud)', available: true, enumerable: false }
    ]
  }
}

function advertWith(capabilities: string[]): void {
  usePluginStore.getState().apply({
    version: '0.5.0',
    capabilities,
    modules: { memory: 'on' },
    limits: {},
    updatedAt: 1
  })
}

async function page(): Promise<void> {
  renderScreen(<MemoryScreen onClose={() => undefined} profile="researcher" title="Researcher" />)
  await act(async () => undefined)
}

beforeEach(() => {
  calls.length = 0
  listing = freshListing()
  searchAnswer = { query: '', count: 0, results: [] }
  editAnswer = { success: true }
  useMemoryStore.getState().reset()
  usePluginStore.getState().reset()

  ;(require('../src/gateway') as { __setHttp: (value: unknown) => void }).__setHttp(http)

  advertWith([PLUGIN_CAPABILITIES.memoryBrowse, PLUGIN_CAPABILITIES.memoryEdit])
})

// -- before there is a page at all -------------------------------------------

describe('what the advert decides', () => {
  it('says nothing at all until a roster has arrived', async () => {
    usePluginStore.getState().reset()
    await page()

    expect(screen.getByTestId('memory-unknown')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('offers the install when the plugin carries no memory.browse', async () => {
    advertWith([PLUGIN_CAPABILITIES.pushExpo])
    await page()

    expect(screen.getByTestId('memory-missing')).toBeTruthy()
    expect(screen.getByTestId('memory-install')).toHaveTextContent(/hermes plugins install/)
    expect(screen.getByTestId('memory-guide')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('draws the list and no composers when memory.edit is missing', async () => {
    advertWith([PLUGIN_CAPABILITIES.memoryBrowse])
    await page()

    await waitFor(() => expect(screen.getByTestId('memory-read-only')).toBeTruthy())
    expect(screen.queryByTestId('memory-add-memory')).toBeNull()
    expect(screen.queryByTestId('memory-entry-memory:0-remove')).toBeNull()
    expect(screen.getByText('Invoices go out on the first.')).toBeTruthy()
  })
})

// -- the list ----------------------------------------------------------------

describe('the list', () => {
  it('asks for this profile and draws both files with their usage', async () => {
    await page()

    await waitFor(() => expect(screen.getByText('Works from Utrecht.')).toBeTruthy())
    expect(calls[0]?.path).toBe('/api/plugins/hermie/memory/list?profile=researcher')
    expect(screen.getByTestId('memory-usage-memory')).toHaveTextContent('50 of 2200 characters')
    expect(screen.getByTestId('memory-usage-user')).toHaveTextContent('19 of 1375 characters')
  })

  /** Two files with two limits; one merged list cannot answer "which is full". */
  it('keeps MEMORY and USER apart', async () => {
    await page()

    await waitFor(() => expect(screen.getByTestId('memory-section-memory')).toBeTruthy())
    expect(screen.getByTestId('memory-section-user')).toBeTruthy()
  })

  /**
   * An external provider offers `prefetch(query)` and no call that returns
   * entries, so it is named and never enumerated.
   */
  it('lists an external provider as not browsable', async () => {
    await page()

    await waitFor(() => expect(screen.getByTestId('memory-providers')).toBeTruthy())
    // `toHaveTextContent` is EXACT in this library, so a group whose text is the
    // header, the rows and the footer needs a pattern rather than a substring.
    expect(screen.getByTestId('memory-providers')).toHaveTextContent(/mem0/)
    expect(screen.getByTestId('memory-providers')).toHaveTextContent(/Not browsable/)
  })

  it('shows the route failing instead of an empty list', async () => {
    http.get.mockImplementationOnce(async () => {
      throw new Error('the gateway has no such endpoint')
    })
    await page()

    await waitFor(() => expect(screen.getByTestId('memory-error')).toBeTruthy())
  })
})

// -- search ------------------------------------------------------------------

describe('search', () => {
  it('goes to the plugin rather than filtering what is on screen', async () => {
    searchAnswer = {
      query: 'utrecht',
      count: 1,
      results: [{ id: 'user:0', target: 'user', index: 0, text: 'Works from Utrecht.', chars: 19, topics: [] }]
    }
    await page()
    await waitFor(() => expect(screen.getByTestId('memory-search')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('memory-search'), 'utrecht')

    await waitFor(() => expect(screen.getByTestId('memory-results')).toBeTruthy())
    expect(calls.map(call => call.path)).toContain('/api/plugins/hermie/memory/search?profile=researcher&q=utrecht')
    expect(screen.queryByTestId('memory-section-memory')).toBeNull()
  })

  it('says so when nothing matches, and puts the sections back when cleared', async () => {
    searchAnswer = { query: 'zzz', count: 0, results: [] }
    await page()
    await waitFor(() => expect(screen.getByTestId('memory-search')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('memory-search'), 'zzz')
    await waitFor(() => expect(screen.getByTestId('memory-no-results')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('memory-search'), '')
    await waitFor(() => expect(screen.getByTestId('memory-section-memory')).toBeTruthy())
  })
})

// -- the writes --------------------------------------------------------------

describe('editing', () => {
  it('adds an entry to the target whose composer was used, and re-reads', async () => {
    await page()
    await waitFor(() => expect(screen.getByTestId('memory-add-user')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('memory-add-user'), 'Answers fastest in the morning.')
    fireEvent.press(screen.getByTestId('memory-add-user-action'))

    await waitFor(() => expect(calls.some(call => call.method === 'POST')).toBe(true))
    expect(calls.find(call => call.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/plugins/hermie/memory/edit',
      body: { profile: 'researcher', target: 'user', op: 'add', content: 'Answers fastest in the morning.' }
    })
    // Every successful write refetches: the ids have shifted and the usage has
    // moved by the delimiter as well as by the text.
    await waitFor(() => expect(calls.filter(call => call.path.includes('/list'))).toHaveLength(2))
  })

  it('replaces an entry by its TEXT, not by its positional id', async () => {
    await page()
    await waitFor(() => expect(screen.getByTestId('memory-entry-memory:1-edit')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-entry-memory:1-edit'))
    fireEvent.changeText(screen.getByTestId('memory-entry-memory:1-editor'), 'Prefers footnotes to parentheses.')
    fireEvent.press(screen.getByTestId('memory-entry-memory:1-save'))

    await waitFor(() => expect(calls.some(call => call.method === 'POST')).toBe(true))
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({
      profile: 'researcher',
      target: 'memory',
      op: 'replace',
      content: 'Prefers footnotes to parentheses.',
      old_text: 'Prefers footnotes.',
      index: 1
    })
  })

  /** Hermes keeps no history of a memory file, so the question is asked once. */
  it('asks before removing, and sends the text it showed', async () => {
    await page()
    await waitFor(() => expect(screen.getByTestId('memory-entry-memory:0-remove')).toBeTruthy())

    fireEvent.press(screen.getByTestId('memory-entry-memory:0-remove'))
    expect(calls.some(call => call.method === 'POST')).toBe(false)

    fireEvent.press(screen.getByTestId('memory-entry-memory:0-confirm'))

    await waitFor(() => expect(calls.some(call => call.method === 'POST')).toBe(true))
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({
      profile: 'researcher',
      target: 'memory',
      op: 'remove',
      old_text: 'Invoices go out on the first.',
      index: 0
    })
  })

  /** The plugin hands back the store's own dict; the sentence is Hermes'. */
  it('shows the store’s own refusal rather than a sentence of ours', async () => {
    editAnswer = { success: false, error: 'that would exceed the character limit for this file' }
    await page()
    await waitFor(() => expect(screen.getByTestId('memory-add-memory')).toBeTruthy())

    fireEvent.changeText(screen.getByTestId('memory-add-memory'), 'x')
    fireEvent.press(screen.getByTestId('memory-add-memory-action'))

    await waitFor(() =>
      expect(screen.getByTestId('memory-notice')).toHaveTextContent(
        'that would exceed the character limit for this file'
      )
    )
    // A refused write is not a reason to re-read: the file did not change.
    expect(calls.filter(call => call.path.includes('/list'))).toHaveLength(1)
  })
})
