/**
 * One configured gateway on disk, for a suite that only needs there to BE one.
 *
 * Every gateway-specific key now carries the entry's id, and the entry itself
 * lives in a list under `hermie.gateways`. A mock that answered the same
 * configuration to every key — which is what several of these suites used to do
 * — makes the registry read that configuration as a list of gateways, find
 * none, and land the app on the wizard. So the shape is written down once,
 * here, rather than being got subtly wrong in each suite that needs it.
 *
 * It is a factory rather than a module-level object because `jest.mock` runs
 * its factory before the module scope exists: a suite `require`s this from
 * inside the factory.
 */

export const STORED_GATEWAY_ID = 'gaaaaaaaaaaaaaaaa'

export interface StoredGatewayConfigLike {
  baseUrl: string
  authMode: string
  [key: string]: unknown
}

export interface GatewayDiskOptions {
  /** The entry's id. One is enough for every suite that is not about the list. */
  gatewayId?: string
  /** Anything else this suite wants the disk to answer, by full key. */
  extra?: Record<string, unknown>
}

/**
 * A `KeyValueStore` double that holds exactly one configured gateway.
 *
 * Writes are recorded and never read back: a suite that wants a round trip
 * wants a real in-memory map, not this.
 */
export function gatewayDisk(config: StoredGatewayConfigLike, options: GatewayDiskOptions = {}) {
  const id = options.gatewayId ?? STORED_GATEWAY_ID
  const registry = {
    v: 1,
    activeGatewayId: id,
    gateways: [
      {
        id,
        name: 'hermes.example.com',
        address: config.baseUrl,
        authKind: config.authMode,
        addedAt: 1
      }
    ]
  }

  const answers: Record<string, unknown> = {
    'hermie.gateways': registry,
    [`hermie.gateway.config@${id}`]: config,
    ...(options.extra ?? {})
  }

  return {
    keyValueStore: {
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      getJson: jest.fn(async (key: string) => answers[key] ?? null),
      setJson: jest.fn(async () => undefined),
      // The launch sweep asks for these. Answering with the keys this double
      // actually holds keeps it honest: the sweep then finds the one live
      // configuration, recognises it, and removes nothing.
      keys: jest.fn(async () => Object.keys(answers)),
      deleteMany: jest.fn(async () => undefined)
    }
  }
}

/** The secret-store double that goes with it: one access token, on that entry. */
export function gatewaySecrets(gatewayId: string = STORED_GATEWAY_ID) {
  return {
    secretStore: {
      // `-`, not `@`: the secret store rejects an `@` outright. See
      // `SECRET_NAMESPACE_SEPARATOR` in `gateway/namespace.ts`.
      get: jest.fn(async (key: string) => (key === `hermie.auth.access_token-${gatewayId}` ? 'access-1' : null)),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined)
    }
  }
}
