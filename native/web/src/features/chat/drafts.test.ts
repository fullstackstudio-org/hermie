import { describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../../platform/key-value-store'
import { createDraftStore, draftKey } from './drafts'

const memoryStorage = () => {
  const map = new Map<string, string>()

  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    }
  }
}

describe('the drafts', () => {
  it('keeps what was typed in a chat, for that chat only', () => {
    const drafts = createDraftStore(createKeyValueStore({ namespace: '/', storage: memoryStorage() }))

    drafts.write('researcher', 'half a sentence')
    drafts.write('writer', 'another')

    expect(drafts.read('researcher')).toBe('half a sentence')
    expect(drafts.read('writer')).toBe('another')
    expect(drafts.read('nobody')).toBe('')
  })

  it('forgets a draft that is emptied', () => {
    const storage = memoryStorage()
    const drafts = createDraftStore(createKeyValueStore({ namespace: '/', storage }))

    drafts.write('researcher', 'x')
    drafts.write('researcher', '')

    expect(drafts.read('researcher')).toBe('')
    expect(storage.length).toBe(0)
  })

  it('keeps them per base path, so two gateways on one host do not share a draft', () => {
    const storage = memoryStorage()
    const one = createDraftStore(createKeyValueStore({ namespace: '/one', storage }))
    const two = createDraftStore(createKeyValueStore({ namespace: '/two', storage }))

    one.write('researcher', 'for one')

    expect(two.read('researcher')).toBe('')
    expect(one.read('researcher')).toBe('for one')
  })

  it('belongs to the signed-in person: a sign-out takes it away', () => {
    const store = createKeyValueStore({ namespace: '/', storage: memoryStorage() })
    const drafts = createDraftStore(store)

    drafts.write('researcher', 'private')
    expect(store.clearIdentityBound()).toContain(draftKey('researcher'))
    expect(drafts.read('researcher')).toBe('')
  })

  it('does not confuse a bot that has a hash in its name with another chat', () => {
    const drafts = createDraftStore(createKeyValueStore({ namespace: '/', storage: memoryStorage() }))

    drafts.write('bot#one', 'a')

    expect(drafts.read('bot')).toBe('')
  })

  it('uses a key that is not device-local', () => {
    expect(draftKey('researcher').startsWith('device.')).toBe(false)
  })
})
