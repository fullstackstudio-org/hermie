// The bot roster: who lives on this gateway, and which of them is busy.
export {
  ACTIVE_LIST_POLL_MS,
  BotsController,
  type BotsControllerOptions,
  CANONICAL_CHAT_TITLE,
  PROFILE_SESSION_LIST_LIMIT,
  SESSION_COLUMNS
} from './bots-controller'
export { BotsScreen, BotsScreenOrSignedOut, type BotsScreenProps, type OpenBotOptions } from './BotsScreen'
export { consumeRevealFolder, onRevealFolder, requestRevealFolder } from './folder-reveal'
export { presenceOf, type Presence, type PresenceInput, type PresenceState } from './presence'
export { ConnectionLine } from './ConnectionLine'
export { GatewayTitle, type GatewayTitleProps } from './GatewayTitle'
export { SidebarFooter, tabs, type BotsSection, type TabKey } from './SidebarFooter'
export { SidebarRail, type SidebarRailProps } from './SidebarRail'
