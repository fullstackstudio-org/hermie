/**
 * One bot's profile on the gateway: what `profiles.describe` reads, and the writes `profiles.configure`,
 * `profiles.set_asset` and `reload.mcp` make (the native app's `BotSettingsModel`, which this follows).
 *
 * React-free: the page (`features/profile`) reads `store` and calls the methods; a test hands in a
 * function for `request` and needs no socket.
 *
 * ## What waits for a button and what writes at once
 *
 * The description is text, and a text field is an edit in progress: it keeps a draft and writes on
 * `saveDescription()`. The photo is a choice made once, and writes when it is made. Everything else is a
 * choice and writes the moment it is made: a switch that waited for a button would misreport the world until
 * the button was pressed.
 *
 * ## Switches
 *
 * Every capability section is a replace over a whole list (`params.ts`), so a toggle paints first and the
 * section is then written from the state on screen. Toggles made while a write is in flight do not start
 * another: they mark the section dirty, and the running write sends the latest state when it comes back, so
 * two quick clicks are two states in order and never two writes racing. A refusal puts the section back to
 * what the gateway last confirmed and says so.
 *
 * ## One write at a time
 *
 * Every `profiles.configure` this model sends, whatever the section, goes through one serial queue: the
 * gateway reads the profile's config, changes it and writes it back without a lock, so two writes in flight
 * at once can lose one of the changes. A write waits its turn and builds its params when its turn comes, from
 * the state then on screen.
 *
 * ## Reads that were already stale
 *
 * `profiles.describe` is a read and is not queued, so its answer can describe the profile from before a write
 * that landed while it was on its way. Every section has a generation that moves when a write to it is
 * confirmed; a snapshot is only believed, section by section, if that generation has not moved since the read
 * was sent and no write to the section is under way.
 *
 * ## Permissions and support
 *
 * The gateway decides what this account may do, and says so only when a write is refused. A refusal that
 * reads as an access denial (`forbidden`) puts the model in `refused`, and the page draws read-only from then
 * on; a gateway without the methods (`unsupported`) leaves the model without `details`.
 *
 * Every string in here that came from the gateway is untrusted: it is plain text, never Markdown.
 */
import type { ProfilesSetAssetParams } from '@hermes/shared/gateway-contract'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { ChatGateway } from '../link'
import { type BotProfileDetails, detailsOf } from './details'
import { BotProfileFailure, classifyFailure } from './failure'
import {
  type AppliedSection,
  avatarParams,
  checkApplied,
  clearAvatarParams,
  descriptionParams,
  mcpParams,
  type ModelChoice,
  modelAnswer,
  modelChoicesOf,
  modelParams,
  reloadAnswer,
  reloadMcpParams,
  skillsParams,
  soulParams,
  toolsetDefaultsParams,
  toolsetsParams
} from './params'

/** A thing the page can be busy writing, or have failed to write. */
export type ProfileField = 'description' | 'soul' | 'model' | 'avatar' | 'toolsets' | 'skills' | 'mcp'

type Section = 'toolsets' | 'skills' | 'mcp'

const APPLIED: Record<Section, AppliedSection> = { toolsets: 'toolsets', skills: 'skills', mcp: 'mcp_servers' }

/** The models the gateway offers, read when the picker is first opened. */
export type ModelChoices =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; choices: readonly ModelChoice[] }
  /** The gateway would not list them: the picker is not offered. */
  | { kind: 'unavailable' }

/** A guarded model (an expensive one) that wrote nothing until the person says yes, with the gateway's words. */
export interface ModelConfirmation {
  choice: ModelChoice
  message: string
}

export interface BotProfileState {
  phase: 'idle' | 'loading' | 'loaded' | 'failed'
  /** Why the read failed, while `phase` is `failed`. */
  loadFailure: BotProfileFailure | null
  /** The gateway's snapshot, with the switches as they are on screen. */
  details: BotProfileDetails | null
  descriptionDraft: string
  /** The personality being edited: `SOUL.md` exactly as typed. */
  soulDraft: string
  modelChoices: ModelChoices
  modelConfirmation: ModelConfirmation | null
  busy: Readonly<Partial<Record<ProfileField, true>>>
  failures: Readonly<Partial<Record<ProfileField, BotProfileFailure>>>
  /** A write was refused as not this account's to make: the page is read-only from here on. */
  refused: boolean
  /** The toolsets are being put back to the gateway's defaults: their switches wait. */
  toolsetsLocked: boolean
  /** Set while the gateway waits to be told whether to reload MCP servers into running chats: its own warning. */
  mcpReload: { message: string } | null
  /** Something that happened and is worth one line. */
  notice: 'mcp_reloaded' | null
}

export interface BotProfileModelOptions {
  /** The calls the model makes, over the page's connection. */
  gateway: Pick<ChatGateway, 'request'>
  /** The bot's handle: the gateway's profile name, not its display name. */
  profile: string
  /** The bot's live chat, for `reload.mcp`; `undefined` when it has none. */
  runtimeSessionId?: () => string | undefined
  /** Told after a write the roster shows (description, picture), so the list re-reads. */
  onChanged?: () => void
}

const INITIAL: BotProfileState = {
  phase: 'idle',
  loadFailure: null,
  details: null,
  descriptionDraft: '',
  soulDraft: '',
  modelChoices: { kind: 'idle' },
  modelConfirmation: null,
  busy: {},
  failures: {},
  refused: false,
  toolsetsLocked: false,
  mcpReload: null,
  notice: null
}

/** The state of a page that has no model (no connection to the gateway's profile calls): nothing read, nothing busy. */
export const IDLE_PROFILE_STORE: StoreApi<BotProfileState> = createStore<BotProfileState>(() => ({ ...INITIAL }))

export class BotProfileModel {
  readonly store: StoreApi<BotProfileState> = createStore<BotProfileState>(() => ({ ...INITIAL }))

  private readonly gateway: Pick<ChatGateway, 'request'>
  readonly profile: string
  private readonly runtimeSessionId: () => string | undefined
  private readonly onChanged: () => void
  /** What the gateway last confirmed, the state a refused write goes back to. */
  private confirmed: BotProfileDetails | null = null
  private readonly dirty = new Set<Section>()
  private readonly writing = new Set<Section>()
  /** Moves when a write to a field is confirmed (see "Reads that were already stale"). */
  private generation: Partial<Record<ProfileField, number>> = {}
  private tail: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | null = null

  constructor(options: BotProfileModelOptions) {
    this.gateway = options.gateway
    this.profile = options.profile
    this.runtimeSessionId = options.runtimeSessionId ?? (() => undefined)
    this.onChanged = options.onChanged ?? (() => undefined)
  }

  private get state(): BotProfileState {
    return this.store.getState()
  }

  private patch(next: Partial<BotProfileState>): void {
    this.store.setState(next)
  }

  private setBusy(field: ProfileField, on: boolean): void {
    const busy = { ...this.state.busy }

    if (on) {
      busy[field] = true
    } else {
      delete busy[field]
    }

    this.patch({ busy })
  }

  private setFailure(field: ProfileField, failure: BotProfileFailure | null): void {
    const failures = { ...this.state.failures }

    if (failure) {
      failures[field] = failure
    } else {
      delete failures[field]
    }

    this.patch({ failures })
  }

  private fail(field: ProfileField, error: unknown): BotProfileFailure {
    const failure = classifyFailure(error)

    this.setFailure(field, failure)

    if (failure.kind === 'forbidden') {
      this.patch({ refused: true })
    }

    return failure
  }

  private confirmedWrite(field: ProfileField): void {
    this.generation = { ...this.generation, [field]: (this.generation[field] ?? 0) + 1 }
  }

  /** Run `body` when no other write to this profile is running, and in the order writes asked. */
  private serialized<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body)

    this.tail = run.catch(() => undefined)

    return run
  }

  // ── reading ────────────────────────────────────────────────────────────────

  /** Read the profile. A reload keeps a draft the person has started and a write still in flight. */
  load(): Promise<void> {
    if (this.loading) {
      return this.loading
    }

    this.loading = this.read().finally(() => {
      this.loading = null
    })

    return this.loading
  }

  private async read(): Promise<void> {
    if (!this.state.details) {
      this.patch({ phase: 'loading', loadFailure: null })
    }

    const started = { ...this.generation }

    try {
      const reply = await this.gateway.request('profiles.describe', { name: this.profile })

      if (typeof reply !== 'object' || reply === null) {
        throw new BotProfileFailure('refused')
      }

      this.adopt(detailsOf(reply, this.profile), started)
      this.patch({ phase: 'loaded', loadFailure: null })
    } catch (error) {
      const failure = classifyFailure(error)

      if (failure.kind === 'forbidden') {
        this.patch({ refused: true })
      }

      if (!this.state.details) {
        this.patch({ phase: 'failed', loadFailure: failure })
      }
    }
  }

  /**
   * Take a snapshot in, section by section. A section the snapshot cannot be believed about (a write to it
   * was confirmed after the read was sent, or is under way now) keeps what is known; what is on screen
   * follows the gateway otherwise, except where the person is in the middle of something: a section being
   * written keeps its switches, a field being typed its draft.
   */
  private adopt(snapshot: BotProfileDetails, started: Partial<Record<ProfileField, number>>): void {
    const before = this.confirmed
    const fresh: BotProfileDetails = { ...snapshot }
    const { busy } = this.state
    const stale = (field: ProfileField): boolean =>
      busy[field] === true || (this.generation[field] ?? 0) !== (started[field] ?? 0)

    if (before) {
      if (stale('description')) {
        fresh.description = before.description
      }

      if (stale('soul')) {
        fresh.soul = before.soul
      }

      if (stale('model')) {
        fresh.model = before.model
      }

      if (stale('toolsets')) {
        fresh.toolsets = before.toolsets
        fresh.toolsetsPinned = before.toolsetsPinned
      }

      if (stale('skills')) {
        fresh.skills = before.skills
      }

      if (stale('mcp')) {
        fresh.mcpServers = before.mcpServers
      }
    }

    this.confirmed = fresh

    const next: BotProfileDetails = { ...fresh }
    const current = this.state.details

    if (current) {
      if (busy.toolsets) {
        next.toolsets = current.toolsets
        next.toolsetsPinned = current.toolsetsPinned
      }

      if (busy.skills) {
        next.skills = current.skills
      }

      if (busy.mcp) {
        next.mcpServers = current.mcpServers
      }
    }

    // A draft that is still what the gateway last said is not an edit: it follows. One the person has started stays.
    const draft = this.state.descriptionDraft
    const following = before ? draft.trim() === before.description : true

    // The personality's draft the same way, compared as typed: its whitespace is the author's.
    const soulFollowing = before ? this.state.soulDraft === before.soul : true

    this.patch({
      details: next,
      ...(following ? { descriptionDraft: fresh.description } : {}),
      ...(soulFollowing ? { soulDraft: fresh.soul } : {})
    })
  }

  // ── what can be done ───────────────────────────────────────────────────────

  /** Whether a write to the gateway is worth attempting: connected, and not refused. */
  canWrite(connected: boolean): boolean {
    return connected && !this.state.refused && this.state.details !== null
  }

  get descriptionIsDirty(): boolean {
    const { details, descriptionDraft } = this.state

    return details !== null && descriptionDraft.trim() !== details.description
  }

  setDescriptionDraft(text: string): void {
    this.patch({ descriptionDraft: text })
  }

  /** Take the draft back to what the gateway holds. */
  revertDescription(): void {
    this.patch({ descriptionDraft: this.state.details?.description ?? '' })
    this.setFailure('description', null)
  }

  get soulIsDirty(): boolean {
    const { details, soulDraft } = this.state

    return details !== null && soulDraft !== details.soul
  }

  setSoulDraft(text: string): void {
    this.patch({ soulDraft: text })
  }

  /** Take the personality's draft back to what the gateway holds. */
  revertSoul(): void {
    this.patch({ soulDraft: this.state.details?.soul ?? '' })
    this.setFailure('soul', null)
  }

  dismissFailure(field: ProfileField): void {
    this.setFailure(field, null)
  }

  dismissNotice(): void {
    this.patch({ notice: null })
  }

  // ── description and picture ────────────────────────────────────────────────

  async saveDescription(): Promise<void> {
    if (!this.state.details || this.state.busy.description) {
      return
    }

    const text = this.state.descriptionDraft.trim()

    this.setBusy('description', true)
    this.setFailure('description', null)

    try {
      await this.serialized(async () => {
        const reply = await this.gateway.request('profiles.configure', descriptionParams(this.profile, text))

        checkApplied(reply, 'description')
      })

      this.confirmedWrite('description')

      const details = this.state.details

      if (details) {
        this.patch({ details: { ...details, description: text }, descriptionDraft: text })
      }

      if (this.confirmed) {
        this.confirmed = { ...this.confirmed, description: text }
      }

      this.onChanged()
    } catch (error) {
      this.fail('description', error)
    } finally {
      this.setBusy('description', false)
    }
  }

  /** Write the personality exactly as typed. */
  async saveSoul(): Promise<void> {
    if (!this.state.details || this.state.busy.soul) {
      return
    }

    const text = this.state.soulDraft

    this.setBusy('soul', true)
    this.setFailure('soul', null)

    try {
      await this.serialized(async () => {
        const reply = await this.gateway.request('profiles.configure', soulParams(this.profile, text))

        checkApplied(reply, 'soul')
      })

      this.confirmedWrite('soul')

      const details = this.state.details

      if (details) {
        this.patch({ details: { ...details, soul: text }, soulDraft: text })
      }

      if (this.confirmed) {
        this.confirmed = { ...this.confirmed, soul: text }
      }
    } catch (error) {
      this.fail('soul', error)
    } finally {
      this.setBusy('soul', false)
    }
  }

  // ── model ──────────────────────────────────────────────────────────────────

  /** The models the gateway offers this account, read once; a gateway that will not list them leaves the picker out. */
  async loadModelChoices(): Promise<void> {
    if (this.state.modelChoices.kind === 'loading' || this.state.modelChoices.kind === 'loaded') {
      return
    }

    this.patch({ modelChoices: { kind: 'loading' } })

    try {
      const choices = modelChoicesOf(await this.gateway.request('model.options', { explicit_only: true }))

      this.patch({ modelChoices: choices.length > 0 ? { kind: 'loaded', choices } : { kind: 'unavailable' } })
    } catch {
      this.patch({ modelChoices: { kind: 'unavailable' } })
    }
  }

  /** Pin the bot to a model; a guarded one writes nothing and becomes `modelConfirmation`. */
  chooseModel(choice: ModelChoice): Promise<void> {
    return this.pin(choice, false)
  }

  /** The person confirmed the guarded model the gateway asked about. */
  async confirmModel(): Promise<void> {
    const pending = this.state.modelConfirmation

    if (pending) {
      this.patch({ modelConfirmation: null })
      await this.pin(pending.choice, true)
    }
  }

  cancelModelConfirmation(): void {
    this.patch({ modelConfirmation: null })
  }

  private async pin(choice: ModelChoice, confirmExpensive: boolean): Promise<void> {
    if (!this.state.details || this.state.busy.model) {
      return
    }

    this.setBusy('model', true)
    this.setFailure('model', null)

    let answer: ReturnType<typeof modelAnswer>

    try {
      answer = await this.serialized(async () =>
        modelAnswer(
          await this.gateway.request('profiles.configure', modelParams(this.profile, choice, confirmExpensive))
        )
      )
    } catch (error) {
      this.fail('model', error)
      this.setBusy('model', false)

      return
    }

    if (answer.kind === 'confirm') {
      this.patch({ modelConfirmation: { choice, message: answer.message } })
      this.setBusy('model', false)

      return
    }

    this.confirmedWrite('model')
    this.setBusy('model', false)
    // What the gateway stored is what to show: it normalises the pair it was given.
    await this.reread()
    this.onChanged()
  }

  /** Set the bot's picture to this base64 (PNG, JPEG or WebP, up to 2 MB). Resolves whether it worked. */
  setAvatar(base64: string): Promise<boolean> {
    return this.writeAvatar(avatarParams(this.profile, base64))
  }

  /** Take the bot's picture away. Resolves whether it worked. */
  clearAvatar(): Promise<boolean> {
    return this.writeAvatar(clearAvatarParams(this.profile))
  }

  private async writeAvatar(params: ProfilesSetAssetParams): Promise<boolean> {
    if (this.state.busy.avatar) {
      return false
    }

    this.setBusy('avatar', true)
    this.setFailure('avatar', null)

    try {
      await this.gateway.request('profiles.set_asset', params)
      this.confirmedWrite('avatar')
      this.onChanged()

      return true
    } catch (error) {
      this.fail('avatar', error)

      return false
    } finally {
      this.setBusy('avatar', false)
    }
  }

  /** The picture could not even be prepared (not an image, too big): said under the picture, like a refusal. */
  rejectAvatar(failure: BotProfileFailure): void {
    this.setFailure('avatar', failure)
  }

  // ── switches ───────────────────────────────────────────────────────────────

  /** Whether this toolset may be switched off: not the last one that is on (`last_toolset`). */
  canDisableToolset(name: string): boolean {
    return (this.state.details?.toolsets ?? []).some(toolset => toolset.enabled && toolset.name !== name)
  }

  async setToolset(name: string, enabled: boolean): Promise<void> {
    const details = this.state.details
    const toolset = details?.toolsets.find(candidate => candidate.name === name)

    if (!details || !toolset || this.state.toolsetsLocked || toolset.enabled === enabled) {
      return
    }

    if (!enabled && !this.canDisableToolset(name)) {
      this.setFailure('toolsets', new BotProfileFailure('last_toolset'))

      return
    }

    this.patch({
      details: {
        ...details,
        toolsets: details.toolsets.map(candidate => (candidate.name === name ? { ...candidate, enabled } : candidate))
      }
    })
    await this.commit('toolsets')
  }

  async setSkill(name: string, enabled: boolean): Promise<void> {
    const details = this.state.details
    const skill = details?.skills.find(candidate => candidate.name === name)

    if (!details || !skill || skill.enabled === enabled) {
      return
    }

    this.patch({
      details: {
        ...details,
        skills: details.skills.map(skill => (skill.name === name ? { ...skill, enabled } : skill))
      }
    })
    await this.commit('skills')
  }

  async setMcpServer(name: string, enabled: boolean): Promise<void> {
    const details = this.state.details
    const server = details?.mcpServers.find(candidate => candidate.name === name)

    if (!details || !server || server.enabled === enabled) {
      return
    }

    this.patch({
      details: {
        ...details,
        mcpServers: details.mcpServers.map(server => (server.name === name ? { ...server, enabled } : server))
      }
    })
    await this.commit('mcp')
  }

  /**
   * Take the pin away so the bot follows the gateway's toolset defaults again, and show what those are: they
   * need not be every toolset. The toolsets count as being written, and their switches wait
   * (`toolsetsLocked`), until the gateway's answer has been read back.
   */
  async useDefaultToolsets(): Promise<void> {
    if (this.state.details?.toolsetsPinned !== true || this.state.toolsetsLocked || this.writing.has('toolsets')) {
      return
    }

    this.patch({ toolsetsLocked: true })
    this.writing.add('toolsets')
    this.setBusy('toolsets', true)
    this.setFailure('toolsets', null)

    try {
      await this.serialized(async () => {
        const reply = await this.gateway.request('profiles.configure', toolsetDefaultsParams(this.profile))

        checkApplied(reply, APPLIED.toolsets)
      })

      this.confirmedWrite('toolsets')

      const details = this.state.details

      if (details) {
        this.patch({ details: { ...details, toolsetsPinned: false } })
      }

      if (this.confirmed) {
        this.confirmed = { ...this.confirmed, toolsetsPinned: false }
      }

      this.writing.delete('toolsets')
      this.setBusy('toolsets', false)
      await this.reread()
    } catch (error) {
      this.fail('toolsets', error)
      this.writing.delete('toolsets')
      this.setBusy('toolsets', false)
    }

    this.patch({ toolsetsLocked: false })
  }

  /**
   * Write a section from the state on screen. See the file's note on how overlapping toggles coalesce, and
   * on the queue every write waits in.
   */
  private async commit(section: Section): Promise<void> {
    this.setFailure(section, null)
    this.dirty.add(section)

    if (this.writing.has(section)) {
      return
    }

    this.writing.add(section)
    this.setBusy(section, true)

    let wrote = false

    try {
      while (this.dirty.has(section)) {
        try {
          // Built when the queue is ours, from what is on screen then: a click made while this waited is part
          // of it, and needs no write of its own.
          wrote =
            (await this.serialized(async () => {
              const snapshot = this.state.details

              if (!this.dirty.delete(section) || !snapshot) {
                return false
              }

              const params =
                section === 'toolsets'
                  ? toolsetsParams(this.profile, snapshot.toolsets)
                  : section === 'skills'
                    ? skillsParams(this.profile, snapshot.skills)
                    : mcpParams(this.profile, snapshot.mcpServers)
              const reply = await this.gateway.request('profiles.configure', params)

              checkApplied(reply, APPLIED[section])
              this.confirmedWrite(section)
              this.confirm(section, snapshot)

              return true
            })) || wrote
        } catch (error) {
          this.dirty.delete(section)
          this.fail(section, error)
          this.restore(section)

          return
        }
      }
    } finally {
      this.writing.delete(section)
      this.setBusy(section, false)
    }

    if (wrote && section === 'mcp') {
      await this.offerMcpReload()
    }
  }

  private confirm(section: Section, snapshot: BotProfileDetails): void {
    const confirmed = this.confirmed

    if (!confirmed) {
      return
    }

    if (section === 'toolsets') {
      // A list of names was sent, and any such list is a pin.
      this.confirmed = { ...confirmed, toolsets: snapshot.toolsets, toolsetsPinned: true }

      const details = this.state.details

      if (details && sameToolsets(details.toolsets, snapshot.toolsets)) {
        this.patch({ details: { ...details, toolsetsPinned: true } })
      }
    } else if (section === 'skills') {
      this.confirmed = { ...confirmed, skills: snapshot.skills }
    } else {
      this.confirmed = { ...confirmed, mcpServers: snapshot.mcpServers }
    }
  }

  private restore(section: Section): void {
    const confirmed = this.confirmed
    const details = this.state.details

    if (!confirmed || !details) {
      return
    }

    this.patch({
      details:
        section === 'toolsets'
          ? { ...details, toolsets: confirmed.toolsets, toolsetsPinned: confirmed.toolsetsPinned }
          : section === 'skills'
            ? { ...details, skills: confirmed.skills }
            : { ...details, mcpServers: confirmed.mcpServers }
    })
  }

  // ── MCP reload ─────────────────────────────────────────────────────────────

  /**
   * A changed MCP list does not reach a chat that is already running until the gateway reloads them, which
   * makes every running chat send its whole input again. So the gateway is asked without `confirm`, and when
   * it wants an answer the page puts the question to the person with the gateway's own warning.
   */
  private async offerMcpReload(): Promise<void> {
    try {
      const reply = await this.gateway.request('reload.mcp', reloadMcpParams({ sessionId: this.runtimeSessionId() }))
      const answer = reloadAnswer(reply)

      this.patch(answer.kind === 'reloaded' ? { notice: 'mcp_reloaded' } : { mcpReload: { message: answer.message } })
    } catch (error) {
      this.fail('mcp', error)
    }
  }

  /** The person answered the gateway's question: reload now, and with `always` stop being asked. */
  async reloadMcp(always: boolean): Promise<void> {
    this.patch({ mcpReload: null })
    this.setBusy('mcp', true)

    try {
      await this.gateway.request(
        'reload.mcp',
        reloadMcpParams({ confirm: true, always, sessionId: this.runtimeSessionId() })
      )
      this.patch({ notice: 'mcp_reloaded' })
    } catch (error) {
      this.fail('mcp', error)
    } finally {
      this.setBusy('mcp', false)
    }
  }

  declineMcpReload(): void {
    this.patch({ mcpReload: null })
  }

  /** Read the snapshot again after a write whose result is the gateway's to say. */
  private async reread(): Promise<void> {
    const started = { ...this.generation }

    try {
      const reply = await this.gateway.request('profiles.describe', { name: this.profile })

      if (typeof reply === 'object' && reply !== null) {
        this.adopt(detailsOf(reply, this.profile), started)
      }
    } catch {
      // The write landed; a failed re-read leaves the page as it was until the next load.
    }
  }
}

const sameToolsets = (
  a: readonly { name: string; enabled: boolean }[],
  b: readonly { name: string; enabled: boolean }[]
): boolean =>
  a.length === b.length &&
  a.every((entry, index) => entry.name === b[index]?.name && entry.enabled === b[index]?.enabled)
