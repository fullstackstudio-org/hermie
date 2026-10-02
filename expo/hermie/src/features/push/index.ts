/**
 * The pure half of ADR-0017, which is most of it.
 *
 * `platform.ts` and `NotificationsSection.tsx` are deliberately NOT re-exported
 * here: importing this barrel would then pull `expo-notifications` and React
 * into every caller, including the tests whose whole point is that the decisions
 * can be checked without either. The two places that need the real platform
 * import it by name.
 */
export { allowChoiceOf, denyChoiceOf, pushTapOf, resolvePushTap, wantsActions } from './actions'
export type { OpenApproval, PushIntent, PushTap } from './actions'
export {
  PUSH_ACTION_ALLOW,
  PUSH_ACTION_DENY,
  PUSH_CHANNEL_DEFAULT,
  PUSH_CHANNEL_NEEDS_INPUT,
  PUSH_REQUEST_CATEGORY,
  PUSH_TYPES_WITH_ACTIONS,
  pushDataOf,
  pushFailureMessageOf,
  type PushAddressFailure,
  type PushAddressRequest,
  type PushAddressResult,
  type PushPayloadData,
  type PushPermission,
  type PushPlatform,
  type PushResponse
} from './platform-contract'
export {
  PUSH_ADDRESS_TAIL,
  pushAddressTail,
  pushRegistrationState,
  pushRetryable,
  type PushRegistrationState,
  type PushStatusInput
} from './status'
export {
  PUSH_ADDRESS_METHOD,
  PUSH_HEARTBEAT_MS,
  pushFailureEntry,
  PushSync,
  type PushEnableOutcome,
  type PushSyncOptions,
  type PushSyncPorts
} from './push-sync'
export { retirePushRegistration, setPushRetire } from './runtime'
