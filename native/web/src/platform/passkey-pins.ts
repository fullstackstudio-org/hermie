/**
 * What this browser remembers about one gateway's passkeys (contract §10, plan
 * "Data / Schema Changes"): the `gateway_id` it pinned on its first successful
 * enrolment there, and the credential ids it has seen, so it notices a reset
 * store or a passkey it did not add. Local, not secret.
 *
 * Two keys in the gateway's key-value store, one per gateway base URL:
 *
 * | Key                              | What                                    | On sign-out |
 * | -------------------------------- | --------------------------------------- | ----------- |
 * | `device.passkey.pin@<base URL>`  | `{gateway_id, pinned_at}`               | kept        |
 * | `passkey.seen@<base URL>`        | `{known_credential_ids, seen_at}`       | cleared     |
 *
 * The pin is about the gateway, not about a person, so a sign-out keeps it:
 * forgetting it would let whoever answers after the next sign-in choose the id
 * again (the reason the contract pins on enrolment and not on first connect).
 * The credential ids are one person's and go with them.
 *
 * `foreignGatewayIds` reads the pins of every OTHER gateway this browser holds on
 * this origin (another base path), straight from `localStorage`: a gateway that
 * presents one of them is impersonating it.
 */
import { keyValuePrefix, type StorageLike, type WebKeyValueStore } from './key-value-store'

export interface SeenCredentials {
  ids: string[]
  /** Unix seconds of the last list read; 0 while the list was never read here. */
  seenAt: number
}

/** The pin store the passkey model works against (`core/passkey/model.ts`). */
export interface PasskeyPinStore {
  /** The pinned `gateway_id` (base64url), or `null` before the first enrolment here. */
  gatewayId(): string | null
  pin(gatewayId: string): void
  seen(): SeenCredentials
  remember(ids: readonly string[]): void
  /** The ids pinned for other gateways this browser holds. */
  foreignGatewayIds(): Set<string>
}

const PIN_KEY = 'device.passkey.pin@'
const SEEN_KEY = 'passkey.seen@'
const PIN_PATTERN = /^hermie:[^:]*:device\.passkey\.pin@(.+)$/u

function pageLocalStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export interface PasskeyPinsOptions {
  store: WebKeyValueStore
  /** The gateway's serialised base URL. */
  baseUrl: string
  /** Where other gateways' pins are read from; the page's own `localStorage` unless told otherwise. */
  storage?: StorageLike | null
  now?: () => number
}

export function createPasskeyPins(options: PasskeyPinsOptions): PasskeyPinStore {
  const { store, baseUrl } = options
  const storage = options.storage === undefined ? pageLocalStorage() : options.storage
  const now = options.now ?? (() => Date.now() / 1000)
  const ownKey = `${store.prefix}${PIN_KEY}${baseUrl}`

  const readJson = <T>(key: string): T | null => {
    const raw = store.getSync(key)

    if (raw === null) {
      return null
    }

    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  return {
    gatewayId() {
      const record = readJson<{ gateway_id?: unknown }>(PIN_KEY + baseUrl)

      return typeof record?.gateway_id === 'string' && record.gateway_id ? record.gateway_id : null
    },
    pin(gatewayId) {
      store.setSync(PIN_KEY + baseUrl, JSON.stringify({ gateway_id: gatewayId, pinned_at: now() }))
    },
    seen() {
      const record = readJson<{ known_credential_ids?: unknown; seen_at?: unknown }>(SEEN_KEY + baseUrl)
      const ids = Array.isArray(record?.known_credential_ids)
        ? record.known_credential_ids.filter((id): id is string => typeof id === 'string')
        : []

      return { ids, seenAt: typeof record?.seen_at === 'number' ? record.seen_at : 0 }
    },
    remember(ids) {
      store.setSync(SEEN_KEY + baseUrl, JSON.stringify({ known_credential_ids: [...ids], seen_at: now() }))
    },
    foreignGatewayIds() {
      const found = new Set<string>()

      try {
        for (let index = 0; storage && index < storage.length; index += 1) {
          const name = storage.key(index)

          if (!name || name === ownKey || !PIN_PATTERN.test(name)) {
            continue
          }

          const record = JSON.parse(storage.getItem(name) ?? 'null') as { gateway_id?: unknown } | null

          if (typeof record?.gateway_id === 'string' && record.gateway_id) {
            found.add(record.gateway_id)
          }
        }
      } catch {
        // A store that cannot be read has no other gateway in it.
      }

      return found
    }
  }
}

/** The key the pin of `baseUrl` lives under in the namespace `namespace` (for tests and docs). */
export const pinStorageKey = (namespace: string, baseUrl: string): string =>
  `${keyValuePrefix(namespace)}${PIN_KEY}${baseUrl}`
