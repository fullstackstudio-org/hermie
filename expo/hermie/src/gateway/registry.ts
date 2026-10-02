/**
 * Every gateway this device knows about, and which one is live.
 *
 * [ADR-0006](../../../../docs/adr/0006-single-gateway-no-relay.md) said one
 * gateway per install, and the reason it gave was about the RELAY — a phone
 * cannot be the router between two gateways, because a backgrounded app
 * delivers some messages and silently drops the rest. That reason has not
 * changed and nothing here changes it: Hermie still holds exactly one live
 * connection, still runs no relay loop, and bots still talk to each other only
 * inside the gateway they live on. What this file adds is the thing the ADR
 * folded in with it and did not have to: that CHANGING gateway meant running
 * setup again and throwing the local cache away.
 *
 * So a gateway is a record rather than a single stored config, and the app
 * keeps a list of them with one marked active.
 *
 * **It is not synced, and that is a decision rather than an omission.** A list
 * of gateways is per device by nature: which machines this phone can reach is a
 * fact about this phone and the networks it is on, not about whoever is signed
 * in. It also cannot be synced without choosing a gateway to sync it TO, which
 * is the question this list exists to answer. `ui_meta` therefore never carries
 * it; the key-value store does.
 *
 * **The id is random and it is not the address.** Two entries may legitimately
 * hold the same address — the same host reached under two accounts — and an
 * address is a thing a reader edits. Everything else in the app keys off the
 * id, so the whole of what an edited address costs is one row redrawing.
 */
import { gatewayKeyOf, type GatewayAuthMode } from '@hermie/gateway-client'

import { keyValueStore } from '../platform/key-value-store'
import { randomBytes } from '../platform/random'
import {
  clearCredentials,
  CONFIG_KEY,
  configKeyFor,
  saveGatewaySetup,
  type SaveGatewaySetupInput,
  type StoredGatewayConfig
} from './config'
import { namespace, NAMESPACE_SEPARATOR } from './namespace'
import { publishShareDeliveryCredential } from './share-credential'

/** The registry itself. Device-level: never namespaced, never synced. */
export const GATEWAY_REGISTRY_KEY = 'hermie.gateways'

/**
 * Bumped when a field changes meaning. A reader that meets a version it does
 * not know keeps its own copy rather than guessing at a shape — the same rule
 * ADR-0016 applies to a `ui_meta` section.
 */
export const GATEWAY_REGISTRY_VERSION = 1

export interface GatewayRecord {
  /** Random, minted once, never derived from the address. See the note above. */
  id: string
  /** The wizard's default is the address's host; the reader may rename it. */
  name: string
  /** The base URL, exactly as the wizard settled on it. */
  address: string
  authKind: GatewayAuthMode
  /** Who the gateway said this is, when it ever named anybody. */
  signedInUser?: string
  /** Epoch milliseconds. Only used to keep the list in a stable order. */
  addedAt: number
}

export interface GatewayRegistry {
  v: number
  gateways: GatewayRecord[]
  /** `null` only while the list is empty, which is a device with no setup yet. */
  activeGatewayId: string | null
}

export const EMPTY_REGISTRY: GatewayRegistry = { v: GATEWAY_REGISTRY_VERSION, gateways: [], activeGatewayId: null }

/**
 * An id for one gateway entry.
 *
 * The same shape as the push installation id and for the same reason: it does
 * not have to be unguessable, but it does have to not collide with the entry
 * added ten seconds later, and a counter or a timestamp would. It is also what
 * every namespaced storage key is suffixed with, so it is deliberately limited
 * to hex — a separator that can appear inside an id is a key that can be read
 * two ways.
 */
export function newGatewayId(): string {
  return `g${[...randomBytes(8)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** True for a string this build minted, or could have. Ids reach us from disk. */
export const isGatewayId = (value: unknown): value is string =>
  typeof value === 'string' && /^g[0-9a-f]{2,64}$/u.test(value)

/**
 * What a new entry is called before anybody renames it.
 *
 * The host, because that is the word the owner used when they typed the
 * address, and it is the one part of a URL that is a name rather than a route.
 * An address that will not parse keeps its whole string: it is still what the
 * reader typed, and "Unknown" in a list of gateways names nothing.
 */
export function defaultGatewayName(address: string): string {
  const trimmed = address.trim()

  try {
    return new URL(trimmed).hostname || trimmed
  } catch {
    return trimmed
  }
}

/**
 * What to CALL one gateway on screen.
 *
 * Its stored name, and its host when that name is empty. Every entry is minted
 * with `defaultGatewayName` so the second half is rarely reached — but a rename
 * field can be emptied, and a switcher whose rows are blank names one gateway as
 * well as the next.
 */
export function gatewayLabel(gateway: GatewayRecord): string {
  return gateway.name.trim() || defaultGatewayName(gateway.address)
}

/** The active entry, or `null` when the list is empty or the pointer is stale. */
export function activeGatewayOf(registry: GatewayRegistry): GatewayRecord | null {
  return registry.gateways.find(gateway => gateway.id === registry.activeGatewayId) ?? null
}

export function gatewayById(registry: GatewayRegistry, id: string | null | undefined): GatewayRecord | null {
  return id ? (registry.gateways.find(gateway => gateway.id === id) ?? null) : null
}

/**
 * The entry a notification's or a link's `gatewayKey` names, or `null`.
 *
 * The one direction the wire can travel: a key is derived from an address, so
 * this is a search rather than a lookup. Two entries CAN legitimately hold the
 * same address — the same host under two accounts — and the first is taken,
 * knowingly: the two are the same machine, the chat being opened exists on
 * both, and the alternative is refusing to act on a notification that named a
 * gateway perfectly well.
 */
export function gatewayForKey(registry: GatewayRegistry, key: string): GatewayRecord | null {
  if (!key) {
    return null
  }

  return registry.gateways.find(gateway => gatewayKeyOf(gateway.address) === key) ?? null
}

/**
 * Add an entry. The first one added is active; a later one is not.
 *
 * That asymmetry is the whole of "Add gateway" in Settings: a reader adding a
 * second gateway is describing a machine, not asking to be moved onto it, and
 * an add that switched would tear down a live connection somebody was using.
 * The first entry is different only because there is nothing to tear down and
 * nowhere else to point.
 */
export function addGateway(registry: GatewayRegistry, record: GatewayRecord): GatewayRegistry {
  const gateways = [...registry.gateways.filter(gateway => gateway.id !== record.id), record]

  return {
    ...registry,
    gateways,
    activeGatewayId: registry.activeGatewayId ?? record.id
  }
}

/** Replace one entry's fields, leaving every other entry alone. */
export function updateGateway(
  registry: GatewayRegistry,
  id: string,
  patch: Partial<Omit<GatewayRecord, 'id'>>
): GatewayRegistry {
  return {
    ...registry,
    gateways: registry.gateways.map(gateway => (gateway.id === id ? { ...gateway, ...patch } : gateway))
  }
}

export function renameGateway(registry: GatewayRegistry, id: string, name: string): GatewayRegistry {
  const trimmed = name.trim()
  const current = gatewayById(registry, id)

  // An empty name would leave a row with nothing on it, so it falls back to
  // what the wizard would have called it rather than being refused: the reader
  // cleared the field, which reads as "use the default", not as an error.
  return updateGateway(registry, id, { name: trimmed || defaultGatewayName(current?.address ?? '') })
}

/**
 * Take one out, and leave a list that still points somewhere.
 *
 * Removing the ACTIVE entry moves the pointer to whatever is left, oldest
 * first, so that the app lands on a gateway rather than on the wizard whenever
 * it still has one. An empty list points at nothing, which is the state a fresh
 * install is in and the one the wizard already owns.
 */
export function removeGateway(registry: GatewayRegistry, id: string): GatewayRegistry {
  const gateways = registry.gateways.filter(gateway => gateway.id !== id)

  if (registry.activeGatewayId !== id) {
    return { ...registry, gateways }
  }

  return { ...registry, gateways, activeGatewayId: gateways[0]?.id ?? null }
}

/** Point at another entry. An id that is not in the list is ignored. */
export function setActiveGateway(registry: GatewayRegistry, id: string): GatewayRegistry {
  return registry.gateways.some(gateway => gateway.id === id) ? { ...registry, activeGatewayId: id } : registry
}

/** The list in the order a screen draws it: oldest first, so rows do not move. */
export function gatewaysInOrder(registry: GatewayRegistry): GatewayRecord[] {
  return [...registry.gateways].sort((left, right) => left.addedAt - right.addedAt || left.id.localeCompare(right.id))
}

const AUTH_KINDS: readonly GatewayAuthMode[] = ['native_pkce', 'session_token', 'cookie']

/** Read one row defensively: it arrived from disk and may predate any field here. */
function asRecord(value: unknown): GatewayRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const raw = value as Record<string, unknown>

  if (!isGatewayId(raw.id) || typeof raw.address !== 'string' || !raw.address) {
    return null
  }

  const authKind = (AUTH_KINDS as readonly string[]).includes(raw.authKind as string)
    ? (raw.authKind as GatewayAuthMode)
    : 'native_pkce'

  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : defaultGatewayName(raw.address),
    address: raw.address,
    authKind,
    ...(typeof raw.signedInUser === 'string' && raw.signedInUser ? { signedInUser: raw.signedInUser } : {}),
    addedAt: typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0
  }
}

/** Read a stored registry, dropping rows that are not rows. */
export function asRegistry(value: unknown): GatewayRegistry {
  if (!value || typeof value !== 'object') {
    return EMPTY_REGISTRY
  }

  const raw = value as Record<string, unknown>

  if (raw.v !== GATEWAY_REGISTRY_VERSION) {
    return EMPTY_REGISTRY
  }

  const gateways = (Array.isArray(raw.gateways) ? raw.gateways : [])
    .map(asRecord)
    .filter((record): record is GatewayRecord => record !== null)

  const activeGatewayId =
    typeof raw.activeGatewayId === 'string' && gateways.some(gateway => gateway.id === raw.activeGatewayId)
      ? raw.activeGatewayId
      : (gateways[0]?.id ?? null)

  return { v: GATEWAY_REGISTRY_VERSION, gateways, activeGatewayId }
}

/**
 * The entry a single stored config becomes.
 *
 * Everything on it is already on disk, which is what makes this a rename rather
 * than a question: the address and the auth mode come off the config, and the
 * name is the host the reader typed. `addedAt` is now, because there is no
 * record of when the gateway was first set up and a made-up earlier date would
 * be a fact nobody established.
 */
export function recordFromConfig(config: StoredGatewayConfig, id: string, now: number): GatewayRecord {
  return {
    id,
    name: defaultGatewayName(config.baseUrl),
    address: config.baseUrl,
    authKind: config.authMode,
    ...(config.userDisplayName ? { signedInUser: config.userDisplayName } : {}),
    addedAt: now
  }
}

/**
 * Fold a freshly saved configuration back into the active entry.
 *
 * The wizard writes a `StoredGatewayConfig`; the registry has to agree with it
 * afterwards, or the list would name an address the app is no longer dialling.
 * With nothing active — a first run, or a reader who removed their last entry
 * and then set one up — this ADDS the entry instead, which is the same sentence
 * from the other end.
 *
 * A name the reader typed survives an address change and a default one does
 * not. Renaming is a statement about the machine ("Work", "The Pi"), and a
 * machine that moved to another address is still that machine; a name that is
 * merely the old host, left behind next to a new one, is just wrong.
 */
export function reconcileActiveGateway(
  registry: GatewayRegistry,
  config: StoredGatewayConfig,
  now: number
): GatewayRegistry {
  const active = activeGatewayOf(registry)

  if (!active) {
    return addGateway(registry, recordFromConfig(config, newGatewayId(), now))
  }

  const renamed = active.name !== defaultGatewayName(active.address)

  return updateGateway(registry, active.id, {
    address: config.baseUrl,
    authKind: config.authMode,
    name: renamed ? active.name : defaultGatewayName(config.baseUrl),
    // Absent rather than empty: the gateway did not name anybody this time, and
    // a blank row under "Signed in as" says less than no row at all.
    ...(config.userDisplayName ? { signedInUser: config.userDisplayName } : { signedInUser: undefined })
  })
}

export interface LoadRegistryResult {
  registry: GatewayRegistry
  /**
   * The id the single stored gateway was given, when this launch was the one
   * that migrated it.
   *
   * The caller needs it because the registry entry is only half of the move:
   * everything else on disk is still under the unsuffixed keys, and
   * `gateway/migrate.ts` is what carries those across. Null on every launch
   * after the first.
   */
  migratedId: string | null
}

/**
 * Read the registry, creating the first entry out of a single stored gateway.
 *
 * The migration runs exactly once and is decided by the registry key being
 * ABSENT rather than by the list being empty: a reader who removed their last
 * gateway has an empty list on purpose, and re-adopting the config they just
 * deleted would put it back on the next launch.
 *
 * A device that has never been set up writes nothing. An abandoned wizard
 * should leave no more behind than it did before this existed.
 */
export async function loadGatewayRegistry(now: number = Date.now()): Promise<LoadRegistryResult> {
  const stored = await keyValueStore.getJson<unknown>(GATEWAY_REGISTRY_KEY)

  if (stored !== null) {
    return { registry: asRegistry(stored), migratedId: null }
  }

  const config = await keyValueStore.getJson<StoredGatewayConfig>(CONFIG_KEY)

  if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
    return { registry: EMPTY_REGISTRY, migratedId: null }
  }

  const id = newGatewayId()
  const registry = addGateway(EMPTY_REGISTRY, recordFromConfig(config, id, now))

  await saveGatewayRegistry(registry)

  return { registry, migratedId: id }
}

export async function saveGatewayRegistry(registry: GatewayRegistry): Promise<void> {
  await keyValueStore.setJson(GATEWAY_REGISTRY_KEY, registry)
  /*
    And the share extension's copy of the active gateway's credential.

    Here rather than at each caller, because this is the ONE place every change
    of "which gateway is live" passes through — onboarding, the switcher, the
    removal of the active entry. A publish written at the call sites instead
    would be a publish somebody forgets at the fourth one, and what that costs
    is a share sheet quietly sending to the gateway the reader switched away
    from an hour ago.

    Awaited, and it cannot throw: it is the last thing this function does, the
    registry is already down, and every failure inside it means the extension
    queues instead of sending. See `share-credential.ts`.
  */
  await publishShareDeliveryCredential(registry.activeGatewayId)
}

/** The prefix every namespaced gateway configuration key starts with. */
const CONFIG_KEY_PREFIX = `${CONFIG_KEY}${NAMESPACE_SEPARATOR}`

/**
 * Take out every stored configuration that no entry in the list claims.
 *
 * An orphan is `hermie.gateway.config@<id>` for an id the registry has never
 * heard of, and until `saveGatewaySetup` was made to write its credentials
 * first there was a way to mint one on every single launch: the configuration
 * landed, a keychain write then rejected, and the caller never reached the line
 * that would have recorded the id. Fifty of them had collected on the iPhone
 * simulator and thirty-nine on the iPad by the time anybody counted, and none
 * of them would ever be read again — the id is random, so nothing can rediscover
 * one, and nothing had written it down.
 *
 * The rule is deliberately the narrowest one that does the job. Only this ONE
 * base key is swept, and only the suffixed form of it:
 *
 *  - other namespaced keys (a chat cache, an auth ring) are left alone, because
 *    they are rebuildable and sweeping them would mean this function deciding
 *    what every feature's storage is worth;
 *  - the UNSUFFIXED `hermie.gateway.config` is left alone, because it is what a
 *    device that predates the registry still boots from and what
 *    `loadGatewayRegistry` adopts its first entry out of. It is the one key
 *    here whose absence from the list means "not migrated yet" rather than
 *    "abandoned".
 *
 * Answers the keys it removed, so a caller can say so rather than guess.
 */
export async function sweepOrphanGatewayConfigs(registry: GatewayRegistry): Promise<string[]> {
  const live = new Set(registry.gateways.map(gateway => gateway.id))
  const orphans = (await keyValueStore.keys()).filter(
    key => key.startsWith(CONFIG_KEY_PREFIX) && !live.has(key.slice(CONFIG_KEY_PREFIX.length))
  )

  if (orphans.length > 0) {
    await keyValueStore.deleteMany(orphans)
  }

  return orphans
}

export interface SaveGatewayInput extends SaveGatewaySetupInput {
  /**
   * The entry to write into, or `null` to mint one.
   *
   * `null` is what the wizard passes in "add" mode and on a first run; an id is
   * what it passes when the reader is editing the gateway they are already on.
   */
  gatewayId?: string | null
  /** Make the entry active. A first entry is active whether or not this is set. */
  activate?: boolean
}

export interface SaveGatewayResult {
  registry: GatewayRegistry
  /** The entry that was written, whether it was minted here or reused. */
  id: string
}

/** `reconcileActiveGateway`'s body, for an entry that is not necessarily active. */
function reconcileGateway(
  registry: GatewayRegistry,
  entry: GatewayRecord,
  config: StoredGatewayConfig
): GatewayRegistry {
  const renamed = entry.name !== defaultGatewayName(entry.address)

  return updateGateway(registry, entry.id, {
    address: config.baseUrl,
    authKind: config.authMode,
    name: renamed ? entry.name : defaultGatewayName(config.baseUrl),
    ...(config.userDisplayName ? { signedInUser: config.userDisplayName } : { signedInUser: undefined })
  })
}

/**
 * Write one gateway's configuration and credentials, and make the list agree.
 *
 * The two halves have to happen together and in this order, which is the whole
 * reason this is a function rather than two calls at each site: a registry
 * entry with no configuration under its id is a gateway the app will show in a
 * list and then fail to dial, and a configuration under an id no entry claims
 * is storage nothing will ever read or clean up.
 *
 * Writing a DIFFERENT address into an existing entry drops that entry's
 * credentials first. The stored access, refresh and session tokens were minted
 * by a gateway this entry no longer points at, and leaving them in the keychain
 * hands the next sign-in a credential from somewhere else.
 *
 * **Nothing here half-happens.** The three writes go credentials, then
 * configuration, then entry — least recoverable first — and each step only runs
 * because the one before it landed. `saveGatewaySetup` holds the first two to
 * that rule; the third is held to it here, by taking the configuration back out
 * if the list cannot be saved. A brand-new gateway therefore either exists
 * completely or not at all, and the caller learns which by whether this threw.
 */
export async function saveGatewayAndRegister(input: SaveGatewayInput): Promise<SaveGatewayResult> {
  const { gatewayId = null, activate = false, ...setup } = input
  const { registry } = await loadGatewayRegistry()
  const existing = gatewayById(registry, gatewayId)
  const id = existing?.id ?? newGatewayId()
  const ns = namespace(id)

  if (existing && existing.address !== setup.config.baseUrl) {
    await clearCredentials(ns)
  }

  await saveGatewaySetup(ns, setup)

  const withEntry = existing
    ? reconcileGateway(registry, existing, setup.config)
    : addGateway(registry, recordFromConfig(setup.config, id, Date.now()))

  const next = activate ? setActiveGateway(withEntry, id) : withEntry

  try {
    await saveGatewayRegistry(next)
  } catch (error) {
    /*
      The configuration under this id is now storage nothing will ever claim,
      because the id only existed in this function. Take it back out.

      Only for an id minted here: an entry that already existed keeps its
      configuration, which is the one it was dialling a moment ago and is still
      the best thing on disk for it.
    */
    if (!existing) {
      await keyValueStore.delete(configKeyFor(ns)).catch(() => undefined)
    }

    throw error
  }

  return { registry: next, id }
}
