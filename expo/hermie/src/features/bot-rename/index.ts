// Naming a bot: the app's own display name, and core's PATCH route behind the
// separate act of renaming the profile itself.
export { BotNameFields, type BotNameFieldsProps } from './BotNameFields'
export {
  asDisplayNameError,
  DISPLAY_NAME_ROUTE,
  DisplayNameError,
  type DisplayNameHome,
  patchDisplayName,
  PROFILE_DISPLAY_NAME_MAX,
  saveDisplayName,
  type SaveDisplayNameOptions,
  type SaveDisplayNameResult
} from './display-name-controller'
export { renameBot, type RenameBotResult } from './rename-bot'
export {
  asRenameError,
  PROFILE_NAME_MAX,
  type ProfileRenameAnswer,
  ProfileRenameError,
  renameProfile
} from './rename-controller'
export { botNameChanged, saveBotName, type SaveBotNameOptions, type SaveBotNameResult } from './save-bot-name'
export { renameStrings } from './strings'
export { useDisplayNameHome } from './useDisplayNameHome'
