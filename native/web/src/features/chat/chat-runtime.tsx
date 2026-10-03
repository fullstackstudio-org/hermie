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
import type { DraftStore } from './drafts'

/**
 * The controller methods a chat screen calls: opening, paging back and leaving
 * (the screen), sending, stopping and the queue behind a running turn, slash
 * commands and uploads (the composer), and answering the two request kinds
 * (the request layer, which is over every chat and so is given the same
 * controller). `uploadFile` is for the attachments of W-19; nothing calls it yet.
 */
export type ChatScreenController = Pick<
  ChatController,
  | 'openChat'
  | 'openSession'
  | 'openConversation'
  | 'loadOlder'
  | 'readKeyFor'
  | 'closeChat'
  | 'send'
  | 'stopTurn'
  | 'editQueued'
  | 'deleteQueued'
  | 'steerQueued'
  | 'querySlash'
  | 'runSlash'
  | 'slashRouteFor'
  | 'uploadFile'
  | 'respondApproval'
  | 'respondClarify'
  | 'lockClarify'
  | 'cancelClarify'
  | 'acknowledgeApproval'
  | 'openApprovals'
>

export interface ChatSessionRuntime {
  controller: ChatScreenController
  /** The gateway's base URL (`ResolvedBasePath.baseUrl`). */
  gatewayBaseUrl: string
  /**
   * Where a chat's unsent words are kept between visits. Absent (a test of the
   * screen, a gallery) keeps them for as long as the composer is on screen.
   */
  drafts?: DraftStore
}

export const ChatRuntimeContext = createContext<ChatSessionRuntime | null>(null)

/** The page's chat runtime, or `null` where the page has not provided one. */
export function useChatRuntime(): ChatSessionRuntime | null {
  return useContext(ChatRuntimeContext)
}
