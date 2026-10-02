import { snapshotForCache, stateFromCache } from '@hermie/transcript'

import { type ChatCache, FallbackChatCache, MemoryChatCache } from '../src/platform/chat-cache'
import { useChatsStore } from '../src/store/chats'

/** A cache whose every method throws, standing in for a database that will not open. */
class BrokenCache implements ChatCache {
  calls = 0

  private fail(): never {
    this.calls += 1

    throw new Error('database is locked')
  }

  read(): never {
    return this.fail()
  }

  write(): never {
    return this.fail()
  }

  forget(): never {
    return this.fail()
  }

  readBots(): never {
    return this.fail()
  }

  writeBots(): never {
    return this.fail()
  }

  clear(): never {
    return this.fail()
  }
}

beforeEach(() => {
  useChatsStore.getState().reset()
})

describe('the chat cache', () => {
  it('round-trips a transcript through the snapshot format', async () => {
    const cache = new MemoryChatCache()
    const store = useChatsStore.getState()

    store.ensure('researcher', { storedSessionId: 'stored-1', resolvedSessionId: 'tip-1' })
    // The watermark only means anything alongside the session that counted it.
    store.bindRuntime('researcher', 'runtime-1')
    store.dispatchEvent('researcher', { type: 'message.delta', seq: 1, payload: { text: 'hello' } })
    store.dispatchEvent('researcher', { type: 'message.complete', seq: 2, payload: { text: 'hello' } })

    const snapshot = snapshotForCache(useChatsStore.getState().chats.researcher!)

    await cache.write({
      bot: 'researcher',
      itemsJson: JSON.stringify(snapshot),
      lastRowId: snapshot.lastRowId ?? null,
      lastSeq: snapshot.lastSeq,
      epoch: snapshot.epoch ?? null,
      updatedAt: snapshot.updatedAt
    })

    const row = await cache.read('researcher')
    const restored = stateFromCache(
      'researcher',
      { storedSessionId: 'stored-1', resolvedSessionId: 'tip-1' },
      JSON.parse(row!.itemsJson)
    )

    expect(restored.hydration).toBe('cached')
    expect(restored.lastSeq).toBe(2)
    expect(restored.lastSeqSessionId).toBe('runtime-1')
    expect(restored.order).toHaveLength(1)
  })

  it('replaces the roster wholesale so a removed bot disappears', async () => {
    const cache = new MemoryChatCache()

    await cache.writeBots([{ name: 'a', json: '{}', avatarRev: 0, updatedAt: 1 }])
    await cache.writeBots([{ name: 'b', json: '{}', avatarRev: 0, updatedAt: 2 }])

    await expect(cache.readBots()).resolves.toEqual([{ name: 'b', json: '{}', avatarRev: 0, updatedAt: 2 }])
  })

  it('downgrades to memory the first time the database throws, and stays there', async () => {
    const broken = new BrokenCache()
    const cache = new FallbackChatCache(broken)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await cache.write({ bot: 'researcher', itemsJson: '{}', lastRowId: null, lastSeq: 0, epoch: null, updatedAt: 1 })
      await cache.write({ bot: 'writer', itemsJson: '{}', lastRowId: null, lastSeq: 0, epoch: null, updatedAt: 1 })

      expect(cache.degraded).toBe(true)
      // One failed attempt, then the instance stops asking.
      expect(broken.calls).toBe(1)
      expect(warn).toHaveBeenCalledTimes(1)
      // A chat is never lost over a cache: the write still lands in memory.
      await expect(cache.read('researcher').then(row => row?.bot)).resolves.toBe('researcher')
    } finally {
      warn.mockRestore()
    }
  })
})
