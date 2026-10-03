export {
  createFakeRelay,
  type FakeRelay,
  type FakeRelayDelivery,
  type FakeRelayFailure,
  type FakeRelayOptions,
  type FakeRelayRequest,
  type FakeRelayResult,
  type FakeRelayStatus
} from './fake-relay'
export { type ConfirmOutcome, type Identity, type PasskeyOptions, type RaiseResult } from './server'
export { PasskeyGateway } from './passkey/gateway'
export { PasskeyStore } from './passkey/store'
export {
  type AssertionInput,
  type ConfirmAnswer,
  type ConfirmFrameParams,
  DECLINE,
  NATIVE_ORIGIN,
  NATIVE_RP_ID,
  type PasskeyAssertion,
  type RegisterBody,
  type RegistrationInput,
  SoftAuthenticator,
  type SoftAuthenticatorOptions,
  type Tampering
} from './testing/soft-authenticator'
export {
  type FakeAccount,
  type FakeAuthMode,
  type FakeGateway,
  type FakeGatewayOptions,
  type FakeGatewayState,
  type FakeSession,
  PLUGIN_ADVERT,
  type Scenario,
  type ScenarioReply,
  startFakeGateway,
  type TranscriptRow
} from './server'
