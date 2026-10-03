/**
 * ADR-0016's client: Hermie's own settings, in the gateway's `ui_meta`.
 *
 * `ui_meta` is a free-form object on a profile row with a revision counter PER
 * TOP-LEVEL KEY, and `profiles.configure` takes `ui_meta` together with
 * `ui_meta_expected_revisions` — upstream's docstring, carried verbatim into the
 * generated contract, calls that a per-key compare-and-swap. Everything here
 * follows from that one sentence:
 *
 *  - **A write names only the keys it changes.** `ui_meta` is not ours. The
 *    marker `{"hermes-bots": {}}` is what makes a profile show up as a bot at all
 *    and it belongs to another tool, so a client that stored its settings by
 *    replacing the bag would un-bot every profile it touched. Per-key writes are
 *    what make the scope safe to use, not merely convenient.
 *  - **A section is replaced whole.** The key is the unit, so removing a field
 *    means sending the section without it. There is no merge.
 *  - **Last writer wins, per section, guarded by the revision.** A refused write
 *    comes back as `applied.ui_meta_conflicts[key] = { expected, actual }`; the
 *    client takes the actual revision and writes its own value again. There is no
 *    merge of two divergent arrangements either: an order is a list, and a list
 *    merged with another list is neither of them.
 *
 * **This module owns no state the UI reads.** The device's own store stays the
 * thing the app paints from, so it paints before the socket has answered and
 * works with no gateway at all. What lives here is the revision table, the set of
 * sections that have not reached the gateway yet, and the round trips. The app
 * hands in a `read` for what it currently holds and an `apply` for what the
 * gateway turned out to hold.
 *
 * **The app-wide key carries a person's name.** ADR-0016 put one arrangement on
 * the default profile and accepted that two people on one gateway would share
 * it. They no longer do: the key is `hermie-app:<user_id>`, and the id is the
 * gateway's own identity for whoever is signed in (`owner` where the gateway has
 * no accounts to ask about). The gateway still has no per-user scope — this is
 * the CLIENT keeping two readers apart inside the scope there is — so the
 * separation is exactly as strong as the fact that nobody else writes these
 * keys. The bare `hermie-app` stays readable as the anonymous default and is
 * inherited once; see `inheritedFromLegacy`.
 *
 * **The local-only fallback is a mode, not an error.** A gateway too old to carry
 * `ui_meta`, or one that refuses the write, leaves Hermie exactly where ADR-0012
 * left it: keyed by gateway address, on the device. `mode` says which of the two
 * is in force so a screen can be honest about it, and a refusal is retried on the
 * next reconcile rather than being retried forever.
 */
import { hasPluginCapability, pluginAdvert, PLUGIN_CAPABILITIES, type PluginAdvert } from './plugin'
import type { ProfileRow, ProfilesConfigureResult, ProfilesListResult } from '@hermes/shared/gateway-contract'

/** That bot's profile: everything about one conversation. */
export const HERMIE_KEY = 'hermie'

/**
 * The default profile, the anonymous arrangement, and the name every per-person
 * key is built from.
 *
 * ADR-0016 accepted knowingly that two people on one gateway would share this
 * key — "if the gateway grows [a per-user scope], this is the ADR to supersede".
 * It did not grow one, but the arrangement did not need the GATEWAY to keep them
 * apart: the key is a string this client chooses, so a person's name inside it
 * separates two readers as completely as two keys would.
 *
 * This constant is now the LEGACY key. It is still read — once, to seed a person
 * who has never had a key of their own — and it is no longer written by the app.
 * It stays on the gateway as the anonymous default, which is what an older build
 * on another device will go on reading.
 */
export const HERMIE_APP_KEY = 'hermie-app'

/**
 * One person's app-wide key.
 *
 * `userId` is the gateway's own identity for whoever is signed in, and `owner`
 * on a session-token gateway, where there are no accounts and therefore nobody
 * for the gateway to name — the same fixed id the context section already uses
 * (`OWNER_USER_ID`). So an ungated gateway lands on `hermie-app:owner` and keeps
 * one arrangement, which is the right answer for a gateway with one person on it.
 */
export const appKeyFor = (userId: string): string => `${HERMIE_APP_KEY}:${userId}`

/** The marker another tool owns. Named here only so that a test can say it. */
export const BOT_MARKER_KEY = 'hermes-bots'

/**
 * The schema version each section carries.
 *
 * Two keys, two versions, because they will not move together. A reader that
 * meets a `v` it does not know ignores that section and keeps its local copy
 * rather than guessing at a shape; a writer never lowers it.
 */
export const HERMIE_SECTION_VERSION = 1
export const HERMIE_APP_SECTION_VERSION = 1

/** One bot's section. Anything about one conversation, and nothing else. */
export interface HermieBotSection {
  v: number
  archived?: boolean
  colour?: string
}

/**
 * The app-wide section.
 *
 * Deliberately typed loosely past `v`: the chat list's arrangement and the theme
 * set are the app's shapes, not this module's, and duplicating them here would be
 * a second definition to keep in step with the first. What this module promises
 * about them is only what ADR-0016 promises — that the section travels whole and
 * that its revision guards it.
 */
export interface HermieAppSection {
  v: number
  [key: string]: unknown
}

/**
 * The field the app-wide section dates itself with, in SECONDS.
 *
 * ADR-0016 decided "last writer wins, per section", and for a long time "last"
 * meant whichever device flushed last. That is the right answer for two devices
 * racing in the same second and the wrong one for everything else: a second
 * device that has changed nothing of its own can be holding the section for
 * reasons that have nothing to do with a person choosing anything — its own push
 * row, a disk read that landed late, the live roster folded into the list — and
 * then "last" is the device that reconnected last rather than the choice that was
 * made last. Both reports this field was added for were that: a theme picked on
 * one machine was undone by opening another, and a set of folders with it.
 *
 * So the section says when it was last CHOSEN, and a reconcile compares the two
 * dates rather than trusting whoever arrives second. Seconds rather than
 * milliseconds because it travels beside `context`'s `updatedAt`, which is
 * already in seconds, and because nothing here needs to tell two choices a
 * hundred milliseconds apart from each other.
 *
 * ADDITIVE, and `HERMIE_APP_SECTION_VERSION` deliberately stays at 1 — see the
 * rule on the version constants above. A section written by a build that
 * predates the field is UNDATED, which is not the same as "dated zero": see
 * `appStampOf`.
 */
export const APP_UPDATED_AT = 'updatedAt'

/**
 * When this section was last chosen, or `0` when it does not say.
 *
 * Zero is "undated" and is deliberately the lowest possible answer: a section
 * written by a build that predates the field loses to one that carries a date,
 * because the dated one is the only one that can prove when anybody chose it.
 */
export function appStampOf(section: HermieAppSection | null | undefined): number {
  const raw = section?.[APP_UPDATED_AT]

  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/**
 * What a person's brand-new key inherits from the anonymous one, and what it
 * pointedly does not.
 *
 * The arrangement and the preferences are inherited: somebody who spent an
 * afternoon ordering their list and naming their sections should not find it
 * undone by an app update, and on the overwhelmingly common gateway — one
 * person, one arrangement — the legacy section IS theirs.
 *
 * `push` and `context` are not, and that is the whole reason this function
 * exists rather than the section simply being copied. Both are MAPS KEYED BY
 * DEVICE OR PERSON, and on a shared gateway the legacy key holds everybody's
 * rows mixed together. Copying it would put Bob's phone in Alice's section and
 * Alice's phone in Bob's, and then a notifier that reads both sections sends to
 * each device twice. A registration lost is one connect away from being written
 * again — `PushSync` re-registers this device every time it starts — and a
 * notification delivered twice is not recoverable at all, so the direction to
 * fail in is obvious.
 */
export function inheritedFromLegacy(legacy: HermieAppSection): HermieAppSection {
  const copy: Record<string, unknown> = { ...legacy, v: HERMIE_APP_SECTION_VERSION }

  delete copy.push
  delete copy.context

  return copy as unknown as HermieAppSection
}

/** What the app holds, and what the gateway turned out to hold. */
export interface UiMetaSnapshot {
  app: HermieAppSection | null
  /** Bot name → its section. A bot with no section is simply absent. */
  bots: Record<string, HermieBotSection>
  /**
   * The gateway plugin's advert, when the roster carried one.
   *
   * Read-only and one-directional: the key belongs to the plugin and nothing
   * here ever writes it. It rides on this snapshot rather than on a reader of
   * its own because it comes out of the same `profiles.list` the reconcile
   * already makes, and a second round trip for one key would be a second round
   * trip on every reconnect.
   *
   * `undefined` on a snapshot the APP produced, which says nothing about the
   * gateway; `null` on one the GATEWAY produced with no advert in it, which
   * says the plugin is not there.
   */
  plugin?: PluginAdvert | null
  /**
   * The gateway's own app section, UNMERGED, even when `app` is the local copy.
   *
   * This exists because one `ui_meta` key holds two kinds of thing. The chat
   * arrangement and the theme set are whole values, and for those last-writer-
   * wins per section is the decision ADR-0016 made deliberately. The push
   * registrations and the context users are MAPS KEYED BY DEVICE OR PERSON, and
   * for those it is simply wrong: the entry another device wrote is not a rival
   * version of ours, it is somebody else's.
   *
   * An app cannot merge what it was not shown. `withPendingKept` hands back the
   * LOCAL app section whenever this device is holding an unsent change — which
   * is exactly the state a device is in while it is registering itself — so a
   * reader that took the neighbours out of `app` took them out of its own copy
   * and found none. It then wrote a section with only its own row in it, and
   * the other device's registration was gone. Measured on the owner's gateway:
   * a Mac registered, a reinstalled iPhone registered, and only the iPhone
   * remained.
   *
   * So the gateway's own copy travels beside the merged one, and the per-device
   * maps are always read from here.
   */
  remote?: HermieAppSection | null
  /**
   * The gateway's own copy of whichever section holds the push maps.
   *
   * Usually the same as `remote`. It differs on a gateway whose plugin cannot
   * read a per-person key yet: the arrangement moves there regardless, because
   * nothing but this app reads it, while the registrations stay on the bare
   * `hermie-app` where the notifier is still looking. A registration written
   * somewhere nothing reads is a phone that has silently stopped buzzing, and
   * that is not a thing to find out about by not being woken up.
   */
  pushHome?: HermieAppSection | null
  /**
   * True on the one pull where this person's key did not exist and the legacy
   * one did, so `app` is the anonymous section read through
   * `inheritedFromLegacy`.
   *
   * It is a flag rather than a side effect because of WHEN it has to be acted
   * on: marking the section dirty before `withPendingKept` would make a device
   * holding an offline change discard the inheritance, and marking it after the
   * flush would never write it at all. `reconcile` sets the dirty bit between
   * the two. It cannot fire twice — the next pull finds the new key present.
   */
  migrated?: boolean
}

export type UiMetaMode = 'synced' | 'local'

/** The two calls this needs, so a test can hand over two functions. */
export interface UiMetaGateway {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export interface UiMetaSyncOptions {
  gateway: UiMetaGateway
  /** What the app is holding right now. Asked for at the moment of a write. */
  read: () => UiMetaSnapshot
  /** Hand the gateway's copy to the app. Called once per reconcile. */
  apply: (snapshot: UiMetaSnapshot) => void
  /**
   * How many times a conflicted section is re-sent before it is left dirty.
   *
   * One retry is the whole design: the conflict answer carries the revision that
   * won, so the second attempt cannot fail for the same reason. A second retry
   * would only be needed if a THIRD writer landed between the two, and in that
   * case leaving the section dirty for the next reconcile is the right answer
   * rather than spinning.
   */
  retries?: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Read a section, or `null`.
 *
 * A `v` this build does not know is `null` on purpose — see the note on the
 * version constants. So is a section that is not an object: whatever wrote it,
 * it is not this.
 */
export function readSection<T extends { v: number }>(bag: unknown, key: string, known: number): T | null {
  if (!isObject(bag) || !isObject(bag[key])) {
    return null
  }

  const section = bag[key]
  const version = typeof section.v === 'number' ? section.v : 0

  return version > 0 && version <= known ? (section as unknown as T) : null
}

/** One roster row's revisions, defensively. */
function revisionsOf(row: ProfileRow): Record<string, number> {
  const out: Record<string, number> = {}

  for (const [key, value] of Object.entries(row.ui_meta_revisions ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    }
  }

  return out
}

/** What one section's write asked for and what came back. */
interface Conflict {
  expected: unknown
  actual: number
}

function conflictsOf(result: unknown): Record<string, Conflict> {
  const applied = isObject(result) && isObject(result.applied) ? result.applied : null
  const raw = applied && isObject(applied.ui_meta_conflicts) ? applied.ui_meta_conflicts : null
  const out: Record<string, Conflict> = {}

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (isObject(value) && typeof value.actual === 'number') {
      out[key] = { expected: value.expected, actual: value.actual }
    }
  }

  return out
}

function appliedRevisions(result: unknown): Record<string, number> {
  const applied = isObject(result) && isObject(result.applied) ? result.applied : null
  const raw = applied && isObject(applied.ui_meta_revisions) ? applied.ui_meta_revisions : null
  const out: Record<string, number> = {}

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'number') {
      out[key] = value
    }
  }

  return out
}

export class UiMetaSync {
  private readonly gateway: UiMetaGateway
  private readonly read: () => UiMetaSnapshot
  private readonly apply: (snapshot: UiMetaSnapshot) => void
  private readonly retries: number

  /** profile name → the revision this client last read for ITS OWN key there. */
  private readonly revisions = new Map<string, number>()

  /** The default profile, learnt from the roster. The app key lives on it. */
  private defaultProfile: string | null = null

  /**
   * The gateway's identity for whoever is signed in, or empty while nobody has
   * been named.
   *
   * Empty is not a state to paper over with a fallback to the legacy key. The
   * app-wide section now holds one PERSON's arrangement, and writing it under a
   * name the gateway never agreed to is the same mistake the context section
   * already refuses to make. So an unnamed reader syncs their per-bot sections
   * and keeps their arrangement on the device, which is exactly where ADR-0012
   * had it and is not a degraded mode to apologise for.
   */
  private userId = ''

  /**
   * Whether the gateway's plugin said it reads `hermie-app:<user_id>`.
   *
   * It gates the PUSH half only — see `UiMetaSnapshot.pushHome`. False is the
   * honest default: an absent advert, a plugin too old to write one and no
   * plugin at all are indistinguishable, and all three mean "do not assume".
   */
  private perUser = false

  /** The bare key as the gateway holds it, for the read-modify-write above. */
  private legacyApp: HermieAppSection | null = null

  /** Sections written locally that the gateway has not taken yet. */
  private readonly dirtyBots = new Set<string>()
  private dirtyApp = false

  /**
   * Counts every mark. Each dirty section remembers the count of its latest
   * mark, and a landed write cleans only the sections whose mark it carried: an
   * edit made while the write was out stays dirty and goes in a further round
   * (the Swift app's `UIMetaState.markCount`). Before this, a write that landed
   * cleaned an edit made during its flight, which then reverted on the next
   * reconcile.
   */
  private markCount = 0
  private appMark = 0
  private readonly botMarks = new Map<string, number>()

  /**
   * Whether the app section's unsent change includes a CHOICE, or only chores
   * (housekeeping nobody decided: a roster folded in, a lapsed mute swept).
   *
   * A chore never wins over the gateway's content: an undated chore against an
   * undated section would otherwise keep the local copy (the offline rule in
   * `appLocalWins`), and a flat list folded on a fresh device would replace the
   * person's folders. `markApp()` with no argument is a choice, which is what
   * every caller meant before chores were told apart.
   */
  private appChoice = false

  private currentMode: UiMetaMode = 'local'
  private flushing: Promise<void> | null = null

  constructor(options: UiMetaSyncOptions) {
    this.gateway = options.gateway
    this.read = options.read
    this.apply = options.apply
    this.retries = options.retries ?? 1
  }

  /** `synced` once a roster has been read and no write has been refused since. */
  get mode(): UiMetaMode {
    return this.currentMode
  }

  /** This person's app-wide key, or `null` while the gateway has named nobody. */
  get appKey(): string | null {
    return this.userId ? appKeyFor(this.userId) : null
  }

  /**
   * Say who the gateway thinks this is, before the first reconcile.
   *
   * A different person on the same socket is a different key, a different
   * revision and a different arrangement, so the pending app write is dropped
   * rather than carried across: it was written under the previous reader's name
   * and re-sending it would be this reader publishing somebody else's list. The
   * bot sections are untouched — archived and colour are about the bot, not
   * about who is looking at it.
   */
  setUser(userId: string): void {
    if (userId === this.userId) {
      return
    }

    this.userId = userId
    this.dirtyApp = false
    this.appChoice = false
  }

  /** True while something written locally has not reached the gateway. */
  get pending(): boolean {
    return this.dirtyApp || this.dirtyBots.size > 0
  }

  /**
   * Record that one bot's section changed locally.
   *
   * It does NOT take the section: the app's store is the source, and passing a
   * value here would let the two disagree in the window between the call and the
   * flush. `read()` is asked at the moment the write goes out.
   */
  markBot(botName: string): void {
    this.markCount += 1
    this.botMarks.set(botName, this.markCount)
    this.dirtyBots.add(botName)
  }

  /**
   * Record that the app-wide section changed locally: a `choice` (the default)
   * or a `chore`, which is sent but never wins over the gateway's copy.
   */
  markApp(kind: 'choice' | 'chore' = 'choice'): void {
    this.markCount += 1
    this.appMark = this.markCount
    this.dirtyApp = true

    if (kind === 'choice') {
      this.appChoice = true
    }
  }

  /** The bots whose sections have not reached the gateway, in the order they were marked. */
  get pendingBots(): string[] {
    return [...this.dirtyBots]
  }

  /**
   * Read the gateway's copy, hand it to the app, then send whatever is dirty.
   *
   * This is the whole of the reconciliation ADR-0016 asks for on connect and on a
   * profile-change event. The order matters: reading first is what gives a
   * conflicted write the revision it needs, and sending after is what stops a
   * remote copy from overwriting a change made while the socket was down —
   * because that change is still dirty and goes out immediately behind it.
   */
  async reconcile(): Promise<UiMetaSnapshot | null> {
    const remote = await this.pull()

    if (!remote) {
      return null
    }

    this.noteNewerLocalApp(remote)
    this.dropLosingChores(remote)

    const snapshot = this.withPendingKept(remote)

    this.apply(snapshot)
    this.seedWhatTheGatewayLacks(remote)

    /*
      The inheritance is only half done until it is written back. `pull` read
      the anonymous section and `apply` has just put it into the stores; marking
      the key dirty here is what puts a copy under this person's name, and doing
      it between the apply and the flush is what makes both halves land in one
      reconcile. See `UiMetaSnapshot.migrated` for why it is not a side effect of
      the pull itself.
    */
    if (remote.migrated) {
      this.markApp()
    }

    await this.flush()

    return snapshot
  }

  /**
   * A local app section dated later than the gateway's is an UNSENT CHANGE.
   *
   * The dirty bit lives in this object and this object lives with a socket, so a
   * change made with no gateway and then followed by a relaunch arrives at the
   * next reconcile with nothing marked. Before the section carried a date there
   * was no way to know: the local copy and the gateway's were two values with no
   * order between them. There is one now, so the question can be asked of the
   * data rather than of what this process happens to remember — which is the same
   * move `seedWhatTheGatewayLacks` makes for a key that is not there at all.
   *
   * Not on the inheritance pull. There `app` is the ANONYMOUS section, read to be
   * copied into this person's brand-new key, and `migrated` is what puts it there
   * a few lines further down. A device with a dated local copy would otherwise
   * discard an arrangement made on a build that had no dates to offer, which is
   * the one comparison this field cannot settle.
   */
  private noteNewerLocalApp(remote: UiMetaSnapshot): void {
    if (remote.migrated) {
      return
    }

    const local = this.read()

    if (local.app && appStampOf(local.app) > appStampOf(remote.app)) {
      this.markApp()
    }
  }

  /**
   * An unsent app change made only of chores loses to any section the gateway
   * holds, and is dropped rather than sent: it is housekeeping the app redoes on
   * top of whatever it takes (the roster is folded in again), and nobody chose
   * it. See `appChoice`.
   */
  private dropLosingChores(remote: UiMetaSnapshot): void {
    if (this.dirtyApp && !this.appChoice && remote.app) {
      this.dirtyApp = false
    }
  }

  /**
   * A section this device has and the gateway does not is SENT, not dropped.
   *
   * Without this, a gateway only ever learns an arrangement from a device that
   * changes one AFTER connecting: somebody who spent an afternoon ordering their
   * list and then signed in on a tablet would find the tablet empty and the
   * gateway still empty, with both devices politely waiting for the other to go
   * first. An absent key is not a decision anybody made; a present one is, and
   * that is the asymmetry this leans on.
   *
   * It is deliberately not the reverse. A section the GATEWAY has and this device
   * does not is simply taken, which is what `apply` just did.
   */
  private seedWhatTheGatewayLacks(remote: UiMetaSnapshot): void {
    const local = this.read()

    if (!remote.app && local.app) {
      this.markApp()
    }

    for (const [name, section] of Object.entries(local.bots)) {
      if (section && !remote.bots[name]) {
        this.markBot(name)
      }
    }
  }

  /**
   * The gateway's copy, except where this device is still holding a change.
   *
   * Without this, a reconcile after a spell with no socket would hand the app the
   * remote value, overwrite the change that was made offline, and then flush THAT
   * back — so a change made on a plane would not merely fail to arrive, it would
   * be erased on landing by the device that made it.
   *
   * For a BOT section a dirty section is a section whose newest value is the
   * local one by definition. For the app-wide section it is not — see
   * `appLocalWins`, which is what the dates are for.
   */
  private withPendingKept(remote: UiMetaSnapshot): UiMetaSnapshot {
    if (!this.pending) {
      return remote
    }

    const local = this.read()
    const bots = { ...remote.bots }
    // The advert is the gateway's either way: it is never local and never dirty.
    const plugin = remote.plugin ?? null

    for (const botName of this.dirtyBots) {
      const section = local.bots[botName]

      if (section) {
        bots[botName] = section
      } else {
        delete bots[botName]
      }
    }

    return {
      app: this.appLocalWins(local.app, remote.app) ? local.app : remote.app,
      bots,
      plugin,
      remote: remote.app,
      pushHome: remote.pushHome ?? null
    }
  }

  /**
   * Whose app-wide section is the newer one: this device's, or the gateway's.
   *
   * The dirty bit alone cannot answer it. It says "this device is holding a
   * section the gateway has not taken", and a device holds one for reasons that
   * are not a person choosing anything: the section also carries the push
   * registrations and the context row, a disk read can land after the reconcile,
   * and the live roster gets folded into the list on every connect. Treating all
   * of that as "mine is newer" is how a theme chosen on one machine was undone by
   * opening another — and not merely undone locally: the losing device then
   * flushed its own copy, so the choice was gone for every device.
   *
   * So the dates decide, and the rules are the ones ADR-0016 already implies:
   *
   *  - **Newer wins.** Whoever chose last is who the person is.
   *  - **Equal goes to the gateway.** Two devices that agree to the second have
   *    nothing to argue about, and one of them has to stop.
   *  - **Undated on both sides keeps the local copy**, which is the behaviour
   *    before this field existed and the one the offline case needs: a change
   *    made with no socket, by a build or a device that has no date to offer, is
   *    still a change and must not be erased on landing.
   *  - **A chore never wins over a section the gateway holds** (`appChoice`):
   *    nobody chose it, and undated against undated would otherwise hand a
   *    folded flat list the person's folders.
   *  - **A gateway with no section at all takes ours.** There is nothing up there
   *    to lose, and `seedWhatTheGatewayLacks` says why an absent key is not a
   *    decision anybody made.
   *
   * Note what stays true when the gateway wins: the section is still DIRTY, so
   * it is still flushed — and `sectionsFor` re-reads the app afterwards, by which
   * time `apply` has put the gateway's values into the stores. What goes out is
   * therefore the gateway's arrangement with this device's own push row folded
   * into it, rather than either half on its own.
   */
  private appLocalWins(local: HermieAppSection | null, remote: HermieAppSection | null): boolean {
    if (!this.dirtyApp) {
      return false
    }

    if (!remote) {
      return true
    }

    if (!local || !this.appChoice) {
      return false
    }

    const localAt = appStampOf(local)
    const remoteAt = appStampOf(remote)

    if (localAt === 0 && remoteAt === 0) {
      return true
    }

    return localAt > remoteAt
  }

  /** Read `profiles.list` and project the two keys out of it. */
  async pull(): Promise<UiMetaSnapshot | null> {
    let result: ProfilesListResult

    try {
      result = (await this.gateway.request('profiles.list', {})) as ProfilesListResult
    } catch {
      // A roster this client cannot read is a gateway it cannot sync with. That
      // is the local-only path, not an error to put in front of anybody.
      this.currentMode = 'local'

      return null
    }

    const rows = Array.isArray(result?.profiles) ? result.profiles : []
    const bots: Record<string, HermieBotSection> = {}
    const plugin = pluginAdvert(rows)
    const appKey = this.appKey
    let app: HermieAppSection | null = null
    let legacy: HermieAppSection | null = null

    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name : ''

      if (!name) {
        continue
      }

      const revisions = revisionsOf(row)
      const section = readSection<HermieBotSection>(row.ui_meta, HERMIE_KEY, HERMIE_SECTION_VERSION)

      this.revisions.set(`${name}:${HERMIE_KEY}`, revisions[HERMIE_KEY] ?? 0)

      if (section) {
        bots[name] = section
      }

      if (row.is_default === true) {
        this.defaultProfile = name
        legacy = readSection<HermieAppSection>(row.ui_meta, HERMIE_APP_KEY, HERMIE_APP_SECTION_VERSION)
        this.revisions.set(`${name}:${HERMIE_APP_KEY}`, revisions[HERMIE_APP_KEY] ?? 0)

        if (appKey) {
          this.revisions.set(`${name}:${appKey}`, revisions[appKey] ?? 0)
          app = readSection<HermieAppSection>(row.ui_meta, appKey, HERMIE_APP_SECTION_VERSION)
        }
      }
    }

    this.currentMode = 'synced'
    this.perUser = hasPluginCapability(plugin, PLUGIN_CAPABILITIES.uiMetaPerUser)
    this.legacyApp = legacy

    /*
      The one-time inheritance, and the condition is deliberately narrow: this
      person has no key AND there is an anonymous one to read. A person who HAS
      a key never looks at the legacy section again, and a person with neither
      starts from the app's own defaults rather than from whatever arrangement
      the previous occupant of this gateway left behind.
    */
    if (appKey && !app && legacy) {
      return {
        app: inheritedFromLegacy(legacy),
        bots,
        plugin,
        remote: null,
        pushHome: this.perUser ? null : legacy,
        migrated: true
      }
    }

    return { app, bots, plugin, remote: app, pushHome: this.perUser ? app : legacy }
  }

  /**
   * Send every dirty section, one request per profile.
   *
   * One request per PROFILE rather than one per section, because `ui_meta` is
   * per profile and a profile's sections are independent inside one request —
   * the fake pins that a request whose `hermie` conflicts still lands its
   * `hermie-app`.
   *
   * Concurrent callers share one flush: a reconcile landing on top of a
   * `sessions.changed` sweep must not send the same section twice.
   */
  flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing
    }

    const run = this.run().finally(() => {
      this.flushing = null
    })

    this.flushing = run

    return run
  }

  private async run(): Promise<void> {
    // Rounds until one ends with no mark made during it: an edit made while a
    // round was out is sent by the next round rather than stranded until the
    // next reconcile.
    for (;;) {
      const marks = this.markCount

      await this.round()

      if (this.markCount === marks || !this.pending) {
        return
      }
    }
  }

  private async round(): Promise<void> {
    /*
      Grouped by profile, which matters in exactly one case and that case is the
      common one: the default profile is also a BOT, so a reader who colours the
      default bot and changes a theme in the same breath has two dirty sections
      on one row. Two requests would be two round trips and, worse, two
      compare-and-swaps where the protocol offers one — `hermie` and `hermie-app`
      are independent inside a single request, which is the whole point of
      sections being independent.
    */
    const byProfile = new Map<string, string[]>()

    const at = (profile: string): string[] => {
      const existing = byProfile.get(profile)

      if (existing) {
        return existing
      }

      const created: string[] = []

      byProfile.set(profile, created)

      return created
    }

    for (const botName of this.dirtyBots) {
      at(botName).push(HERMIE_KEY)
    }

    const appKey = this.appKey

    // No key means nobody has been named, and an arrangement with no owner has
    // nowhere to go. It stays on the device; see `userId`.
    if (this.dirtyApp && this.defaultProfile && appKey) {
      at(this.defaultProfile).push(appKey)

      // The second key, for a gateway whose notifier cannot read the first.
      // Both go out in ONE request: sections are independent inside it, so the
      // arrangement landing and the registrations landing are two answers the
      // protocol already gives separately.
      if (!this.perUser) {
        at(this.defaultProfile).push(HERMIE_APP_KEY)
      }
    }

    for (const [profile, keys] of byProfile) {
      await this.send(profile, keys)
    }
  }

  /**
   * The value for each key, taken from the app AT THE MOMENT OF THE ATTEMPT.
   *
   * Built per attempt rather than once per flush, which is what makes the
   * conflict retry below correct: a retry re-reads the gateway first, the app's
   * stores take the neighbours out of that answer, and the value this builds is
   * therefore the merge rather than the same losing bytes a second time.
   */
  private sectionsFor(profile: string, keys: readonly string[]): Record<string, unknown> {
    const snapshot = this.read()
    const sections: Record<string, unknown> = {}

    for (const key of keys) {
      // Asked of the key rather than of the app key, because the app key is a
      // different string for every person and `hermie` is the only other one a
      // flush ever names.
      if (key === HERMIE_KEY) {
        const section = snapshot.bots[profile]

        sections[key] = section ? { ...section, v: HERMIE_SECTION_VERSION } : null
        continue
      }

      if (key === HERMIE_APP_KEY) {
        sections[key] = this.legacyPushSection(snapshot)
        continue
      }

      const app: Record<string, unknown> | null = snapshot.app
        ? { ...snapshot.app, v: HERMIE_APP_SECTION_VERSION }
        : null

      // The arrangement without the registrations, on a gateway that would not
      // find them here. Writing them in both places would notify twice.
      if (app && !this.perUser) {
        delete app.push
      }

      sections[key] = app
    }

    return sections
  }

  /**
   * One `profiles.configure`, with the retry the compare-and-swap asks for.
   *
   * `null` for a section is how a section is REMOVED — a bot that is no longer
   * archived and has no colour has nothing to say, and leaving an empty object
   * behind would be a key on somebody's profile that means nothing.
   */
  private async send(profile: string, keys: readonly string[]): Promise<void> {
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const sections = this.sectionsFor(profile, keys)
      // The marks these bytes carry, taken in the same step as the bytes.
      const carried = { app: this.appMark, bot: this.botMarks.get(profile) ?? 0 }
      const expected: Record<string, number> = {}

      for (const key of keys) {
        expected[key] = this.revisions.get(`${profile}:${key}`) ?? 0
      }

      let result: ProfilesConfigureResult

      try {
        result = (await this.gateway.request('profiles.configure', {
          name: profile,
          ui_meta: sections,
          ui_meta_expected_revisions: expected
        })) as ProfilesConfigureResult
      } catch {
        // Refused, unreachable, or a gateway with no `profiles.configure` at
        // all. The section stays dirty and the next reconcile tries again; the
        // device's own copy is already correct, which is why this is a mode
        // rather than a failure.
        this.currentMode = 'local'

        return
      }

      const conflicts = conflictsOf(result)

      for (const [key, revision] of Object.entries(appliedRevisions(result))) {
        this.revisions.set(`${profile}:${key}`, revision)
      }

      for (const [key, conflict] of Object.entries(conflicts)) {
        this.revisions.set(`${profile}:${key}`, conflict.actual)
      }

      if (!Object.keys(conflicts).length) {
        this.clearDirty(profile, keys, carried)

        return
      }

      /*
        The value that won is READ before this device says its own again.

        It used to be deliberately ignored — last writer wins per section, and
        this client is the later writer. That is still the right rule for the
        whole values in the key, and it is the wrong one for the maps keyed by
        device and by person that now live in it: the entry that won is not a
        rival version of ours, it is another device's registration or another
        person's context, and re-sending our own bytes with a newer revision
        would delete it with the protocol's blessing.

        So a conflict re-reads the gateway and lets the app fold the winner's
        rows back in. `sectionsFor` is called again at the top of the next
        attempt, so what goes out second is the merge.
      */
      await this.reread()
    }

    // Out of retries with a conflict still standing: something else is writing
    // this section as fast as we are. Leave it dirty for the next reconcile.
  }

  /**
   * The bare key, as a read-modify-write that changes only `push`.
   *
   * Everything else in it belongs to whoever wrote it — an older build on
   * somebody's other device is still reading the anonymous arrangement out of
   * exactly these bytes — so the section goes back as it came, with this
   * person's registrations dropped into it. `null` when there is nothing to
   * say and nothing was there, which removes a key rather than leaving an empty
   * one behind.
   */
  private legacyPushSection(snapshot: UiMetaSnapshot): Record<string, unknown> | null {
    const push = (snapshot.app as Record<string, unknown> | null)?.push
    const held = this.legacyApp as Record<string, unknown> | null

    if (!push && !held) {
      return null
    }

    return { ...(held ?? {}), v: HERMIE_APP_SECTION_VERSION, ...(push ? { push } : {}) }
  }

  /** Clean what this write carried, and only that: a section marked again since stays dirty. */
  private clearDirty(profile: string, keys: readonly string[], carried: { app: number; bot: number }): void {
    for (const key of keys) {
      if (key === HERMIE_KEY) {
        if ((this.botMarks.get(profile) ?? 0) === carried.bot) {
          this.dirtyBots.delete(profile)
          this.botMarks.delete(profile)
        }
      } else if (this.appMark === carried.app) {
        this.dirtyApp = false
        this.appChoice = false
      }
    }
  }

  /**
   * Read the gateway again and hand its copy to the app, keeping what is dirty.
   *
   * The same two steps `reconcile` opens with, without the flush at the end —
   * this runs INSIDE a flush and would otherwise re-enter it.
   */
  private async reread(): Promise<void> {
    const remote = await this.pull()

    if (remote) {
      this.dropLosingChores(remote)
      this.apply(this.withPendingKept(remote))
    }
  }

  /** Forget everything. A different gateway is a different set of revisions. */
  reset(): void {
    this.revisions.clear()
    this.dirtyBots.clear()
    this.dirtyApp = false
    this.appChoice = false
    this.appMark = 0
    this.botMarks.clear()
    this.defaultProfile = null
    // And a different person: the identity was that gateway's answer about who
    // is holding the phone, not this device's.
    this.userId = ''
    this.perUser = false
    this.legacyApp = null
    this.currentMode = 'local'
  }
}
