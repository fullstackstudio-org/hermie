import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakeIndexedDb } from '../test-support/fake-indexed-db'
import {
  cacheRowKey,
  cacheRowName,
  CHAT_CACHE_DATABASE,
  chatCacheFor,
  type CachedTranscriptRow,
  type ChatCache,
  FallbackChatCache,
  IndexedDbChatCache,
  MemoryChatCache
} from './chat-cache'

const transcript = (bot: string, updatedAt = 1): CachedTranscriptRow => ({
  bot,
  itemsJson: JSON.stringify({ format: 1, items: [{ id: 'a', kind: 'user', text: 'hello' }] }),
  lastRowId: 12,
  lastSeq: 40,
  epoch: 'e1',
  updatedAt
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('row keys', () => {
  it('splits on the first colon, so a bot name may carry colons of its own', () => {
    expect(cacheRowKey('/', 'ops:night')).toBe('/:ops:night')
    expect(cacheRowName('/:ops:night')).toBe('ops:night')
    expect(cacheRowName('/hermes:researcher')).toBe('researcher')
  })
})

describe('IndexedDbChatCache', () => {
  it('reads back what it wrote, in the record shape the controller writes', async () => {
    const idb = createFakeIndexedDb()
    const cache = new IndexedDbChatCache('/', idb.factory)

    await cache.write(transcript('researcher'))

    expect(await cache.read('researcher')).toEqual(transcript('researcher'))
    expect(await cache.read('writer')).toBeNull()

    // Stored under the namespaced key, with the namespace beside it.
    expect(idb.database(CHAT_CACHE_DATABASE)?.rows('transcripts')).toEqual([
      { ...transcript('researcher'), bot: '/:researcher', ns: '/' }
    ])
  })

  it('keeps two base paths on one origin apart', async () => {
    const idb = createFakeIndexedDb()
    const root = new IndexedDbChatCache('/', idb.factory)
    const prefixed = new IndexedDbChatCache('/hermes', idb.factory)

    await root.write(transcript('researcher', 1))
    await prefixed.write(transcript('researcher', 2))
    await root.writeBots([{ name: 'researcher', json: '{}', avatarRev: 0, updatedAt: 1 }])
    await prefixed.writeBots([{ name: 'writer', json: '{}', avatarRev: 0, updatedAt: 1 }])

    expect((await root.read('researcher'))?.updatedAt).toBe(1)
    expect((await prefixed.read('researcher'))?.updatedAt).toBe(2)
    expect((await root.readBots()).map(row => row.name)).toEqual(['researcher'])
    expect((await prefixed.readBots()).map(row => row.name)).toEqual(['writer'])
  })

  it('replaces the roster wholesale, so a bot that is gone is gone from the cache', async () => {
    const cache = new IndexedDbChatCache('/', createFakeIndexedDb().factory)

    await cache.writeBots([
      { name: 'writer', json: '{"a":1}', avatarRev: 1, updatedAt: 1 },
      { name: 'researcher', json: '{"b":2}', avatarRev: 2, updatedAt: 1 }
    ])
    await cache.writeBots([{ name: 'researcher', json: '{"b":3}', avatarRev: 3, updatedAt: 2 }])

    expect(await cache.readBots()).toEqual([{ name: 'researcher', json: '{"b":3}', avatarRev: 3, updatedAt: 2 }])
  })

  it('forgets one transcript', async () => {
    const cache = new IndexedDbChatCache('/', createFakeIndexedDb().factory)

    await cache.write(transcript('researcher'))
    await cache.write(transcript('writer'))
    await cache.forget('researcher')

    expect(await cache.read('researcher')).toBeNull()
    expect(await cache.read('writer')).not.toBeNull()
  })

  it('clears its own namespace and leaves another base path alone', async () => {
    const idb = createFakeIndexedDb()
    const root = new IndexedDbChatCache('/', idb.factory)
    const prefixed = new IndexedDbChatCache('/hermes', idb.factory)

    await root.write(transcript('researcher'))
    await root.writeBots([{ name: 'researcher', json: '{}', avatarRev: 0, updatedAt: 1 }])
    await prefixed.write(transcript('researcher'))

    await root.clear()

    expect(await root.read('researcher')).toBeNull()
    expect(await root.readBots()).toEqual([])
    expect(await prefixed.read('researcher')).not.toBeNull()
  })

  it('opens the database once for many calls', async () => {
    const idb = createFakeIndexedDb()
    const cache = new IndexedDbChatCache('/', idb.factory)

    await Promise.all([cache.read('a'), cache.read('b'), cache.readBots()])

    expect(idb.opens).toBe(1)
  })

  it('rejects when there is no IndexedDB at all, and tries again on the next call', async () => {
    const idb = createFakeIndexedDb()
    idb.refuse(true)
    const cache = new IndexedDbChatCache('/', idb.factory)

    await expect(cache.read('researcher')).rejects.toBeTruthy()

    idb.refuse(false)
    expect(await cache.read('researcher')).toBeNull()
    expect(idb.opens).toBe(2)

    await expect(new IndexedDbChatCache('/', null).read('x')).rejects.toThrow(/no IndexedDB/u)
  })
})

describe('FallbackChatCache', () => {
  it('downgrades to memory for good on the first failure, and keeps working', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const idb = createFakeIndexedDb()
    idb.refuse(true)
    const cache = new FallbackChatCache(new IndexedDbChatCache('/', idb.factory))

    await cache.write(transcript('researcher'))

    expect(cache.degraded).toBe(true)
    expect(await cache.read('researcher')).toEqual(transcript('researcher'))
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('still asks the store that failed to clear, so sign-out removes what was written before the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const primary: ChatCache = new MemoryChatCache()
    await primary.write(transcript('researcher'))

    let failing = false
    const flaky: ChatCache = {
      read: bot => (failing ? Promise.reject(new Error('gone')) : primary.read(bot)),
      write: snapshot => primary.write(snapshot),
      forget: bot => primary.forget(bot),
      readBots: () => primary.readBots(),
      writeBots: rows => primary.writeBots(rows),
      clear: () => primary.clear()
    }
    const cache = new FallbackChatCache(flaky)

    failing = true
    await cache.read('researcher')
    expect(cache.degraded).toBe(true)

    await cache.clear()
    expect(await primary.read('researcher')).toBeNull()
  })

  it('does not throw from clear when the store still refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const idb = createFakeIndexedDb()
    idb.refuse(true)
    const cache = new FallbackChatCache(new IndexedDbChatCache('/', idb.factory))

    await cache.write(transcript('researcher'))
    await expect(cache.clear()).resolves.toBeUndefined()
    expect(await cache.read('researcher')).toBeNull()
  })
})

describe('chatCacheFor', () => {
  it('shares one instance per namespace', () => {
    expect(chatCacheFor('/')).toBe(chatCacheFor('/'))
    expect(chatCacheFor('/')).not.toBe(chatCacheFor('/hermes'))
  })
})
