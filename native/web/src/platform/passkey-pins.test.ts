/**
 * The pins: what is kept, and what `forget` takes away (this gateway's pin and nothing else).
 */
import { describe, expect, it } from 'vitest'

import { createKeyValueStore, type StorageLike } from './key-value-store'
import { createPasskeyPins, pinStorageKey } from './passkey-pins'

const BASE = 'https://gw.example.test'
const OTHER = 'https://other.example.test'

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()

  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    }
  }
}

describe('forgetting a gateway’s pin', () => {
  it('removes its own pin, and neither the ids it has seen nor another gateway’s pin', () => {
    const storage = memoryStorage()
    const store = createKeyValueStore({ namespace: '/', storage })
    const pins = createPasskeyPins({ store, baseUrl: BASE, storage })
    const other = createPasskeyPins({ store, baseUrl: OTHER, storage })

    pins.pin('AAAAAAAAAAAAAAAAAAAAAA')
    pins.remember(['one'])
    other.pin('BBBBBBBBBBBBBBBBBBBBBB')

    expect(storage.map.has(pinStorageKey('/', BASE))).toBe(true)

    pins.forget()

    expect(pins.gatewayId()).toBeNull()
    expect(storage.map.has(pinStorageKey('/', BASE))).toBe(false)
    expect(pins.seen().ids).toEqual(['one'])
    expect(other.gatewayId()).toBe('BBBBBBBBBBBBBBBBBBBBBB')
    // Another gateway's pin is still one this gateway may not present.
    expect(pins.foreignGatewayIds().has('BBBBBBBBBBBBBBBBBBBBBB')).toBe(true)
  })

  it('does nothing where there is no pin, and a new enrolment pins again', () => {
    const storage = memoryStorage()
    const pins = createPasskeyPins({ store: createKeyValueStore({ namespace: '/', storage }), baseUrl: BASE, storage })

    expect(() => pins.forget()).not.toThrow()

    pins.pin('AAAAAAAAAAAAAAAAAAAAAA')
    pins.forget()
    pins.pin('CCCCCCCCCCCCCCCCCCCCCC')

    expect(pins.gatewayId()).toBe('CCCCCCCCCCCCCCCCCCCCCC')
  })
})
