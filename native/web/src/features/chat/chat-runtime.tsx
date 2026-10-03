/**
 * What the chat screen is given by the page: the controller (the only thing that
 * talks to the gateway about a transcript) and the gateway's base URL (which a
 * Markdown image resolves against).
 *
 * A context, not props, because the screen sits three components below `App` and
 * the entry module is the only place that knows both. It is optional on purpose:
 * a screen rendered with none (a test of the shell, a gallery) draws whatever
 * the stores hold and opens nothing, so nothing in `features/` reaches for the
 * controller behind the page's back.
 *
 * The slice of the controller the screen uses is named here, so a test hands in
 * a few functions rather than a gateway.
 */
import { createContext, useContext } from 'react'

import type { ChatController } from '../../core/chat-controller'

/** The controller methods a chat screen calls: opening, paging back and leaving. */
export type ChatScreenController = Pick<
  ChatController,
  'openChat' | 'openSession' | 'openConversation' | 'loadOlder' | 'readKeyFor' | 'closeChat'
>

export interface ChatSessionRuntime {
  controller: ChatScreenController
  /** The gateway's base URL (`ResolvedBasePath.baseUrl`). */
  gatewayBaseUrl: string
}

export const ChatRuntimeContext = createContext<ChatSessionRuntime | null>(null)

/** The page's chat runtime, or `null` where the page has not provided one. */
export function useChatRuntime(): ChatSessionRuntime | null {
  return useContext(ChatRuntimeContext)
}
