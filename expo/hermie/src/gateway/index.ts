export {
  attachLifecycle,
  createGatewayConnection,
  createMemoryTokenStore,
  createSecretTokenStore,
  createTokenCoordinator,
  type CreateConnectionOptions,
  type CreateTokenCoordinatorOptions
} from './client'
export {
  clearCredentials,
  clearGateway,
  CONFIG_KEY,
  type GatewaySetup,
  loadGatewaySetup,
  saveGatewaySetup,
  type SaveGatewaySetupInput,
  SECRET_KEYS,
  type StoredGatewayConfig
} from './config'
export {
  activeGatewayOf,
  addGateway,
  asRegistry,
  defaultGatewayName,
  EMPTY_REGISTRY,
  GATEWAY_REGISTRY_KEY,
  GATEWAY_REGISTRY_VERSION,
  gatewayById,
  gatewayForKey,
  gatewayLabel,
  type GatewayRecord,
  type GatewayRegistry,
  gatewaysInOrder,
  isGatewayId,
  loadGatewayRegistry,
  newGatewayId,
  recordFromConfig,
  reconcileActiveGateway,
  removeGateway,
  renameGateway,
  saveGatewayRegistry,
  setActiveGateway,
  updateGateway
} from './registry'
export { AUTH_TIMELINE_KEY, createPersistentAuthTimeline } from './auth-timeline'
export { describeConnectionError, describeProbeError, describeSignInError, hostOf } from './errors'
export { GatewayProvider, type GatewayContextValue, type GatewayPhase, useGateway } from './GatewayProvider'
export {
  describeGatewayAddress,
  type GatewayAddressParts,
  type GatewayStop,
  type GatewayStopAction,
  type GatewayStopKind,
  gatewayStop,
  type GatewayStopInput,
  RESOLVED_STATUSES
} from './gateway-stop'
export { GatewayStoppedPanel, useGatewayStop } from './GatewayStoppedPanel'
export { describeSignOutReason, useReauth } from './reauth'
export { type ConnectionStoreState, useConnectionStore } from './store'
export { REFRESH_DOCS_URL, RefreshNotice, type RefreshNoticeProps } from './RefreshNotice'
export { TransportNotice, type TransportNoticeProps } from './TransportNotice'
export { chatGatewayFor, type ChatGateway, type RestMessagesOptions } from './link'
