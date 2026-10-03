/**
 * What the page knows about its session beside the transcript: who the gateway
 * says the reader is, what this gateway build can do, and which chats are still
 * being loaded on the gateway behind a resume.
 *
 * Written by the session status model (`core/session-status.ts`) and nothing
 * else; read by the sidebar (the identity line), the chat screen (the progress
 * line) and every place that tells the reader's own messages from a colleague's
 * (`rowAuthorsTrusted`).
 *
 * The native apps' `GatewaySession.identityState`, `.capabilities` and
 * `.resumeProgress`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

/**
 * Who the gateway says the reader is (`/api/auth/me`).
 *
 *  - `known`: it named them; their messages carry `authorId`.
 *  - `anonymous`: it answered without a provider or a user id, so it stamps nobody
 *    on the messages this page writes. A fact to show, not an error.
 *  - `failed`: it could not be asked again and no earlier answer named anybody.
 *  - `unknown`: nothing has been read into this store yet (before the session starts).
 */
export type IdentityState =
  | { kind: 'unknown' }
  | { kind: 'known'; authorId: string; name: string | undefined }
  | { kind: 'anonymous' }
  | { kind: 'failed' }

/** `gateway.capabilities`: what this gateway build enforces. A feature not advertised is withheld. */
export interface GatewayCapabilities {
  /** The gateway refuses a second submit on a session while a turn runs. */
  perSessionExclusiveSubmit: boolean
  /** The gateway stamps who submitted each turn on its user row (`display_metadata.author`). */
  perMessageAuthor: boolean
  /**
   * The gateway stamps row, call and turn identity on its frames and history (`transcript_row_identity`).
   * Advisory: the engine decides per frame on the fields themselves; this is for a reader of a log.
   */
  transcriptRowIdentity: boolean
}

/** `session.resume_progress` for one chat, while there is something to say. */
export type ResumeProgress =
  /** The gateway is still loading the conversation behind the resume. */
  | { status: 'loading' }
  /** It could not; `message` is the gateway's reason, cleaned (may be empty). */
  | { status: 'failed'; message: string }

export interface SessionStatusState {
  identity: IdentityState
  /** `null` until this connection's `gateway.capabilities` answered (and on a gateway without the method). */
  capabilities: GatewayCapabilities | null
  /** Per chat key; a chat that is loaded has no entry. */
  resumeProgress: Readonly<Record<string, ResumeProgress>>
  reset(): void
}

const INITIAL = {
  identity: { kind: 'unknown' } as IdentityState,
  capabilities: null as GatewayCapabilities | null,
  resumeProgress: {} as Readonly<Record<string, ResumeProgress>>
}

export function createSessionStatusStore(): StoreApi<SessionStatusState> {
  return createStore<SessionStatusState>(set => ({
    ...INITIAL,
    reset: () => set({ ...INITIAL })
  }))
}

/** The page's store. */
export const sessionStatusStore: StoreApi<SessionStatusState> = createSessionStatusStore()

/**
 * Whether an author on a row is the gateway's word (`per_message_author`). Without
 * it nothing may be drawn as somebody else's on the strength of a row's author:
 * every row reads as the reader's own, as before authors existed.
 */
export const rowAuthorsTrusted = (state: Pick<SessionStatusState, 'capabilities'>): boolean =>
  state.capabilities?.perMessageAuthor === true
