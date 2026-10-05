/**
 * The vault calls, pinned against `tui_gateway/methods_vault.py`, `agent/vault_store.py::VaultStore.add_item`
 * and the method contracts: a vault per profile, metadata-only listings, the add and unlock refusals scrubbed
 * of what was sent, and no key a contract does not name. The secrets here are harmless markers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

type RpcError = Error & { code?: number }

const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const id = `vault-${(nextId += 1)}`
    const onMessage = (data: unknown) => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as {
          id?: string
          result?: Record<string, unknown>
          error?: { code?: number; message?: string }
        }

        if (frame.id !== id) {
          continue
        }

        socket.off('message', onMessage)

        if (frame.error) {
          reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { code: frame.error.code }))

          return
        }

        resolve(frame.result ?? {})
      }
    }

    socket.on('message', onMessage)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

const refusal = async (method: string, params: Record<string, unknown>): Promise<RpcError> => {
  try {
    await call(method, params)
  } catch (error) {
    return error as RpcError
  }

  throw new Error(`${method} was not refused`)
}

const stage = async (body: Record<string, unknown>): Promise<void> => {
  await fetch(`${gateway.url}/__fake/vault`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
}

const view = async (profile: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${gateway.url}/__fake/vault?profile=${profile}`)).json()) as Record<string, unknown>

const PASSWORD = 'marker-password-1'

const login = (profile: string, extra: Record<string, unknown> = {}) => ({
  kind: 'login',
  label: 'Example login',
  origin: 'https://example.com:443/path',
  profile,
  secret: { identifier: 'me@example.com', identifier_type: 'email', password: PASSWORD },
  ...extra
})

beforeAll(async () => {
  gateway = await startFakeGateway({ port: 0 })
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterAll(async () => {
  socket.close()
  await gateway.close()
})

beforeEach(async () => {
  await stage({ clear: true })
})

describe('vault.add and vault.list', () => {
  it('stores a login in the profile’s own vault and lists only its metadata', async () => {
    const added = await call('vault.add', login('researcher'))

    expect(Object.keys(added)).toEqual(['id'])

    const { items } = (await call('vault.list', { profile: 'researcher' })) as { items: Record<string, unknown>[] }

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      backend: 'local',
      id: added.id,
      identifier: 'me@example.com',
      identifier_type: 'email',
      kind: 'login',
      label: 'Example login',
      origin: 'https://example.com'
    })
    expect(JSON.stringify(items)).not.toContain(PASSWORD)
    expect(items[0]).not.toHaveProperty('secret')

    // What reached the vault: the password, and the identifier moved out of the secret.
    const stored = (await view('researcher')).items as { secret: Record<string, string> }[]

    expect(stored[0]?.secret).toEqual({ password: PASSWORD })
  })

  it('keeps each profile’s vault apart, and a call without a profile reaches the launch profile’s', async () => {
    await call('vault.add', login('writer'))

    expect(((await call('vault.list', { profile: 'researcher' })) as { items: unknown[] }).items).toEqual([])
    expect(((await call('vault.list', { profile: 'writer' })) as { items: unknown[] }).items).toHaveLength(1)

    // The fake's launch profile is its default one, `researcher`.
    await call('vault.add', login('researcher'))
    expect(((await call('vault.list')) as { items: unknown[] }).items).toEqual(
      ((await call('vault.list', { profile: 'researcher' })) as { items: unknown[] }).items
    )
  })

  it('refuses a profile it does not serve with 4064, never falling back to the launch profile', async () => {
    const error = await refusal('vault.add', login('nobody'))

    expect(error.code).toBe(4064)
    expect(((await call('vault.list')) as { items: unknown[] }).items).toEqual([])
    expect(((await call('vault.list', { profile: 'writer' })) as { items: unknown[] }).items).toEqual([])
  })

  it('validates as the store does, and scrubs what was sent from its words', async () => {
    expect((await refusal('vault.add', login('researcher', { origin: 'example.com' }))).message).toContain('scheme')
    expect((await refusal('vault.add', login('researcher', { label: ' ' }))).message).toBe('label is required')
    expect((await refusal('vault.add', login('researcher', { secret: {} }))).message).toBe('secret payload is required')

    const noIdentifier = await refusal(
      'vault.add',
      login('researcher', { secret: { identifier_type: 'email', password: PASSWORD } })
    )
    expect(noIdentifier.code).toBe(5095)
    expect(noIdentifier.message).toBe('login items require identifier and password')

    // A refusal whose words would carry a secret value comes back scrubbed.
    const echoed = await refusal('vault.add', login('researcher', { origin: PASSWORD }))
    expect(echoed.code).toBe(5095)
    expect(echoed.message).toBe("origin must include a scheme (got '[REDACTED]')")

    const card = await refusal('vault.add', {
      kind: 'payment',
      label: 'Card',
      profile: 'researcher',
      secret: { card_number: 'marker-card-4242' }
    })
    expect(card.message).toBe('payment items require exp_month, exp_year, cvc')

    const unknownKind = await refusal('vault.add', { ...login('researcher'), kind: 'marker-kind-secret' })
    expect(unknownKind.message).toContain('unknown vault kind')
  })

  it('stores a card and an address with only their own fields', async () => {
    await call('vault.add', {
      kind: 'payment',
      label: 'Card',
      profile: 'writer',
      secret: { card_number: 'marker-4242', cvc: 'm-1', exp_month: '01', exp_year: '2030', stray: 'dropped' }
    })
    await call('vault.add', {
      kind: 'address',
      label: 'Home',
      profile: 'writer',
      secret: { address_line1: 'Street 1', city: 'Town', country: 'NL', postal_code: '1234 AB' }
    })

    const stored = (await view('writer')).items as { kind: string; origin: unknown; secret: Record<string, string> }[]

    expect(stored.map(item => item.kind)).toEqual(['payment', 'address'])
    expect(Object.keys(stored[0]?.secret ?? {}).sort()).toEqual(['card_number', 'cvc', 'exp_month', 'exp_year'])
    expect(stored[0]?.origin).toBeNull()
  })

  it('refuses a key the contract does not name with 4000', async () => {
    const error = await refusal('vault.add', { ...login('researcher'), username: 'me' })

    expect(error.code).toBe(4000)
    expect(error.message).toContain('username')
  })
})

describe('vault.remove', () => {
  it('removes an item from its own profile’s vault only', async () => {
    const { id } = await call('vault.add', login('researcher'))

    expect(await call('vault.remove', { id, profile: 'writer' })).toEqual({ removed: false })
    expect(await call('vault.remove', { id, profile: 'researcher' })).toEqual({ removed: true })
    expect(((await call('vault.list', { profile: 'researcher' })) as { items: unknown[] }).items).toEqual([])
    expect((await refusal('vault.remove', { profile: 'researcher' })).message).toBe('id is required')
  })
})

describe('the password manager', () => {
  it('is locked until its master password is given, and lists its logins while unlocked', async () => {
    await stage({
      managerItems: [
        { identifier: 'me', identifier_type: 'username', kind: 'login', label: 'Shop', origin: 'https://shop.example' }
      ],
      managerPassword: 'marker-master-1'
    })

    const sources = (await call('vault.sources', { profile: 'researcher' })) as { sources: Record<string, unknown>[] }
    expect(sources.sources.map(source => source.name)).toEqual(['local', 'bitwarden'])
    expect(sources.sources[1]).toMatchObject({ enabled: true, installed: true, needs_unlock: true, unlocked: false })

    const wrong = await refusal('vault.unlock', {
      name: 'bitwarden',
      password: 'marker-wrong-1',
      profile: 'researcher'
    })
    expect(wrong.code).toBe(5095)
    expect(wrong.message).not.toContain('marker-wrong-1')

    expect(
      await call('vault.unlock', { name: 'bitwarden', password: 'marker-master-1', profile: 'researcher' })
    ).toEqual({
      name: 'bitwarden',
      unlocked: true
    })

    const listed = (await call('vault.list', { profile: 'researcher' })) as { items: Record<string, unknown>[] }
    expect(listed.items.map(item => item.backend)).toEqual(['bitwarden'])

    // Unlocked for this profile only.
    expect(((await call('vault.list', { profile: 'writer' })) as { items: unknown[] }).items).toEqual([])

    expect(await call('vault.lock', { name: 'bitwarden', profile: 'researcher' })).toEqual({ locked: true })
    expect(((await call('vault.list', { profile: 'researcher' })) as { items: unknown[] }).items).toEqual([])
  })

  it('can be switched off for a profile, which locks it', async () => {
    await stage({ managerPassword: 'marker-master-1' })
    await call('vault.unlock', { name: 'bitwarden', password: 'marker-master-1', profile: 'writer' })

    expect(await call('vault.source.set', { enabled: false, name: 'bitwarden', profile: 'writer' })).toEqual({
      enabled: false,
      name: 'bitwarden'
    })

    const sources = (await call('vault.sources', { profile: 'writer' })) as { sources: Record<string, unknown>[] }
    expect(sources.sources[1]).toMatchObject({ enabled: false, unlocked: false })
    expect((await refusal('vault.source.set', { enabled: true, name: 'nope', profile: 'writer' })).message).toBe(
      'unknown vault source: nope'
    )
  })
})

describe('the control route', () => {
  it('records each call’s method, profile and keys, and can make the gateway an older one', async () => {
    await call('vault.list', { profile: 'researcher' })

    const { calls } = (await view('researcher')) as { calls: Record<string, unknown>[] }
    expect(calls.at(-1)).toEqual({ keys: ['profile'], method: 'vault.list', profile: 'researcher' })

    await stage({ unsupported: true })
    expect((await refusal('vault.list', { profile: 'researcher' })).code).toBe(-32601)
  })
})
