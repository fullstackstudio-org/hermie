/**
 * What the page knows about the gateway's MCP endpoint (`contract/gateway/mcp.md`):
 * the last read of `GET /api/auth/mcp` (the endpoint, the command, the config, the
 * connected clients), why the last read failed, and the last change the gateway
 * announced that this page did not make itself.
 *
 * Written by the MCP model (`core/mcp/model.ts`) and nothing else; read by the
 * Settings › MCP page. A vanilla zustand store, like the others in this directory.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { McpStatus } from '../core/mcp/client'

/** Why the last read did not give a status. */
export type McpProblem =
  /** 404 or 405: this gateway has no MCP endpoint, or it is switched off. The page shows nothing else. */
  | { kind: 'not_offered' }
  /** 401, or 403 `no_identity`: not signed in as a person. */
  | { kind: 'sign_in' }
  /** Anything else: the gateway's words, or the transport's. */
  | { kind: 'failed'; message: string }

/** A change the gateway announced (`mcp.changed`) that this page did not make. */
export interface McpChange {
  /** Counts up, so two equal changes are told apart. */
  id: number
  /** `granted`, `revoked`, or whatever else a later gateway says: an unknown word is "something changed". */
  change: string
  /** The client's name, untrusted; empty when the frame did not carry one. */
  clientName: string
}

export interface McpState {
  /** The last good read; kept while a later one fails, so a blip does not blank the page. `null` until one answered. */
  status: McpStatus | null
  /** Why the newest read failed; `null` when it succeeded or none has finished. */
  problem: McpProblem | null
  /** A read is on its way. */
  loading: boolean
  /** A read has finished, either way. */
  loaded: boolean
  change: McpChange | null
  reset(): void
}

const INITIAL = {
  status: null,
  problem: null,
  loading: false,
  loaded: false,
  change: null
}

export function createMcpStore(): StoreApi<McpState> {
  return createStore<McpState>(set => ({
    ...INITIAL,
    reset: () => set({ ...INITIAL })
  }))
}

/** The page's store. */
export const mcpStore: StoreApi<McpState> = createMcpStore()
