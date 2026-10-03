/**
 * The connector authorisations a bot is waiting on (`connection.request`, a
 * resume's `pending_connection`, moved by `connection.update`): one card per
 * chat, with the gateway's deadline. The request layer draws an open card as a
 * sheet with a countdown (`features/requests/ConnectionSheet.tsx`).
 *
 * Written by the connections model (`core/connections.ts`) and nothing else.
 * Every text here is the gateway's (a connector's name, its state, its
 * instructions), cleaned and bounded for display. A link is held only when it
 * passed `authorisationLink` (plain `https`, a host, no user or password before
 * it), and is opened only by the person, from the sheet.
 *
 * The native apps' `ConnectionRequestsModel.requests`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

/** An authorisation link that may be opened, and the host the sheet shows beside it. */
export interface AuthorisationLink {
  /** The URL as it is opened: serialised by the browser's own parser after the checks. */
  url: string
  /** Where it goes, in the browser's spelling (punycode for an international name). */
  host: string
}

/** One row of a card: a connector to authorise, an MCP server to install, a catalog entry to enable. */
export interface ConnectionTarget {
  /** The row's name, as the answer names it (the wire's, trimmed). */
  name: string
  /** The name as shown: cleaned and bounded. */
  label: string
  /** `connector`, `mcp`, `plugin` or `skill`, as the gateway sent it. */
  kind: string
  /** `authorize`, `connect`, `enable`, `install` or `reconnect`, as the gateway sent it. */
  action: string
  /** `pending`, `initiated`, `connected`, `skipped`, `failed`, `expired`, `not_connected`, or what the gateway sent. */
  state: string
  /** The gateway's detail line, cleaned; may be empty. */
  detail: string
  /** What to do when there is no link (or beside it), cleaned; `null` when the gateway sent none. */
  instructions: string | null
  /** The link to open, when the gateway sent one that passed the checks. */
  link: AuthorisationLink | null
  /** The gateway sent a link that did not pass: the sheet says so rather than hide the row's way forward. */
  linkRefused: boolean
  /** The person opened the link from this page. Local only: the gateway notices the authorisation itself. */
  opened: boolean
}

/** What the person last asked of a card that has not been answered yet, or why it did not go out. */
export type ConnectionAnswerState =
  { kind: 'idle' } | { kind: 'sending'; what: 'skip' | 'cancel'; target?: string } | { kind: 'failed'; message: string }

/** The connection operation one chat's agent is waiting on. */
export interface ConnectionCard {
  /** The chat's key in the chat store. */
  chat: string
  /** The runtime session that owns it; the answer names it. */
  runtimeSessionId: string
  opId: string
  /** The tool call that opened it. */
  toolCallId: string
  /** The operation's own write counter: an older frame moves nothing. */
  seq: number
  /** When the gateway stops waiting, in epoch milliseconds (the gateway's clock, as it said it). */
  deadline: number
  targets: readonly ConnectionTarget[]
  answer: ConnectionAnswerState
  /** Moves on every change, for the request queue. */
  version: number
  /** The order cards were first seen in, across chats. */
  seq0: number
}

/** Why a card left without the person's answer, for the sheet's last words and a screen reader. */
export type ConnectionEnd = 'settled' | 'deadline' | 'withdrawn'

export interface ConnectionsState {
  /** The open card per chat key. */
  cards: Readonly<Record<string, ConnectionCard>>
  /** How the last card of each chat ended, until another opens there. */
  ended: Readonly<Record<string, { opId: string; end: ConnectionEnd }>>
  reset(): void
}

const INITIAL = {
  cards: {} as Readonly<Record<string, ConnectionCard>>,
  ended: {} as Readonly<Record<string, { opId: string; end: ConnectionEnd }>>
}

export function createConnectionsStore(): StoreApi<ConnectionsState> {
  return createStore<ConnectionsState>(set => ({
    ...INITIAL,
    reset: () => set({ ...INITIAL })
  }))
}

/** The page's store. */
export const connectionsStore: StoreApi<ConnectionsState> = createConnectionsStore()
