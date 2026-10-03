/**
 * What the session knows beside the transcript: who the gateway says the reader
 * is, what this gateway build can do, and which chats it is still loading behind a
 * resume. What the page shows is in `state/session-status.ts`.
 *
 * The native apps' `GatewaySession` facts (`GatewaySession+Facts.swift`). The
 * rules, as built:
 *
 *  1. **Identity comes from `/api/auth/me`, and only from there.** The boot reads it
 *     before anything renders (`boot/boot.ts`, `signed_in.author`), and this model
 *     reads it again after every reconnect, so a page that stayed open across a
 *     change of account follows it. An id is never invented: a gateway that answers
 *     without a provider or a user id stamps nobody, and the state says
 *     `anonymous`, which the sidebar says in words instead of attributing nothing.
 *     A read that fails keeps an identity already held (the gateway has not said
 *     otherwise) and otherwise says `failed`. Only the newest read is applied. The
 *     chat controller's own author follows (`ownAuthorStore`).
 *  2. **`gateway.capabilities` is read once per connection**, on every arrival at
 *     `ready`. A gateway without the method, or one that does not answer, leaves
 *     what was known (nothing, on the first connection), so every feature it gates
 *     stays withheld. `per_message_author` decides whether a row's author is the
 *     gateway's word (`rowAuthorsTrusted`).
 *  3. **Resume progress.** A resume that says the gateway is still loading the
 *     conversation behind it (`hydrating: true`) puts a progress line on the chat;
 *     `session.resume_progress` moves it (`loading`), ends it (`complete`: the chat
 *     controller reads the chat again) or turns it into the gateway's reason
 *     (`failed`, cleaned, until the person closes it or the chat is resumed again).
 *     A chat that lets go of its session loses its line.
 */
import type { AuthIdentity, ConnectionStatus } from '@hermie/gateway-client'
import { ownAuthorOf } from '@hermie/gateway-client'
import type { StoreApi } from 'zustand/vanilla'

import type { ChatsState } from '../state/chats'
import {
  type GatewayCapabilities,
  type IdentityState,
  type ResumeProgress,
  type SessionStatusState,
  sessionStatusStore
} from '../state/session-status'
import type { SessionSignal } from './chat-controller'
import type { OwnAuthorState } from './chats/own-author'
import type { ChatGateway } from './link'
import { displayText, TEXT_LIMIT } from './requests/secure-input'

/** The next identity after a read (rule 1). `answer` is `null` for a read that failed. */
export function identityAfter(current: IdentityState, answer: AuthIdentity | null): IdentityState {
  if (answer === null) {
    return current.kind === 'known' ? current : { kind: 'failed' }
  }

  const author = ownAuthorOf(answer)

  return author ? { kind: 'known', authorId: author.id, name: author.name } : { kind: 'anonymous' }
}

/** `gateway.capabilities`, read defensively: a flag counts only when it is `true`. */
export function capabilitiesOf(result: unknown): GatewayCapabilities | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }

  const record = result as Record<string, unknown>

  return {
    perSessionExclusiveSubmit: record.per_session_exclusive_submit === true,
    perMessageAuthor: record.per_message_author === true,
    transcriptRowIdentity: record.transcript_row_identity === true
  }
}

export interface SessionStatusModelOptions {
  gateway: Pick<ChatGateway, 'request' | 'onStatus'>
  /** `GET /api/auth/me` on the page's cookie session. */
  readIdentity: () => Promise<AuthIdentity>
  /** What the boot's read answered: the reader's author stamp, or `undefined` when it named nobody. */
  initialAuthor: { id: string; name?: string } | undefined
  /** The chat controller's own author, kept equal to the identity. */
  ownAuthor?: StoreApi<OwnAuthorState>
  /** Where the chat controller's signals are heard (`ChatController.onSessionSignal`). */
  watchSignals: (listener: (signal: SessionSignal) => void) => () => void
  /** The chats, so a chat that lets go of its session loses its progress line. */
  chats?: Pick<StoreApi<ChatsState>, 'getState' | 'subscribe'>
  store?: StoreApi<SessionStatusState>
}

export class SessionStatusModel {
  readonly store: StoreApi<SessionStatusState>

  private readonly options: SessionStatusModelOptions
  private unsubscribes: (() => void)[] = []
  private ready = false
  private connections = 0
  private identityReads = 0
  private capabilityReads = 0
  private started = false
  private stopped = false

  constructor(options: SessionStatusModelOptions) {
    this.options = options
    this.store = options.store ?? sessionStatusStore
  }

  start(): void {
    if (this.started || this.stopped) {
      return
    }

    this.started = true
    this.store.getState().reset()

    const author = this.options.initialAuthor

    this.store.setState({
      identity: author ? { kind: 'known', authorId: author.id, name: author.name } : { kind: 'anonymous' }
    })

    this.unsubscribes.push(
      this.options.gateway.onStatus((status: ConnectionStatus) => this.onStatus(status)),
      this.options.watchSignals(signal => this.receive(signal))
    )

    const { chats } = this.options

    if (chats) {
      this.unsubscribes.push(chats.subscribe(() => this.chatsChanged()))
    }
  }

  /** Nothing more is heard or applied. Idempotent. */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    for (const unsubscribe of this.unsubscribes) {
      unsubscribe()
    }

    this.unsubscribes = []
    this.store.getState().reset()
  }

  /** The person closed a chat's line about a load that failed. */
  dismissProgress(chat: string): void {
    this.setProgress(chat, undefined)
  }

  // ── identity and capabilities ─────────────────────────────────────────────────────────────────

  private onStatus(status: ConnectionStatus): void {
    const now = status === 'ready'

    if (now && !this.ready) {
      this.connections += 1
      void this.readCapabilities()

      // The boot read the identity just before the first connection.
      if (this.connections > 1) {
        void this.refreshIdentity()
      }
    }

    this.ready = now
  }

  /** Ask the gateway who this is now (rule 1). Never throws. */
  async refreshIdentity(): Promise<void> {
    const read = (this.identityReads += 1)
    let answer: AuthIdentity | null

    try {
      answer = await this.options.readIdentity()
    } catch {
      answer = null
    }

    if (read !== this.identityReads || this.stopped) {
      return
    }

    const next = identityAfter(this.store.getState().identity, answer)

    this.store.setState({ identity: next })

    if (next.kind === 'known') {
      this.options.ownAuthor?.getState().set(next.name ? { id: next.authorId, name: next.name } : { id: next.authorId })
    } else if (next.kind === 'anonymous') {
      this.options.ownAuthor?.getState().set(undefined)
    }
  }

  private async readCapabilities(): Promise<void> {
    const read = (this.capabilityReads += 1)
    let result: unknown

    try {
      result = await this.options.gateway.request('gateway.capabilities', {})
    } catch {
      return
    }

    const capabilities = capabilitiesOf(result)

    if (read !== this.capabilityReads || this.stopped || capabilities === null) {
      return
    }

    this.store.setState({ capabilities })
  }

  // ── resume progress ───────────────────────────────────────────────────────────────────────────

  private receive(signal: SessionSignal): void {
    if (signal.kind === 'resumed') {
      this.setProgress(signal.chat, signal.hydrating ? { status: 'loading' } : undefined)

      return
    }

    if (signal.kind !== 'resume.progress') {
      return
    }

    switch (signal.payload.status) {
      case 'loading':
        this.setProgress(signal.chat, { status: 'loading' })
        break
      case 'complete':
        this.setProgress(signal.chat, undefined)
        break
      case 'failed':
        this.setProgress(signal.chat, { status: 'failed', message: displayText(signal.payload.message, TEXT_LIMIT) })
        break
      default:
        break
    }
  }

  private chatsChanged(): void {
    const chats = this.options.chats?.getState().chats

    if (!chats) {
      return
    }

    for (const chat of Object.keys(this.store.getState().resumeProgress)) {
      if (chats[chat]?.runtimeSessionId === undefined) {
        this.setProgress(chat, undefined)
      }
    }
  }

  private setProgress(chat: string, progress: ResumeProgress | undefined): void {
    const current = this.store.getState().resumeProgress

    if (progress === undefined) {
      if (!Object.hasOwn(current, chat)) {
        return
      }

      const next = { ...current }

      delete next[chat]
      this.store.setState({ resumeProgress: next })

      return
    }

    const held = current[chat]

    if (
      held?.status === progress.status &&
      (held.status !== 'failed' || held.message === (progress as { message: string }).message)
    ) {
      return
    }

    this.store.setState({ resumeProgress: { ...current, [chat]: progress } })
  }
}
