/**
 * The list of gateways, and the move that creates it.
 *
 * Two halves. The arithmetic — add, rename, remove, which entry is active after
 * a removal — is pure and is a table. The other half is the migration, and the
 * cases that earn their place there are the ones where "run it again" is the
 * wrong answer: a device that already has a list, a device whose list is empty
 * because the reader emptied it, and a device that has never been set up at all.
 */
import {
  activeGatewayOf,
  addGateway,
  asRegistry,
  defaultGatewayName,
  EMPTY_REGISTRY,
  GATEWAY_REGISTRY_KEY,
  GATEWAY_REGISTRY_VERSION,
  type GatewayRecord,
  gatewaysInOrder,
  isGatewayId,
  loadGatewayRegistry,
  newGatewayId,
  reconcileActiveGateway,
  removeGateway,
  renameGateway,
  setActiveGateway
} from '../src/gateway/registry'
import { CONFIG_KEY, type StoredGatewayConfig } from '../src/gateway/config'

const mockDisk = new Map<string, string>()

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockDisk.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockDisk.delete(key)
    }),
    getJson: jest.fn(async (key: string) => {
      const raw = mockDisk.get(key)

      return raw === undefined ? null : JSON.parse(raw)
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      mockDisk.set(key, JSON.stringify(value))
    })
  }
}))

const CONFIG: StoredGatewayConfig = {
  baseUrl: 'https://hermes.example.com:8443',
  authMode: 'native_pkce',
  provider: 'self-hosted',
  providerDisplayName: 'Self-Hosted OIDC',
  version: '2026.9.14',
  userDisplayName: 'Sam'
}

const record = (patch: Partial<GatewayRecord> = {}): GatewayRecord => ({
  id: newGatewayId(),
  name: 'hermes.example.com',
  address: 'https://hermes.example.com:8443',
  authKind: 'native_pkce',
  addedAt: 1,
  ...patch
})

beforeEach(() => {
  mockDisk.clear()
})

describe('minting an id', () => {
  it('is hex, so a key suffixed with one can only be read one way', () => {
    const id = newGatewayId()

    expect(isGatewayId(id)).toBe(true)
    // Every separator a stored key uses. An id carrying one would make
    // `hermie.chat.view@<id>` ambiguous the first time anybody split on it.
    expect(id).not.toMatch(/[@:.]/u)
  })

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newGatewayId()))

    expect(ids.size).toBe(50)
  })
})

describe('what a new entry is called', () => {
  it('is the host, which is the part of an address that is a name', () => {
    expect(defaultGatewayName('https://hermes.example.com:8443/hermes')).toBe('hermes.example.com')
  })

  it('keeps an unparseable address whole rather than calling it Unknown', () => {
    expect(defaultGatewayName('not an address')).toBe('not an address')
  })
})

describe('the list', () => {
  it('makes the first entry active and leaves a later one alone', () => {
    const first = record({ id: 'gaaaaaaaaaaaaaaaa', addedAt: 1 })
    const second = record({ id: 'gbbbbbbbbbbbbbbbb', addedAt: 2, address: 'https://other.example.com' })

    const one = addGateway(EMPTY_REGISTRY, first)
    const two = addGateway(one, second)

    expect(one.activeGatewayId).toBe(first.id)
    // Adding is describing a machine, not asking to be moved onto it: a switch
    // here would tear down a connection somebody was reading over.
    expect(two.activeGatewayId).toBe(first.id)
    expect(gatewaysInOrder(two).map(gateway => gateway.id)).toEqual([first.id, second.id])
  })

  it('moves the pointer when the active entry is removed', () => {
    const first = record({ id: 'gaaaaaaaaaaaaaaaa', addedAt: 1 })
    const second = record({ id: 'gbbbbbbbbbbbbbbbb', addedAt: 2 })
    const registry = addGateway(addGateway(EMPTY_REGISTRY, first), second)

    expect(removeGateway(registry, first.id).activeGatewayId).toBe(second.id)
    // And leaves it alone when something else goes.
    expect(removeGateway(registry, second.id).activeGatewayId).toBe(first.id)
  })

  it('points at nothing once the last entry is gone', () => {
    const only = record({ id: 'gaaaaaaaaaaaaaaaa' })
    const registry = removeGateway(addGateway(EMPTY_REGISTRY, only), only.id)

    expect(registry.gateways).toEqual([])
    expect(registry.activeGatewayId).toBeNull()
  })

  it('ignores a switch to an id that is not in the list', () => {
    const only = record({ id: 'gaaaaaaaaaaaaaaaa' })
    const registry = addGateway(EMPTY_REGISTRY, only)

    expect(setActiveGateway(registry, 'gffffffffffffffff').activeGatewayId).toBe(only.id)
  })

  it('reads a cleared name as "use the default" rather than refusing it', () => {
    const only = record({ id: 'gaaaaaaaaaaaaaaaa', name: 'Work' })
    const registry = renameGateway(addGateway(EMPTY_REGISTRY, only), only.id, '   ')

    expect(activeGatewayOf(registry)?.name).toBe('hermes.example.com')
  })
})

describe('reading a stored registry', () => {
  it('drops a row with no usable id or address, and keeps the rest', () => {
    const registry = asRegistry({
      v: GATEWAY_REGISTRY_VERSION,
      gateways: [
        { id: 'not-an-id', address: 'https://a.example.com' },
        { id: 'gaaaaaaaaaaaaaaaa', address: '' },
        { id: 'gbbbbbbbbbbbbbbbb', address: 'https://b.example.com', authKind: 'session_token', addedAt: 4 }
      ],
      activeGatewayId: 'gbbbbbbbbbbbbbbbb'
    })

    expect(registry.gateways.map(gateway => gateway.id)).toEqual(['gbbbbbbbbbbbbbbbb'])
    expect(registry.activeGatewayId).toBe('gbbbbbbbbbbbbbbbb')
  })

  it('re-points a pointer left dangling by a dropped row', () => {
    const registry = asRegistry({
      v: GATEWAY_REGISTRY_VERSION,
      gateways: [{ id: 'gbbbbbbbbbbbbbbbb', address: 'https://b.example.com' }],
      activeGatewayId: 'gaaaaaaaaaaaaaaaa'
    })

    expect(registry.activeGatewayId).toBe('gbbbbbbbbbbbbbbbb')
  })

  it('keeps nothing from a version it does not know', () => {
    expect(asRegistry({ v: 99, gateways: [{ id: 'gaaaaaaaaaaaaaaaa', address: 'https://a' }] })).toEqual(EMPTY_REGISTRY)
  })
})

describe('the move off a single stored gateway', () => {
  it('turns the configured gateway into entry one, active, named after its host', async () => {
    mockDisk.set(CONFIG_KEY, JSON.stringify(CONFIG))

    const { registry, migratedId } = await loadGatewayRegistry(1_700_000_000_000)
    const only = activeGatewayOf(registry)

    expect(migratedId).toBe(only?.id)
    expect(only).toMatchObject({
      name: 'hermes.example.com',
      address: 'https://hermes.example.com:8443',
      authKind: 'native_pkce',
      signedInUser: 'Sam',
      addedAt: 1_700_000_000_000
    })
    // Written down, or the next launch would mint a different id for the same
    // gateway and every namespaced key would point at a stranger.
    expect(JSON.parse(mockDisk.get('hermie.gateways')!).gateways).toHaveLength(1)
  })

  it('runs once: a second launch finds the list and adopts nothing', async () => {
    mockDisk.set(CONFIG_KEY, JSON.stringify(CONFIG))

    const first = await loadGatewayRegistry(1)
    const second = await loadGatewayRegistry(2)

    expect(second.migratedId).toBeNull()
    expect(second.registry.gateways.map(gateway => gateway.id)).toEqual([first.registry.gateways[0]!.id])
  })

  it('leaves an emptied list empty', async () => {
    // The reader removed their last gateway on purpose. The configuration is
    // still on disk for a moment; re-adopting it would put the row back.
    mockDisk.set(CONFIG_KEY, JSON.stringify(CONFIG))
    mockDisk.set(GATEWAY_REGISTRY_KEY, JSON.stringify(EMPTY_REGISTRY))

    const { registry, migratedId } = await loadGatewayRegistry()

    expect(registry.gateways).toEqual([])
    expect(migratedId).toBeNull()
  })

  it('writes nothing on a device that was never set up', async () => {
    const { registry, migratedId } = await loadGatewayRegistry()

    expect(registry).toEqual(EMPTY_REGISTRY)
    expect(migratedId).toBeNull()
    // An abandoned wizard leaves no more behind than it did before any of this.
    expect(mockDisk.size).toBe(0)
  })
})

describe('keeping the entry and the configuration in step', () => {
  it('adds one when nothing is active yet', () => {
    const registry = reconcileActiveGateway(EMPTY_REGISTRY, CONFIG, 7)

    expect(activeGatewayOf(registry)).toMatchObject({ address: CONFIG.baseUrl, name: 'hermes.example.com' })
  })

  it('follows the address when the name was only ever the old host', () => {
    const only = record({ id: 'gaaaaaaaaaaaaaaaa', name: 'hermes.example.com' })
    const registry = reconcileActiveGateway(
      addGateway(EMPTY_REGISTRY, only),
      { ...CONFIG, baseUrl: 'https://moved.example.com' },
      7
    )

    expect(activeGatewayOf(registry)).toMatchObject({ address: 'https://moved.example.com', name: 'moved.example.com' })
  })

  it('keeps a name the reader typed when the address moves', () => {
    const only = record({ id: 'gaaaaaaaaaaaaaaaa', name: 'The Pi' })
    const registry = reconcileActiveGateway(
      addGateway(EMPTY_REGISTRY, only),
      { ...CONFIG, baseUrl: 'https://moved.example.com' },
      7
    )

    // "The Pi" is a statement about a machine, and a machine that moved to
    // another address is still that machine.
    expect(activeGatewayOf(registry)).toMatchObject({ address: 'https://moved.example.com', name: 'The Pi' })
  })

  it('drops a signed-in name the gateway no longer reports', () => {
    const only = record({ id: 'gaaaaaaaaaaaaaaaa', signedInUser: 'Sam' })
    const { userDisplayName: _ignored, ...anonymous } = CONFIG
    const registry = reconcileActiveGateway(addGateway(EMPTY_REGISTRY, only), anonymous, 7)

    expect(activeGatewayOf(registry)?.signedInUser).toBeUndefined()
  })
})
