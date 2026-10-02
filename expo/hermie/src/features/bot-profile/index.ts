// The bot profile editor: one sheet, reached from the chat header and the row menu.
export { AVATAR_EDGE, centreSquare, cropToSquare, pickAvatar, type PickedAvatar } from './avatar'
export {
  AVATAR_ASSET,
  changesFor,
  clearAvatar,
  saveDescription,
  uploadAvatar,
  type BotProfileChanges,
  type BotProfileDraft,
  type BotProfileGatewayOptions
} from './bot-profile-controller'
export { BotProfileSheet, type BotProfileSheetProps } from './BotProfileSheet'
