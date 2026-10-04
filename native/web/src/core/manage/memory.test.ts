/**
 * The memory routes' readers and writes: both targets are always there, a write names the entry by its text and
 * its position, and a refusal is a sentence rather than a throw.
 */
import { describe, expect, it } from 'vitest'

import { aManageTransport, httpFailure } from '../../test-support/manage-transport'
import { createMemoryClient, memoryListingOf, memoryRawOf, memorySearchOf, memoryWriteOf } from './memory'
import { routeErrorOf } from './route-error'

describe('memoryListingOf', () => {
  it('always names both files, in the plugin’s order, even when the answer holds one or none', () => {
    expect(
      memoryListingOf({ targets: [{ target: 'user', entries: [{ text: 'a' }], chars: 1, limit: 10, percent: 10 }] })
    ).toMatchObject({
      sections: [
        { target: 'memory', entries: [], chars: 0, limit: 0 },
        { target: 'user', entries: [{ id: 'user:0', index: 0, text: 'a', chars: 1 }], chars: 1, limit: 10 }
      ]
    })
    expect(memoryListingOf(null).sections.map(section => section.target)).toEqual(['memory', 'user'])
  })

  it('keeps the store’s own character count and falls back to the text’s length only when none came', () => {
    const listing = memoryListingOf({
      targets: [{ target: 'memory', entries: [{ text: 'abc', chars: 7 }, { text: 'abc' }] }]
    })

    expect(listing.sections[0]?.entries.map(entry => entry.chars)).toEqual([7, 3])
  })

  it('reads the providers, and an external one is not enumerable unless it says so', () => {
    expect(
      memoryListingOf({
        providers: [{ name: 'mem0' }, { name: 'builtin', enumerable: true }, { description: 'no name' }]
      }).providers
    ).toEqual([
      { name: 'mem0', description: '', available: true, enumerable: false },
      { name: 'builtin', description: '', available: true, enumerable: true }
    ])
  })
})

describe('the other readers', () => {
  it('reads a search as one list, and a write as the store’s own dict', () => {
    expect(memorySearchOf({ results: [{ target: 'user', index: 2, text: 'x' }] })).toEqual([
      { id: 'user:2', target: 'user', index: 2, text: 'x', chars: 1 }
    ])
    expect(memoryWriteOf({ success: true })).toEqual({ success: true, error: null })
    expect(memoryWriteOf({ success: false, error: 'over the limit' })).toEqual({
      success: false,
      error: 'over the limit'
    })
    expect(memoryWriteOf('nonsense')).toEqual({ success: false, error: null })
  })

  it('reads the raw backends: a provider with no documents is available with a note', () => {
    expect(
      memoryRawOf({
        backends: [
          { name: 'builtin', documents: [{ label: 'MEMORY.md', content: 'x', truncated: true }] },
          { name: 'mem0', label: 'mem0 (cloud)', note: 'lists nothing' },
          { label: 'nameless' }
        ]
      })
    ).toEqual([
      {
        name: 'builtin',
        label: 'builtin',
        available: true,
        note: null,
        documents: [{ id: 'MEMORY.md', label: 'MEMORY.md', content: 'x', chars: 1, truncated: true }]
      },
      { name: 'mem0', label: 'mem0 (cloud)', available: true, note: 'lists nothing', documents: [] }
    ])
  })
})

describe('the client', () => {
  it('names the profile on every route, encoded', async () => {
    const { transport, requests } = aManageTransport({
      'GET /api/plugins/hermie/memory/list': () => ({}),
      'GET /api/plugins/hermie/memory/search': () => ({ results: [] }),
      'GET /api/plugins/hermie/memory/raw': () => ({})
    })
    const client = createMemoryClient(transport.http, 'my bot')

    await client.list()
    await client.search('a b&c')
    await client.raw()

    expect(requests.map(request => request.path)).toEqual([
      '/api/plugins/hermie/memory/list?profile=my%20bot',
      '/api/plugins/hermie/memory/search?profile=my%20bot&q=a%20b%26c',
      '/api/plugins/hermie/memory/raw?profile=my%20bot'
    ])
  })

  it('sends an entry’s text and position with a replace and a remove, and the profile with every write', async () => {
    const { transport, requests } = aManageTransport({
      'POST /api/plugins/hermie/memory/edit': () => ({ success: true })
    })
    const client = createMemoryClient(transport.http, 'researcher')
    const entry = { id: 'memory:3', target: 'memory', index: 3, text: 'old', chars: 3 } as const

    await client.add('user', 'new')
    await client.replace(entry, 'newer')
    await client.remove(entry)

    expect(requests.map(request => request.body)).toEqual([
      { profile: 'researcher', target: 'user', op: 'add', content: 'new' },
      { profile: 'researcher', target: 'memory', op: 'replace', content: 'newer', old_text: 'old', index: 3 },
      { profile: 'researcher', target: 'memory', op: 'remove', old_text: 'old', index: 3 }
    ])
  })

  it('answers a refused write as a sentence, not a throw, and a failed read as a RouteError with its status', async () => {
    const { transport } = aManageTransport({
      'POST /api/plugins/hermie/memory/edit': () => {
        throw httpFailure(409, 'the entry has moved')
      }
    })
    const client = createMemoryClient(transport.http, 'researcher')

    expect(await client.add('memory', 'x')).toEqual({ success: false, error: 'the entry has moved' })
    await expect(client.list()).rejects.toMatchObject({ status: 404, name: 'RouteError' })
  })
})

describe('routeErrorOf', () => {
  it('prefers the body’s own sentence to the classification, keeps the status, and passes a RouteError through', () => {
    const error = routeErrorOf(httpFailure(409, 'blocked by parent'))

    expect(error).toMatchObject({ message: 'blocked by parent', status: 409 })
    expect(routeErrorOf(error)).toBe(error)
    expect(routeErrorOf(new Error('boom')).message).toBe('boom')
    expect(routeErrorOf('text').message).toBe('text')
    expect(routeErrorOf(Object.assign(new Error('refused'), { code: 4017 })).code).toBe(4017)
  })
})
