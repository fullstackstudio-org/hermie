/**
 * The credential vault, per profile, in the shapes `tui_gateway/methods_vault.py` answers with.
 *
 * Each profile has a vault of its own (the real handlers bind `params.profile`'s HERMES_HOME around every
 * body, so the vault file is that profile's): an item added for one bot is never listed for another, and a
 * call without `profile` reaches the launch profile's. A name the gateway does not serve is 4064, never the
 * launch profile.
 *
 * What the real gateway guarantees and this one keeps:
 *
 *  - `vault.list` answers metadata only (`VaultItemMeta.to_dict` + `backend`); the secret is never in a result.
 *  - `vault.add` validates as `VaultStore.add_item` does (kind, label, a login's origin with a scheme,
 *    `identifier_type`, `identifier` and `password`; a card's or an address's required fields) and answers
 *    `{id}`. A refusal is 5095, its words scrubbed of every secret value of three characters and up.
 *  - `vault.unlock` takes a password manager's master password and answers `{name, unlocked}`; a wrong one is
 *    5095 with the password redacted from the words.
 *  - every method refuses a key its contract does not name (4000), as `rpc_dispatch` does.
 *
 * One password manager is on the "gateway's host": `bitwarden`, installed, on by default, locked. Its master
 * password is staged (`POST /__fake/vault`, `{managerPassword}`), as are the logins it holds once unlocked.
 *
 * The control route `GET /__fake/vault?profile=` shows a profile's items WITH their secrets: it is a test's way
 * of checking what reached the vault, never part of the contract (the secrets a test sends are markers).
 */

export const VAULT_METHODS = [
  'vault.list',
  'vault.sources',
  'vault.source.set',
  'vault.unlock',
  'vault.lock',
  'vault.add',
  'vault.remove'
] as const

/** The keys each method's contract accepts (`contracts/profiles_vault_complete_foreign_subagents.py`). */
const PARAMS: Record<(typeof VAULT_METHODS)[number], readonly string[]> = {
  'vault.add': ['profile', 'kind', 'label', 'origin', 'secret'],
  'vault.list': ['profile'],
  'vault.lock': ['profile', 'name'],
  'vault.remove': ['profile', 'id'],
  'vault.source.set': ['profile', 'name', 'enabled'],
  'vault.sources': ['profile'],
  'vault.unlock': ['profile', 'name', 'password']
}

const KINDS = ['login', 'payment', 'address'] as const
const IDENTIFIER_TYPES = ['email', 'phone', 'username'] as const
const PAYMENT_FIELDS = ['card_number', 'cardholder_name', 'exp_month', 'exp_year', 'cvc', 'billing_postal_code']
const ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country']
const REQUIRED: Record<string, string[]> = {
  address: ['address_line1', 'city', 'postal_code', 'country'],
  payment: ['card_number', 'exp_month', 'exp_year', 'cvc']
}

export const MANAGER = { display_name: 'Bitwarden', name: 'bitwarden' } as const

/** A refusal with the gateway's code; the server turns it into its own `RpcFault`. */
export class VaultError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

export interface VaultRecord {
  id: string
  kind: string
  label: string
  origin: string | null
  created_at: string
  identifier_type: string | null
  identifier: string | null
  secret: Record<string, string>
}

interface ProfileVault {
  items: VaultRecord[]
  /** The manager is switched off for this profile (`vault.<name>.enabled: false`). */
  managerOff: boolean
  managerUnlocked: boolean
}

export interface VaultStage {
  profiles: Map<string, ProfileVault>
  /** The manager's master password; unset, every unlock is refused. */
  managerPassword: string | null
  /** The logins the manager holds, listed while it is unlocked. */
  managerItems: Omit<VaultRecord, 'secret'>[]
  /** The gateway has no vault methods (an older one): `-32601`. */
  unsupported: boolean
  /** Every vault call, newest last: its method, the profile it named (null for none) and its param keys. */
  calls: { method: string; profile: string | null; keys: string[] }[]
  nextId: number
}

export const emptyVaultStage = (): VaultStage => ({
  calls: [],
  managerItems: [],
  managerPassword: null,
  nextId: 1,
  profiles: new Map(),
  unsupported: false
})

const profileVault = (stage: VaultStage, profile: string): ProfileVault => {
  let vault = stage.profiles.get(profile)

  if (!vault) {
    vault = { items: [], managerOff: false, managerUnlocked: false }
    stage.profiles.set(profile, vault)
  }

  return vault
}

/** `scrub_secret_from_text`: exact values of three characters and up, and a `password=` echo. */
const scrub = (text: string, secret: Record<string, unknown>): string => {
  let scrubbed = text

  for (const value of Object.values(secret)) {
    if (typeof value === 'string' && value.length >= 3) {
      scrubbed = scrubbed.split(value).join('[REDACTED]')
    }
  }

  return scrubbed.replace(/(password['"]?\s*[:=]\s*)\S+/g, '$1[REDACTED]')
}

/** `normalize_origin`: `scheme://host[:port]`, default ports dropped. */
const normalizeOrigin = (value: string): string => {
  const trimmed = value.trim()

  if (!trimmed) {
    throw new VaultError(5095, 'origin is required')
  }

  if (!trimmed.includes('://')) {
    throw new VaultError(5095, `origin must include a scheme (got '${trimmed}')`)
  }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    throw new VaultError(5095, `could not parse origin from '${trimmed}'`)
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const host = url.hostname.toLowerCase()

  if (!scheme || !host) {
    throw new VaultError(5095, `could not parse origin from '${trimmed}'`)
  }

  return url.port ? `${scheme}://${host}:${url.port}` : `${scheme}://${host}`
}

const metaOf = (record: Omit<VaultRecord, 'secret'> & { secret?: Record<string, string> }, backend: string) => ({
  backend,
  created_at: record.created_at,
  id: record.id,
  kind: record.kind,
  label: record.label,
  origin: record.origin,
  ...(record.identifier !== null ? { identifier: record.identifier, identifier_type: record.identifier_type } : {}),
  ...(record.secret?.otp_secret ? { has_otp: true } : {})
})

const add = (stage: VaultStage, vault: ProfileVault, params: Record<string, unknown>): { id: string } => {
  const secretParam = params.secret

  if (
    !secretParam ||
    typeof secretParam !== 'object' ||
    Array.isArray(secretParam) ||
    !Object.keys(secretParam).length
  ) {
    throw new VaultError(5095, 'secret payload is required')
  }

  const secret = { ...(secretParam as Record<string, unknown>) }

  try {
    const kind = String(params.kind ?? '')

    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new VaultError(5095, `unknown vault kind '${kind}' (expected one of ${KINDS.join(', ')})`)
    }

    const label = String(params.label ?? '').trim()

    if (!label) {
      throw new VaultError(5095, 'label is required')
    }

    const origin = typeof params.origin === 'string' && params.origin ? params.origin : null
    let stored: Record<string, string>
    let identifier: string | null = null
    let identifierType: string | null = null
    let normalized: string | null = null

    if (kind === 'login') {
      if (!origin) {
        throw new VaultError(5095, 'origin is required for login items')
      }

      normalized = normalizeOrigin(origin)
      const type = secret.identifier_type

      if (typeof type !== 'string' || !(IDENTIFIER_TYPES as readonly string[]).includes(type)) {
        throw new VaultError(5095, `identifier_type must be one of ${IDENTIFIER_TYPES.join(', ')}`)
      }

      identifier = String(secret.identifier ?? '').trim()

      if (!identifier || !secret.password) {
        throw new VaultError(5095, 'login items require identifier and password')
      }

      identifierType = type
      const otp = typeof secret.otp_secret === 'string' ? secret.otp_secret.trim() : ''
      stored = { password: String(secret.password), ...(otp ? { otp_secret: otp } : {}) }
    } else {
      const allowed = kind === 'payment' ? PAYMENT_FIELDS : ADDRESS_FIELDS
      stored = {}

      for (const [key, value] of Object.entries(secret)) {
        if (allowed.includes(key) && String(value ?? '').trim()) {
          stored[key] = String(value)
        }
      }

      const missing = (REQUIRED[kind] ?? []).filter(field => !(field in stored))

      if (missing.length) {
        throw new VaultError(5095, `${kind} items require ${missing.join(', ')}`)
      }

      if (origin) {
        normalized = normalizeOrigin(origin)
      }
    }

    const id = `vault_${String(stage.nextId).padStart(12, '0')}`
    stage.nextId += 1
    vault.items.push({
      created_at: new Date().toISOString(),
      id,
      identifier,
      identifier_type: identifierType,
      kind,
      label,
      origin: normalized,
      secret: stored
    })

    return { id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    throw new VaultError(5095, scrub(message, secret))
  }
}

/**
 * One vault call for `profile` (the launch profile's name when the call named none), already known to be a
 * profile the gateway serves.
 */
export const vaultCall = (
  stage: VaultStage,
  method: string,
  params: Record<string, unknown>,
  profile: string
): unknown => {
  stage.calls.push({
    keys: Object.keys(params).sort(),
    method,
    profile: typeof params.profile === 'string' ? params.profile : null
  })

  if (stage.unsupported) {
    throw new VaultError(-32601, `unknown method: ${method}`)
  }

  const accepted = PARAMS[method as (typeof VAULT_METHODS)[number]]
  const unknown = Object.keys(params).find(key => !accepted.includes(key))

  if (unknown) {
    throw new VaultError(
      4000,
      `invalid params for ${method}: ${unknown}: Extra inputs are not permitted — the client and the Hermes backend are out of sync (different versions); run \`hermes update\` and restart both`
    )
  }

  const vault = profileVault(stage, profile)
  const managerEnabled = !vault.managerOff

  switch (method) {
    case 'vault.list': {
      const items = vault.items.map(record => metaOf(record, 'local'))

      if (managerEnabled && vault.managerUnlocked) {
        items.push(...stage.managerItems.map(record => metaOf(record, MANAGER.name)))
      }

      return { items }
    }

    case 'vault.sources':
      return {
        sources: [
          {
            display_name: 'Hermes vault',
            enabled: true,
            installed: true,
            name: 'local',
            needs_unlock: false,
            unlocked: true
          },
          {
            display_name: MANAGER.display_name,
            enabled: managerEnabled,
            installed: true,
            name: MANAGER.name,
            needs_unlock: true,
            unlocked: managerEnabled && vault.managerUnlocked
          }
        ]
      }

    case 'vault.source.set': {
      const name = String(params.name ?? '')

      if (name !== MANAGER.name) {
        throw new VaultError(5095, `unknown vault source: ${name}`)
      }

      const enabled = Boolean(params.enabled)
      vault.managerOff = !enabled

      if (!enabled) {
        vault.managerUnlocked = false
      }

      return { enabled, name }
    }

    case 'vault.unlock': {
      const name = String(params.name ?? '')
      const password = String(params.password ?? '')

      if (name !== MANAGER.name || !managerEnabled) {
        throw new VaultError(5095, `${name} is not an enabled password manager`)
      }

      if (!password) {
        throw new VaultError(5095, 'master password is required')
      }

      if (stage.managerPassword === null || password !== stage.managerPassword) {
        // The manager's CLI echoes what it was given; the handler redacts it.
        throw new VaultError(5095, `Invalid master password: ${password}`.split(password).join('[REDACTED]'))
      }

      vault.managerUnlocked = true

      return { name, unlocked: true }
    }

    case 'vault.lock': {
      const name = params.name

      if (!name || name === MANAGER.name) {
        vault.managerUnlocked = false
      }

      return { locked: true }
    }

    case 'vault.add':
      return add(stage, vault, params)

    case 'vault.remove': {
      const id = String(params.id ?? '')

      if (!id) {
        throw new VaultError(5095, 'id is required')
      }

      const before = vault.items.length
      vault.items = vault.items.filter(record => record.id !== id)

      return { removed: vault.items.length !== before }
    }

    default:
      throw new VaultError(-32601, `unknown method: ${method}`)
  }
}

/** What `GET /__fake/vault` shows of one profile: its items with their secrets, and the manager's state. */
export const vaultView = (stage: VaultStage, profile: string) => {
  const vault = stage.profiles.get(profile)

  return {
    calls: stage.calls,
    items: vault?.items ?? [],
    managerEnabled: !(vault?.managerOff ?? false),
    managerUnlocked: vault?.managerUnlocked ?? false
  }
}
