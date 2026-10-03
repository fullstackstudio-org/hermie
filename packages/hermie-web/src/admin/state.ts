/**
 * Everything `/admin` can change, on the service's own disk.
 *
 * ADR-0015's rule still holds and this file is written to respect it: **Hermie
 * Web has no user database and is not going to grow one.** Nothing here
 * authenticates anybody and nothing here is an account. What it holds is a list
 * of gateway user ids the operator has marked as administrators, a note of who
 * has been seen signing in, and a handful of settings about THIS SERVICE —
 * push, the cache, the branding the app bootstraps with, and the feature flags.
 *
 * Two consequences of that worth stating before anybody reads further:
 *
 *  - **An id in `admins` is not a credential.** It names somebody the gateway
 *    has to authenticate first; this service only decides what that person may
 *    then do here.
 *  - **The per-user options are SERVICE-level, not gateway-level.** They are
 *    what this proxy and this push daemon will do. They are not a permission
 *    system and the file says so wherever they are read; see `access.ts`.
 *
 * Stored the way the push state is stored, for the same reasons: one JSON file,
 * `0600`, in a `0700` directory, written through a temp file and a rename, and
 * every read failure answering an empty state rather than taking the service
 * down over a file it could ignore.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { PUSH_TYPES, type PushType } from '../push/registrations'

export const ADMIN_STATE_VERSION = 1
export const ADMIN_STATE_FILE = 'admin.json'

/** What the service will do about one person, as an operator decided it. */
export interface AdminUserOptions {
  /** Bot names this person may reach, or `null` for "all of them". */
  allowedBots: string[] | null
  /** Refuse this person's mutating HTTP requests. See `access.ts` for the limit. */
  readOnly: boolean
  /** Whether the push daemon may notify this person's devices. */
  pushAllowed: boolean
}

export interface AdminUserRow extends AdminUserOptions {
  userId: string
  displayName: string
  email: string
  /** Unix seconds this service last saw them make a request. */
  seenAt: number
  /**
   * Whether the built-in issuer vouches for this id.
   *
   * Set by `people.ts`, and stored rather than derived because the question is
   * asked when the account is already gone — see that file for why the answer
   * cannot be worked out from what is left. Absent on every row a deployment
   * wrote before this existed, which reads as false and is correct: nothing
   * created those from an account.
   */
  fromIssuer?: boolean
}

/** What the push daemon does, as far as an operator gets to decide it. */
export interface AdminPushSettings {
  /** Which event kinds may be sent at all, whatever a device asked for. */
  types: Record<PushType, boolean>
  /**
   * What a notification may contain.
   *
   * `device` leaves it to each device's own `preview` flag, which is ADR-0017's
   * behaviour and the default. `never` overrides every device: the bot's name
   * and nothing else, on a shared or regulated deployment where a message
   * summary on a lock screen is not acceptable.
   */
  preview: 'device' | 'never'
}

export interface AdminCacheSettings {
  /**
   * Hours an entry may go unread before the service drops it, or `0` for "only
   * the size cap decides", which is ADR-0025's behaviour.
   */
  retentionHours: number
}

/** What the app bootstraps with, so a team's build looks like the team's. */
export interface AdminBranding {
  /** Shown instead of "Hermie" where the app names itself. Empty is the default. */
  name: string
  /** One of the app's accent names, or `''` for the reader's own choice. */
  accent: string
  /** A theme preset name the app starts on, or `''` to leave it to the reader. */
  theme: string
}

/** Service features an operator can turn off for everybody. */
export interface AdminFlags {
  /** ADR-0007's amendment: per-user chats. On by default. */
  userChats: boolean
  /** ADR-0025's message cache. Off here does not delete what is stored. */
  messageCache: boolean
  /** Whether the Settings screen may offer the self-update button at all. */
  selfUpdate: boolean
}

export interface AdminState {
  v: number
  /** Gateway user ids that may open `/admin`. */
  admins: string[]
  /**
   * Which entries in `admins` are there SOLELY because a past `HERMIE_ADMINS`
   * reconcile put them there (`admin/env-admins.ts`).
   *
   * Recorded POSITIVELY, and only at the moment an env reconcile adds a NEW
   * id — never derived from "not otherwise accounted for". That is
   * deliberate: this file used to track the opposite (who put an id there
   * BY HAND), and dropping "not manual" over into "therefore env-managed"
   * turned out unsound the moment an id reached `admins` any THIRD way — a
   * hand-edited file, a migration, a role granted on `/admin/oidc` before
   * that path recorded anything — because none of those ever had a reason to
   * mark themselves manual, and the next reconcile read that silence as
   * license to drop them. Tracking the positive fact instead means an id
   * never touched by `env-admins.ts` is never touched by it later either,
   * whatever else is true about how it got onto `admins`.
   *
   * A subset of `admins` by construction — `env-admins.ts` never adds one
   * without the other — so nothing here ever names somebody `admins` itself
   * does not. Absent on every file written before this existed, which reads
   * as `[]`: nothing wrote it, so nothing is here because of it, which is the
   * safe (and correct) reading of "before this feature existed at all".
   */
  managedAdmins: string[]
  /**
   * The local administrator, for a gateway with no accounts.
   *
   * `scrypt`, a per-credential salt, and the hash — never the secret. A token
   * gateway names nobody, so there is no user id to put in `admins` and this is
   * the only way an operator can come back to the page they set up.
   */
  localAdmin?: { salt: string; hash: string }
  push: AdminPushSettings
  cache: AdminCacheSettings
  branding: AdminBranding
  flags: AdminFlags
  /** Everyone this service has seen, by gateway user id. */
  users: Record<string, AdminUserRow>
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

export const DEFAULT_USER_OPTIONS: AdminUserOptions = { allowedBots: null, readOnly: false, pushAllowed: true }

export function emptyAdminState(): AdminState {
  return {
    v: ADMIN_STATE_VERSION,
    admins: [],
    managedAdmins: [],
    push: {
      // Everything on: this is a CEILING an operator can lower, not a second
      // opt-in on top of the one each device already made. A default of "off"
      // would silence every phone the moment the file appeared.
      types: Object.fromEntries(PUSH_TYPES.map(type => [type, true])) as Record<PushType, boolean>,
      preview: 'device'
    },
    cache: { retentionHours: 0 },
    branding: { name: '', accent: '', theme: '' },
    flags: { userChats: true, messageCache: true, selfUpdate: true },
    users: {}
  }
}

function userRowOf(userId: string, raw: Record<string, unknown>): AdminUserRow {
  const allowed = raw.allowedBots

  return {
    userId,
    displayName: str(raw.displayName),
    email: str(raw.email),
    seenAt: num(raw.seenAt),
    // `null` and `[]` are different answers: no list is "every bot", an empty
    // list is "no bots at all", and an operator has to be able to say both.
    allowedBots: Array.isArray(allowed) ? allowed.filter((name): name is string => typeof name === 'string') : null,
    readOnly: bool(raw.readOnly, false),
    pushAllowed: bool(raw.pushAllowed, true),
    // Only written when it is true, so a file from before this field looks
    // exactly like one whose rows are nobody's account — which they are.
    ...(raw.fromIssuer === true ? { fromIssuer: true } : {})
  }
}

/** Read the file defensively — an operator may have edited it by hand. */
export function adminStateOf(parsed: unknown): AdminState {
  const raw = (parsed ?? {}) as Record<string, unknown>

  if (num(raw.v) !== ADMIN_STATE_VERSION) {
    return emptyAdminState()
  }

  const base = emptyAdminState()
  const push = (raw.push ?? {}) as Record<string, unknown>
  const types = (push.types ?? {}) as Record<string, unknown>
  const cache = (raw.cache ?? {}) as Record<string, unknown>
  const branding = (raw.branding ?? {}) as Record<string, unknown>
  const flags = (raw.flags ?? {}) as Record<string, unknown>
  const local = (raw.localAdmin ?? {}) as Record<string, unknown>
  const users: Record<string, AdminUserRow> = {}

  for (const [userId, row] of Object.entries((raw.users ?? {}) as Record<string, Record<string, unknown>>)) {
    if (userId) {
      users[userId] = userRowOf(userId, row ?? {})
    }
  }

  const admins = Array.isArray(raw.admins)
    ? raw.admins.filter((id): id is string => typeof id === 'string' && !!id)
    : []
  /*
    `managedAdmins` is read literally, intersected with `admins` so a
    hand-edited file cannot name somebody `admins` itself does not. Absent
    entirely — every file written before this existed — reads as `[]`: no
    admin on such a file is there because of a `HERMIE_ADMINS` reconcile this
    build ran, since the feature did not exist yet to run one.
  */
  const managedAdmins = Array.isArray(raw.managedAdmins)
    ? raw.managedAdmins.filter((id): id is string => typeof id === 'string' && admins.includes(id))
    : []

  return {
    v: ADMIN_STATE_VERSION,
    admins,
    managedAdmins,
    ...(str(local.salt) && str(local.hash) ? { localAdmin: { salt: str(local.salt), hash: str(local.hash) } } : {}),
    push: {
      types: Object.fromEntries(PUSH_TYPES.map(type => [type, bool(types[type], base.push.types[type])])) as Record<
        PushType,
        boolean
      >,
      preview: push.preview === 'never' ? 'never' : 'device'
    },
    cache: { retentionHours: Math.max(0, Math.floor(num(cache.retentionHours))) },
    branding: { name: str(branding.name), accent: str(branding.accent), theme: str(branding.theme) },
    flags: {
      userChats: bool(flags.userChats, true),
      messageCache: bool(flags.messageCache, true),
      selfUpdate: bool(flags.selfUpdate, true)
    },
    users
  }
}

export function adminStatePath(stateDir: string): string {
  return path.join(stateDir, ADMIN_STATE_FILE)
}

export async function loadAdminState(stateDir: string): Promise<AdminState> {
  try {
    return adminStateOf(JSON.parse(await readFile(adminStatePath(stateDir), 'utf8')))
  } catch {
    // No file, an unreadable one, or one from a version this build does not
    // know. All three are the same answer: nothing is configured yet.
    return emptyAdminState()
  }
}

/**
 * The write still in flight for each state file, by resolved path.
 *
 * Every write of `admin.json` joins one chain per file, so writes land on disk
 * in the order they were asked for. Without it two overlapping writes (a
 * `noteSeen` fired without an await and an `/admin` save right behind it, say)
 * could finish in either order, and the older snapshot landing last silently
 * undid an administrator just added or removed. The tail stored here never
 * rejects, so a write that failed does not stop the ones queued after it.
 */
const pendingWrites = new Map<string, Promise<void>>()
let writeSequence = 0

async function writeAdminFile(stateDir: string, target: string, body: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  // `mkdir`'s mode only applies on create, so a directory that existed with
  // wider permissions is narrowed here — the same thing `savePushState` does.
  await chmod(stateDir, 0o700).catch(() => undefined)

  // A name of its own per write, so no two writes ever share a temp file: not
  // two in this process, and not this process and another one beside it.
  writeSequence += 1
  const temporary = `${target}.${process.pid}.${writeSequence}.${randomBytes(4).toString('hex')}.tmp`

  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * Write the whole state, after every write of the same file asked for before it.
 *
 * The state is serialised NOW, at the call, so what lands is what the caller
 * held when it asked, not whatever the object looks like by the time the chain
 * reaches it. The returned promise rejects if THIS write failed; the chain
 * carries on regardless.
 */
export async function saveAdminState(stateDir: string, state: AdminState): Promise<void> {
  const target = path.resolve(adminStatePath(stateDir))
  const body = `${JSON.stringify(state, null, 2)}\n`
  const previous = pendingWrites.get(target) ?? Promise.resolve()
  const write = previous.then(() => writeAdminFile(stateDir, target, body))
  const tail = write.catch(() => undefined)

  pendingWrites.set(target, tail)
  void tail.then(() => {
    if (pendingWrites.get(target) === tail) {
      pendingWrites.delete(target)
    }
  })

  return write
}

/**
 * Resolves once every write of this state file asked for so far has finished,
 * whether it succeeded or not. For a caller that fired a write without awaiting
 * it (`noteSeen`) and now needs the file to say what memory says.
 */
export function adminStateSettled(stateDir: string): Promise<void> {
  return pendingWrites.get(path.resolve(adminStatePath(stateDir))) ?? Promise.resolve()
}

/** This person's options, or the defaults for somebody nobody has decided about. */
export function optionsFor(state: AdminState, userId: string): AdminUserOptions {
  const row = state.users[userId]

  return row
    ? { allowedBots: row.allowedBots, readOnly: row.readOnly, pushAllowed: row.pushAllowed }
    : DEFAULT_USER_OPTIONS
}

/** Is this bot one this person may reach? `null` means every bot. */
export function mayReachBot(options: AdminUserOptions, bot: string): boolean {
  return options.allowedBots === null || options.allowedBots.includes(bot)
}
