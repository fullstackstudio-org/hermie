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

import type { PictureFetchOutcome, SessionSearchHttp } from '@hermie/gateway-client'

import type { BotProfilesRuntime } from '../../core/bot-profile/runtime'
import type { ChatController } from '../../core/chat-controller'
import type { PeoplePictures } from '../../core/people-pictures'
import type { DraftStore } from './drafts'

/**
 * The controller methods a chat screen calls: opening, paging back and leaving
 * (the screen), sending, stopping and the queue behind a running turn, slash
 * commands and uploads (the composer), and answering the two request kinds
 * (the request layer, which is over every chat and so is given the same
 * controller), and a bot's other conversations (`features/sessions`: list,
 * rename, delete, make one the Bot Chat, start a new one, branch the chat at a message). `uploadFile` is the
 * attachment tray's (`use-attachment-tray.ts`), and the Activity timeline's are `loadActivity` (every bot's recent
 * tail into the chat store) and the two counters (`features/activity`).
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
  | 'uploadFileTo'
  | 'respondApproval'
  | 'respondClarify'
  | 'lockClarify'
  | 'cancelClarify'
  | 'acknowledgeApproval'
  | 'openApprovals'
  | 'listConversations'
  | 'onConversationsChanged'
  | 'renameConversation'
  | 'deleteConversation'
  | 'adoptAsCanonical'
  | 'startNewConversation'
  | 'branchFrom'
  | 'setOption'
  | 'refreshOptions'
  | 'modelOptions'
  | 'refreshUsage'
  | 'loadActivity'
  | 'activeSubagentCount'
  | 'inFlightDeliveries'
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
  /**
   * The gateway's REST client, for the search over every bot's transcripts
   * (`GET /api/sessions/search`, `features/search`). Absent (a test of the
   * screen, a gallery) searches names only.
   */
  sessionSearch?: SessionSearchHttp
  /**
   * The gateway's authenticated file fetch (`GatewayHttp.fetchAuthenticatedPicture`), which brings back what a
   * message's attachment names (`core/chats/attachment-fetch.ts`). Absent (a test of the screen, a gallery)
   * leaves a file chip under a message as a name, not a control.
   */
  fetchPicture?: (path: string) => Promise<PictureFetchOutcome>
  /**
   * The people's pictures on this gateway (`core/people-pictures.ts`). Absent (a test of the screen,
   * a gallery) draws everybody as an initial.
   */
  pictures?: PeoplePictures
  /**
   * What the bot profile page reads and writes through (`features/profile`). Absent (a test of the screen,
   * a gallery) leaves the profile page with nothing but the name and colour, which are the reader's own.
   */
  profiles?: BotProfilesRuntime
}

export const ChatRuntimeContext = createContext<ChatSessionRuntime | null>(null)

/** The page's chat runtime, or `null` where the page has not provided one. */
export function useChatRuntime(): ChatSessionRuntime | null {
  return useContext(ChatRuntimeContext)
}
