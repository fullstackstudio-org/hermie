/**
 * Per-user chats beside the shared Bot Chat (ADR-0007, amended 2026-09-22).
 *
 * `user-chat.ts` holds the rules, `user-chat-directory.ts` the state,
 * `user-chat-switch.ts` the object the chat controller takes, and
 * `ChatChoiceRow.tsx` the one control both surfaces draw.
 */
export { ChatChoiceRow, type ChatChoiceRowProps } from './ChatChoiceRow'
export {
  canHaveUserChat,
  isUserChatTitle,
  lookupUserChat,
  resolveUserChat,
  USER_CHAT_TITLE_LEAD,
  USER_CHAT_TITLE_MAX,
  USER_CHAT_TITLE_PREFIX,
  userChatTitle,
  type ChatChoice,
  type ChatIdentity,
  type ResolveUserChatInput
} from './user-chat'
export { UserChatDirectory, type UserChatDirectoryOptions } from './user-chat-directory'
export { userChatSwitch, type UserChatSwitch, type UserChatSwitchParts } from './user-chat-switch'
