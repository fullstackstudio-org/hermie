// One canonical Bot Chat per bot: hydration, streaming and the actions on it.
export {
  ACTIVITY_TAIL_LIMIT,
  APPROVAL_POLL_MS,
  type AttachmentInput,
  ChatController,
  type ChatControllerOptions,
  type ChatOptionKey,
  DM_DELIVERY_MARKER,
  REST_HISTORY_LIMIT,
  REST_HISTORY_THRESHOLD,
  SESSIONS_CHANGED_DEBOUNCE_MS,
  type SetOptionResult,
  SUBAGENT_RECONCILE_MS,
  TAIL_ROW_LIMIT
} from './chat-controller'
export { ChatRuntimeProvider, type ChatRuntimeValue, useChatRuntime } from './ChatRuntime'
export { ChatScreen, type ChatScreenProps, type OpenChatOptions } from './ChatScreen'
export { useChat, type UseChatResult } from './useChat'
