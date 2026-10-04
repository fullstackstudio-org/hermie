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
// What a client's tests hold their answers and files to: the gateway's own check of an interactive answer
// (`contract/requests`, every refusal reason of section 3 and sections 8 to 12) and of a signature's two files.
export { refusalFor } from './interactive'
export { pngOrSvgProblem, svgProblemWord } from './signature-svg'
export { type ConfirmOutcome, type Identity, type PasskeyOptions, type RaiseResult } from './server'
export { type McpOptions } from './server'
export { McpGateway, McpStore, type McpGrant, type McpGrantInput } from './mcp/store'
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
