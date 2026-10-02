export { gatewayKeyOf, isGatewayKey } from './gateway-key'
export {
  AUTH_TIMELINE_SIZE,
  type AuthEvent,
  type AuthEventRecorder,
  type AuthEventInput,
  type AuthEventName,
  AuthTimeline,
  type AuthTimelineOptions,
  type AuthTimelineSink,
  type AuthTimelineSnapshot,
  NULL_AUTH_TIMELINE,
  type SignOutReason
} from './auth-timeline'
export {
  assertDesktopContract,
  DEFAULT_RPC_TIMEOUT_MS,
  FIRST_SESSION_TIMEOUT_MS,
  GatewayConnection,
  type GatewayConnectionOptions,
  MIN_DESKTOP_CONTRACT,
  PROMPT_SUBMIT_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  RECONNECT_CAP_MS,
  rpcTimeoutMs,
  type StatusHandler
} from './connection'
export {
  type AuthHeaderOptions,
  bearerFrom,
  CookieSessionCredentials,
  type CookieSessionCredentialsOptions,
  type CredentialProvider,
  GATEWAY_WS_PROTOCOL,
  GATEWAY_WS_TICKET_PREFIX,
  mintWsTicket,
  type MintWsTicketOptions,
  NativePkceCredentials,
  type NativePkceCredentialsOptions,
  SESSION_TOKEN_HEADER,
  SessionTokenCredentials,
  type SessionTokenCredentialsOptions
} from './credentials'
export {
  accessUserScript,
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET,
  CF_ACCESS_INCOMPLETE,
  CF_ACCESS_PRESENT,
  type CloudflareAccessFrontDoor,
  describeFrontDoor,
  type FrontDoor,
  type FrontDoorKind,
  frontDoorHeaders,
  frontDoorWithheld,
  isFrontDoorComplete,
  NO_FRONT_DOOR,
  originOf,
  REDACTED,
  redactHeaders
} from './front-door'
export {
  DEFAULT_HTTP_TIMEOUT_MS,
  type FetchLike,
  looksLikeCertificateFailure,
  looksLikeTlsFailure,
  parseJsonBody,
  parseJsonObject,
  redirectError,
  redirectSeen,
  REFUSED_LOCATION_HEADER,
  requestText
} from './fetch-json'
export {
  classifyHost,
  type HostClassification,
  type HostPrivacy,
  hostOfAddress,
  isExposedCleartext
} from './host-privacy'
export {
  type AuthIdentity,
  DEFAULT_REST_TIMEOUT_MS,
  GatewayHttp,
  type GatewayHttpOptions,
  type PictureFetchOutcome,
  type RequestOptions,
  type WsTicket
} from './http'
export { authorIdOf, ownAuthorOf } from './author-id'
export { bytesToBase64 } from './base64'
export {
  AuthChangedError,
  type AccessTokenOptions,
  exchangeCode,
  type NativeAuthOptions,
  REFRESH_SKEW_SECONDS,
  refreshTokens,
  TokenCoordinator,
  type TokenCoordinatorOptions,
  type TokenSet,
  type TokenStore,
  tokenNeedsRefresh
} from './native-auth'
export {
  type AuthorizeParams,
  base64url,
  buildAuthorizeUrl,
  createPkce,
  isLoopbackRedirect,
  isLoopbackUrl,
  type LoopbackRedirect,
  parseLoopbackRedirect,
  type Pkce,
  type RandomBytes,
  REDIRECT_URI
} from './pkce'
export {
  classifyProbeFailure,
  type NetworkKind,
  type ProbeAction,
  type ProbeHintCode,
  type ProbeVerdict,
  type ProbeVerdictOptions
} from './probe-hints'
export {
  type AuthProvider,
  NATIVE_PKCE_FLOW,
  PROBE_TIMEOUT_MS,
  probeGateway,
  type ProbeResult,
  resolveGatewayAddress,
  type ResolvedAddress
} from './probe'
export {
  parseSessionSearch,
  plainSnippet,
  searchSessions,
  SESSION_SEARCH_LIMIT_CAP,
  type SessionSearchHit,
  type SessionSearchHttp,
  type SessionSearchOptions,
  sessionSearchHitOf,
  SNIPPET_MATCH_CLOSE,
  SNIPPET_MATCH_OPEN,
  type SnippetSegment,
  snippetSegments,
  tidySnippet
} from './session-search'
export { DialPlanSocketFactory, type SocketCloseInfo, type WebSocketConstructorLike } from './socket-factory'
export {
  asGatewayError,
  type ConnectionStatus,
  type DialPlan,
  type GatewayAuthMode,
  type GatewayConfig,
  GatewayError,
  type GatewayErrorKind,
  type GatewayErrorOptions,
  isGatewayError
} from './types'
export {
  appKeyFor,
  BOT_MARKER_KEY,
  HERMIE_APP_KEY,
  HERMIE_APP_SECTION_VERSION,
  HERMIE_KEY,
  HERMIE_SECTION_VERSION,
  type HermieAppSection,
  type HermieBotSection,
  inheritedFromLegacy,
  readSection,
  UiMetaSync,
  type UiMetaGateway,
  type UiMetaMode,
  type UiMetaSnapshot,
  type UiMetaSyncOptions
} from './ui-meta'
export {
  apiUrl,
  AUTH_PICTURE_PATH,
  authPicturePath,
  BLOCKED_HEADER_NAMES,
  GATEWAY_WS_PATH,
  hasExplicitScheme,
  isBlockedHeaderName,
  normalizeBaseUrl,
  normalizeHeader,
  normalizeHeaders,
  wsUrlFor
} from './url'
